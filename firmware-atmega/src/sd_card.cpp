#include "sd_card.h"
#include "uart_link.h"
#include <avr/io.h>
#include <util/delay.h>

namespace dental_atmega { namespace storage {
namespace {
constexpr uint8_t kBlockAddressed = 0x04U;
}

using namespace dental_link::storage::diagnostic;

void RawCard::select(bool enabled) {
  if (enabled) PORTB &= static_cast<uint8_t>(~_BV(hardware::kMicroSdChipSelectBit));
  else PORTB |= _BV(hardware::kMicroSdChipSelectBit);
}
uint8_t RawCard::transfer(uint8_t value) {
  SPDR = value; while ((SPSR & _BV(SPIF)) == 0U) {} return SPDR;
}
void RawCard::deselect() {
  select(false);
  transfer(0xFFU);
  transfer_ = Transfer::kIdle;
  if (traceStage_ == 1U || traceStage_ == 3U)
    readTrace_.attempts[traceStage_ == 1U ? 0U : 1U].flags |=
        ReadTrace::kCsRaised | ReadTrace::kTrailingClock;
  else if (traceStage_ == 2U)
    readTrace_.retryFlags |= ReadTrace::kRetryCsRaised | ReadTrace::kRetryTrailingClock;
}
bool RawCard::waitReady(uint8_t* lastByte) {
  for (uint16_t count = 0U; count < 65000U; ++count) {
    const uint8_t received = transfer(0xFFU);
    if (lastByte) *lastByte = received;
    if (received == 0xFFU) return true;
  }
  return false;
}
uint8_t RawCard::command(uint8_t value, uint32_t argument) {
  lastCommandTrace_ = kCmd0ReadyWaitSkipped;
  spi_config::CommandObservation* observation = nullptr;
  if (value == 17U && (traceStage_ == 1U || traceStage_ == 3U))
    observation = &readTrace_.attempts[traceStage_ == 1U ? 0U : 1U].command;
  const uint8_t response = spi_config::commandTransaction(
      value, argument,
      [this](bool high) { select(!high); },
      [this](uint8_t byte) { return transfer(byte); }, observation);
  lastCommandTrace_ |= kCommandPacketSent;
  if (response == 0xFFU) lastCommandTrace_ |= kCommandResponseTimedOut;
  return response;
}
bool RawCard::initialize() {
  // Driver-owned READY is the only idempotency shortcut. Do not reset or probe
  // a card that this boot has already initialized successfully.
  if (state_ == State::kReady) return true;

  // SD:STATUS can arrive almost immediately after the RTC handshake. Keep the
  // golden standalone card power-up interval without delaying RTC/USART boot
  // or changing the CMD0 SPI transaction. Timer0 and UART interrupts run here.
  powerUpSettle_.beforeFirstInitialization(
      []() { return dental_atmega::uart::milliseconds(); },
      []() { _delay_ms(1.0); });

  memset(diagnostic_.bytes, 0, sizeof(diagnostic_.bytes));
  diagnostic_.bytes[kVersion] = 3U;
  diagnostic_.bytes[kCmd0] = diagnostic_.bytes[kCmd8] =
      diagnostic_.bytes[kAcmd41] = diagnostic_.bytes[kCmd58] =
      diagnostic_.bytes[kCmd16] = diagnostic_.bytes[kReadR1] =
      diagnostic_.bytes[kReadToken] = 0xFFU;
  diagnostic_.bytes[kCmd0FirstR1] = diagnostic_.bytes[kCmd0LastR1] = 0xFFU;
  diagnostic_.bytes[kStage] = 1U;
  DDRB = spi_config::configuredDdrb(DDRB);
  PORTB = spi_config::configuredPortb(PORTB);
  SPCR = spi_config::kSpcr; SPSR = 0U;
  diagnostic_.bytes[kFlags] |= kSpiConfigured;
  select(false);
  transfer_ = Transfer::kIdle;
  if ((PORTB & _BV(hardware::kMicroSdChipSelectBit)) != 0U)
    diagnostic_.bytes[kFlags] |= kChipSelectHigh;
  // One-shot register snapshot immediately before the physically proven
  // initialization sequence. Reading these registers cannot change CS, SPI,
  // or parser state.
  diagnostic_.bytes[kDdrb] = DDRB;
  diagnostic_.bytes[kPortb] = PORTB;
  diagnostic_.bytes[kSpcr] = SPCR;
  diagnostic_.bytes[kSpsr] = SPSR;
  diagnostic_.bytes[kStage] = 2U;
  uint8_t type = 0U;
  const uint32_t resetStarted = dental_atmega::uart::milliseconds();
  spi_config::sendStartupClocks(
      [this](bool high) { select(!high); },
      [this](uint8_t value) { return transfer(value); });
  diagnostic_.bytes[kFlags] |= kStartupClocksSent;
  uint8_t cmd0Attempts = 0U;
  uint8_t cmd0First = 0xFFU;
  const uint8_t cmd0 = spi_config::enterIdle(
      [this](uint8_t command, uint32_t argument) {
        return this->command(command, argument);
      },
      [this]() { deselect(); },
      [](uint16_t) { _delay_ms(100.0); }, cmd0Attempts, &cmd0First);
  diagnostic_.bytes[kCmd0AttemptCount] = cmd0Attempts;
  diagnostic_.bytes[kCmd0FirstR1] = cmd0First;
  diagnostic_.bytes[kCmd0LastR1] = cmd0;
  diagnostic_.bytes[kCmd0] = cmd0;
  diagnostic_.bytes[kCmd0Trace] = lastCommandTrace_;
  const uint16_t cmd0Elapsed = static_cast<uint16_t>(
      dental_atmega::uart::milliseconds() - resetStarted);
  diagnostic_.bytes[kCmd0ElapsedHigh] = static_cast<uint8_t>(cmd0Elapsed >> 8U);
  diagnostic_.bytes[kCmd0ElapsedLow] = static_cast<uint8_t>(cmd0Elapsed);
  diagnostic_.bytes[kStage] = 3U;
  if (cmd0 == 0xFFU) diagnostic_.bytes[kFlags] |= kCmd0TimedOut;
  if (spi_config::cmd0EnteredIdle(cmd0)) {
    const uint8_t cmd8 = command(8U, 0x1AAU);
    diagnostic_.bytes[kCmd8] = cmd8;
    diagnostic_.bytes[kStage] = 4U;
    if (cmd8 == 0xFFU) diagnostic_.bytes[kFlags] |= kCmd8TimedOut;
    if (cmd8 == 1U) {
      uint8_t r7[4];
      for (uint8_t index = 0U; index < 4U; ++index) {
        r7[index] = transfer(0xFFU);
        diagnostic_.bytes[kR7 + index] = r7[index];
      }
      deselect();
      if (r7[2] == 1U && r7[3] == 0xAAU) {
        diagnostic_.bytes[kMoreFlags] |= kSdV2;
        uint16_t attemptsUsed = 0U;
        bool initialized = false;
        while (attemptsUsed < spi_config::kAcmd41MaximumAttempts) {
          ++attemptsUsed;
          const uint8_t cmd55 = command(55U, 0U);
          deselect();
          if (cmd55 > 1U) {
            diagnostic_.bytes[kAcmd41] = cmd55;
            break;
          }
          const uint8_t response = command(41U, 1UL << 30U);
          deselect();
          diagnostic_.bytes[kAcmd41] = response;
          if (response == 0U) {
            initialized = true;
            break;
          }
          _delay_ms(10.0);
        }
        diagnostic_.bytes[kAcmd41AttemptsHigh] = static_cast<uint8_t>(attemptsUsed >> 8U);
        diagnostic_.bytes[kAcmd41AttemptsLow] = static_cast<uint8_t>(attemptsUsed);
        diagnostic_.bytes[kStage] = 5U;
        if (!initialized) diagnostic_.bytes[kFlags] |= kAcmd41TimedOut;
        if (initialized) {
          const uint8_t cmd58 = command(58U, 0U);
          diagnostic_.bytes[kCmd58] = cmd58;
          diagnostic_.bytes[kStage] = 6U;
          if (cmd58 == 0xFFU) diagnostic_.bytes[kFlags] |= kCmd58TimedOut;
          if (cmd58 == 0U) {
            for (uint8_t index = 0U; index < 4U; ++index)
              diagnostic_.bytes[kOcr + index] = transfer(0xFFU);
            const bool blockAddressed = spi_config::blockAddressed(
                &diagnostic_.bytes[kOcr]);
            type = blockAddressed ? kBlockAddressed : 0x02U;
            if (blockAddressed)
              diagnostic_.bytes[kMoreFlags] |= kBlockAddressing;
          }
          deselect();
        }
      }
    } else {
      deselect();
    }
  }
  if (type == 0x02U) {
    diagnostic_.bytes[kMoreFlags] |= kCmd16Issued;
    const uint8_t cmd16 = command(16U, 512UL);
    diagnostic_.bytes[kCmd16] = cmd16;
    diagnostic_.bytes[kStage] = 7U;
    if (cmd16 == 0xFFU) diagnostic_.bytes[kFlags] |= kCmd16TimedOut;
    if (cmd16 != 0U) type = 0U;
  }
  deselect();
  diagnostic_.bytes[kCardType] = type;
  if (type == 0U) { state_ = State::kUnavailable; return false; }
  cardType_ = type; state_ = State::kReady;
  diagnostic_.bytes[kMoreFlags] |= kInitializationSucceeded;
  diagnostic_.bytes[kStage] = 8U;
  return true;
}
bool RawCard::sync() {
  if (state_ != State::kReady || transfer_ != Transfer::kIdle) return false;
  select(true); const bool ready = waitReady(); deselect();
  if (!ready) state_ = State::kIoError;
  return ready;
}
ReadAttempt RawCard::beginReadAttempt(uint32_t sector) {
  const uint32_t address = (cardType_ & kBlockAddressed) ? sector : sector * 512UL;
  readTrace_.argument = address;
  ReadTrace::Attempt& attempt = readTrace_.attempts[traceStage_ == 1U ? 0U : 1U];
  attempt.flags |= ReadTrace::kAttempted;
  const uint8_t response = command(17U, address);
  if (response != 0U) {
    if (response == 0xFFU) attempt.flags |= ReadTrace::kR1Timeout;
    const ReadAttempt result = classifyReadAttempt(response, 0xFFU);
    deselect();
    position_ = 0U;
    return result;
  }
  uint8_t token = 0xFFU;
  for (uint16_t count = 0U; count < 65000U && token == 0xFFU; ++count) token = transfer(0xFFU);
  attempt.token = token;
  if (token == 0xFFU) attempt.flags |= ReadTrace::kTokenTimeout;
  if (token == 0xFEU) attempt.flags |= ReadTrace::kTokenAccepted;
  const ReadAttempt result = classifyReadAttempt(response, token);
  if (!result.success) {
    deselect();
    position_ = 0U;
    return result;
  }
  transfer_ = Transfer::kRead;
  position_ = 0U;
  return result;
}
bool RawCard::recoverRead() {
  // beginReadAttempt() has already deselected the failed transaction and
  // supplied its trailing clock. Add recovery clocks while CS remains high,
  // then perform the existing bounded readiness check before the retry.
  // Interrupts remain enabled throughout.
  transfer(0xFFU);
  select(true);
  const bool ready = waitReady(&readTrace_.retryReadyByte);
  deselect();
  readTrace_.retryFlags |= ReadTrace::kRetryHighClock | ReadTrace::kRetrySelected;
  if (ready) readTrace_.retryFlags |= ReadTrace::kRetryReady;
  return ready;
}
void RawCard::recordRead(uint32_t sector, const ReadOperation& operation) {
  diagnostic_.bytes[kMoreFlags] &= static_cast<uint8_t>(
      ~(kRuntimeReadReady | kRuntimeReadRetried | kRuntimeReadTransferBusy));
  if (state_ == State::kReady) diagnostic_.bytes[kMoreFlags] |= kRuntimeReadReady;
  if (operation.attempts == 2U) diagnostic_.bytes[kMoreFlags] |= kRuntimeReadRetried;
  if (operation.diagnostic.reason == ReadFailureReason::kTransferState)
    diagnostic_.bytes[kMoreFlags] |= kRuntimeReadTransferBusy;
  diagnostic_.bytes[kStage] = 9U;
  diagnostic_.bytes[kReadR1] = operation.diagnostic.r1;
  diagnostic_.bytes[kReadToken] = operation.diagnostic.token;
  uint8_t flags = kReadAttempted |
      (sector == 0UL ? kReadWasSectorZero : 0U) |
      readFailureBits(operation.diagnostic.reason);
  if (operation.success) flags |= kReadSucceeded;
  if (operation.diagnostic.reason == ReadFailureReason::kCmd17R1 &&
      operation.diagnostic.r1 == 0xFFU)
    flags |= kReadR1TimedOut;
  if (operation.diagnostic.reason == ReadFailureReason::kDataTokenTimeout)
    flags |= kReadTokenTimedOut;
  diagnostic_.bytes[kReadFlags] = flags;
}
bool RawCard::beginRead(uint32_t sector) {
  ReadOperation operation;
  readTrace_.start(sector, (cardType_ & kBlockAddressed) != 0U);
  if (state_ != State::kReady) {
    operation.attempts = 1U;
    operation.diagnostic = ReadAttempt(false, ReadFailureReason::kNotReady);
  } else if (transfer_ != Transfer::kIdle) {
    operation.attempts = 1U;
    operation.diagnostic = ReadAttempt(false, ReadFailureReason::kTransferState);
  } else {
    uint8_t attemptNumber = 0U;
    operation = readWithOneRetry(
        sector,
        [this, &attemptNumber](uint32_t requested) {
          traceStage_ = ++attemptNumber == 1U ? 1U : 3U;
          return beginReadAttempt(requested);
        },
        [this]() { traceStage_ = 2U; return recoverRead(); });
    traceStage_ = 0U;
  }
  readTrace_.finish(!operation.success, operation.diagnostic.reason);
  recordRead(sector, operation);
  if (operation.success) return true;
  if (readFailureInvalidatesCard(operation)) fail();
  return false;
}
bool RawCard::readChunk(uint8_t* data, uint8_t capacity, uint8_t& length, bool& complete) {
  length = 0U; complete = false;
  if (transfer_ != Transfer::kRead || !data || capacity == 0U) return false;
  const uint16_t remaining = static_cast<uint16_t>(512U - position_);
  length = static_cast<uint8_t>(remaining < capacity ? remaining : capacity);
  for (uint8_t index = 0U; index < length; ++index) data[index] = transfer(0xFFU);
  position_ = static_cast<uint16_t>(position_ + length);
  if (position_ == 512U) { transfer(0xFFU); transfer(0xFFU); deselect(); complete = true; }
  return true;
}
bool RawCard::beginWrite(uint32_t sector) {
  if (state_ != State::kReady || transfer_ != Transfer::kIdle) return false;
  const uint32_t address = (cardType_ & kBlockAddressed) ? sector : sector * 512UL;
  if (command(24U, address) != 0U || !waitReady()) { fail(); return false; }
  transfer(0xFEU); transfer_ = Transfer::kWrite; position_ = 0U; return true;
}
bool RawCard::writeChunk(const uint8_t* data, uint8_t length, bool& complete) {
  complete = false;
  if (transfer_ != Transfer::kWrite || !data || length == 0U ||
      position_ + length > 512U) { fail(); return false; }
  for (uint8_t index = 0U; index < length; ++index) transfer(data[index]);
  position_ = static_cast<uint16_t>(position_ + length);
  if (position_ == 512U) {
    transfer(0xFFU); transfer(0xFFU);
    const bool accepted = (transfer(0xFFU) & 0x1FU) == 0x05U && waitReady();
    deselect(); complete = true;
    if (!accepted) { state_ = State::kIoError; return false; }
  }
  return true;
}
void RawCard::abort() {
  if (transfer_ != Transfer::kIdle) deselect();
  position_ = 0U;
}
void RawCard::fail() { deselect(); position_ = 0U; state_ = State::kIoError; }

} }
