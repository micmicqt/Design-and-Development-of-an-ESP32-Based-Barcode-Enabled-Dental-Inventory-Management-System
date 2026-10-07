#include "sd_spi_config.h"
#include "status_encoding.h"

#include <assert.h>
#include <stdio.h>

using namespace dental_atmega;

namespace {

enum class EventKind : uint8_t { kChipSelect, kTransfer };
struct Event { EventKind kind; uint8_t value; };

struct CommandFixture {
  Event events[64] = {};
  uint8_t eventCount = 0U;
  uint8_t responses[32] = {};
  uint8_t responseCount = 0U;
  uint8_t responseIndex = 0U;
  uint8_t selectedTransfers = 0U;
  bool chipSelectHigh = true;
  uint8_t selectedResponse = 0xFFU;

  CommandFixture() {
    for (uint8_t index = 0U; index < sizeof(responses); ++index)
      responses[index] = 0xFFU;
  }
  void setChipSelectHigh(bool high) {
    chipSelectHigh = high;
    events[eventCount++] = {EventKind::kChipSelect,
                            static_cast<uint8_t>(high ? 1U : 0U)};
    if (!high) selectedTransfers = 0U;
  }
  uint8_t exchange(uint8_t value) {
    events[eventCount++] = {EventKind::kTransfer, value};
    // One selected 0xFF pre-command byte plus the six-byte packet precedes R1.
    if (chipSelectHigh) return 0xFFU;
    if (selectedTransfers++ == 0U) return selectedResponse;
    if (selectedTransfers <= 7U) return 0xFFU;
    return responseIndex < responseCount ? responses[responseIndex++] : 0xFFU;
  }
};

uint8_t runInitializationCommand(CommandFixture& fixture, uint8_t command,
                                 uint32_t argument) {
  return storage::spi_config::commandTransaction(
      command, argument,
      [&fixture](bool high) { fixture.setChipSelectHigh(high); },
      [&fixture](uint8_t value) { return fixture.exchange(value); });
}

void deselect(CommandFixture& fixture) {
  fixture.setChipSelectHigh(true);
  fixture.exchange(0xFFU);
}

}

int main() {
  using namespace storage::spi_config;

  // Only the remaining part of the standalone test's 500 ms startup delay is
  // spent on the first physical initialization. Retries never wait again.
  assert(kPowerUpSettleMs == 500U);
  PowerUpSettle early;
  uint32_t earlyMs = 0U;
  uint16_t earlyPauses = 0U;
  early.beforeFirstInitialization([&earlyMs]() { return earlyMs; },
                                  [&]() { ++earlyMs; ++earlyPauses; });
  assert(earlyMs == 500U && earlyPauses == 500U);
  earlyMs = 0U;
  early.beforeFirstInitialization([&earlyMs]() { return earlyMs; },
                                  [&]() { ++earlyMs; ++earlyPauses; });
  assert(earlyPauses == 500U); // Even a failed first attempt consumes the guard.

  PowerUpSettle partial;
  uint32_t partialMs = 275U;
  uint16_t partialPauses = 0U;
  partial.beforeFirstInitialization([&partialMs]() { return partialMs; },
                                    [&]() { ++partialMs; ++partialPauses; });
  assert(partialMs == 500U && partialPauses == 225U);

  PowerUpSettle late;
  uint32_t lateMs = 600U;
  uint16_t latePauses = 0U;
  late.beforeFirstInitialization([&lateMs]() { return lateMs; },
                                 [&]() { ++latePauses; });
  assert(latePauses == 0U);

  // PB2/PB3/PB5 are outputs, PB4 is input; pre-existing PB0/PB1 status
  // directions survive SD setup.
  const uint8_t ddr = configuredDdrb(0xD3U);
  assert((ddr & hardware::kMicroSdOutputMask) == hardware::kMicroSdOutputMask);
  assert((ddr & (1U << hardware::kMicroSdMisoBit)) == 0U);
  assert((ddr & hardware::kBigMask) == (0xD3U & hardware::kBigMask));

  // Start with PB4 set to prove SD setup actively disables the MISO pull-up.
  const uint8_t port = configuredPortb(0x13U);
  assert((port & (1U << hardware::kMicroSdChipSelectBit)) != 0U);
  assert((port & (1U << hardware::kMicroSdMisoBit)) == 0U);
  assert((port & hardware::kBigMask) == 0x03U);
  assert((port & static_cast<uint8_t>(~(
      (1U << hardware::kMicroSdChipSelectBit) |
      (1U << hardware::kMicroSdMisoBit)))) ==
      (0x13U & static_cast<uint8_t>(~(
          (1U << hardware::kMicroSdChipSelectBit) |
          (1U << hardware::kMicroSdMisoBit)))));
  for (uint8_t value = 0U; value != 0xFFU; ++value) {
    const uint8_t changed = replaceOwnedBits(value, hardware::kBigMask, 0U);
    assert((changed & hardware::kMicroSdOutputMask) ==
           (value & hardware::kMicroSdOutputMask));
  }

  assert((kSpcr & (1U << kSpcrSpe)) != 0U);
  assert((kSpcr & (1U << kSpcrMstr)) != 0U);
  assert((kSpcr & (1U << kSpcrDord)) == 0U);
  assert((kSpcr & (1U << kSpcrCpol)) == 0U);
  assert((kSpcr & (1U << kSpcrCpha)) == 0U);
  assert((kSpcr & 0x03U) == 0x03U);
  assert(kSdSpiClockHz == 125000UL);
  assert(kStartupClockBytes * 8U >= 74U);
  assert(kResponsePollBytes == 20U);
  assert(kCmd0MaximumAttempts == 20U && kCmd0RetryDelayMs == 100U);
  assert(kAcmd41MaximumAttempts == 300U && kAcmd41RetryDelayMs == 10U);

  uint8_t packet[6] = {};
  commandPacket(0U, 0U, packet);
  const uint8_t expectedCmd0[6] = {0x40U, 0U, 0U, 0U, 0U, 0x95U};
  for (uint8_t index = 0U; index < 6U; ++index)
    assert(packet[index] == expectedCmd0[index]);
  commandPacket(8U, 0x1AAU, packet);
  const uint8_t expectedCmd8[6] = {0x48U, 0U, 0U, 0x01U, 0xAAU, 0x87U};
  for (uint8_t index = 0U; index < 6U; ++index)
    assert(packet[index] == expectedCmd8[index]);
  assert(isR1Response(0x01U));
  assert(isR1Response(0x00U));
  assert(!isR1Response(0xFFU));
  assert(!isR1Response(0x80U));

  assert(cmd0EnteredIdle(0x01U));
  assert(!cmd0EnteredIdle(0x00U));
  assert(!cmd0EnteredIdle(0xFFU));
  const uint8_t sdhcOcr[4] = {0xC0U, 0xFFU, 0x80U, 0x00U};
  assert(blockAddressed(sdhcOcr));

  // Event-for-event model of the physically proven startup and CMD0
  // transaction, including the selected 0xFF byte before the command packet.
  CommandFixture exact;
  exact.responses[0] = 0x01U;
  exact.responseCount = 1U;
  sendStartupClocks(
      [&exact](bool high) { exact.setChipSelectHigh(high); },
      [&exact](uint8_t value) { return exact.exchange(value); });
  assert(runInitializationCommand(exact, 0U, 0U) == 0x01U);
  deselect(exact);
  uint8_t event = 0U;
  assert(exact.events[event].kind == EventKind::kChipSelect &&
         exact.events[event++].value == 1U);
  for (uint8_t index = 0U; index < kStartupClockBytes; ++index) {
    assert(exact.events[event].kind == EventKind::kTransfer &&
           exact.events[event++].value == 0xFFU);
  }
  assert(exact.events[event].kind == EventKind::kChipSelect &&
         exact.events[event++].value == 0U);
  assert(exact.events[event].kind == EventKind::kTransfer &&
         exact.events[event++].value == 0xFFU);
  for (uint8_t index = 0U; index < sizeof(expectedCmd0); ++index) {
    assert(exact.events[event].kind == EventKind::kTransfer &&
           exact.events[event++].value == expectedCmd0[index]);
  }
  assert(exact.events[event].kind == EventKind::kTransfer &&
         exact.events[event++].value == 0xFFU);
  assert(exact.events[event].kind == EventKind::kChipSelect &&
         exact.events[event++].value == 1U);
  assert(exact.events[event].kind == EventKind::kTransfer &&
         exact.events[event++].value == 0xFFU);
  assert(event == exact.eventCount);

  // The bounded reader stops at the first non-0xFF byte. A 0x00 is observed
  // but can never satisfy the required CMD0 idle response.
  CommandFixture zero;
  zero.responses[0] = 0x00U;
  zero.responseCount = 1U;
  assert(runInitializationCommand(zero, 0U, 0U) == 0x00U);
  assert(!cmd0EnteredIdle(0x00U));

  // The 20-byte initialization response window accepts the first R1-shaped
  // byte and times out after exactly 20 fill bytes.
  CommandFixture delayed;
  delayed.responses[0] = 0xFFU;
  delayed.responses[1] = 0xFFU;
  delayed.responses[2] = 0x01U;
  delayed.responseCount = 3U;
  assert(runInitializationCommand(delayed, 0U, 0U) == 0x01U &&
         delayed.responseIndex == 3U);

  CommandFixture timeout;
  assert(runInitializationCommand(timeout, 0U, 0U) == 0xFFU);
  assert(timeout.selectedTransfers == 27U); // Pre-byte + packet + 20 polls.

  CommandFixture observed;
  observed.selectedResponse = 0xA5U;
  observed.responses[0] = 0xFFU;
  observed.responses[1] = 0xFEU;
  observed.responses[2] = 0x3FU;
  observed.responseCount = 3U;
  CommandObservation observation;
  assert(commandTransaction(17U, 0x00008800UL,
      [&observed](bool high) { observed.setChipSelectHigh(high); },
      [&observed](uint8_t value) { return observed.exchange(value); },
      &observation) == 0x3FU);
  assert(observation.selectedByte == 0xA5U &&
         observation.pollIndex == 2U &&
         observation.precedingByte == 0xFEU &&
         observation.candidate == 0x3FU);
  CommandFixture observedTimeout;
  CommandObservation noCandidate;
  assert(commandTransaction(17U, 0x00008800UL,
      [&observedTimeout](bool high) { observedTimeout.setChipSelectHigh(high); },
      [&observedTimeout](uint8_t value) { return observedTimeout.exchange(value); },
      &noCandidate) == 0xFFU);
  assert(observedTimeout.responseIndex == 0U &&
         observedTimeout.selectedTransfers == 27U &&
         noCandidate.pollIndex == 0xFFU &&
         noCandidate.candidate == 0xFFU);

  // CMD0 retries use the physically proven maximum and delay, accept only
  // 0x01, and deselect/trail-clock after every attempt.
  uint8_t responses[2] = {0x00U, 0x01U};
  uint8_t commandCalls = 0U, deselectCalls = 0U, delayCalls = 0U;
  uint16_t observedDelay = 0U;
  uint8_t attempts = 0U;
  uint8_t firstR1 = 0xFFU;
  const uint8_t retried = enterIdle(
      [&responses, &commandCalls](uint8_t command, uint32_t argument) {
        assert(command == 0U && argument == 0U);
        return responses[commandCalls++];
      },
      [&deselectCalls]() { ++deselectCalls; },
      [&delayCalls, &observedDelay](uint16_t delayMs) {
        ++delayCalls;
        observedDelay = delayMs;
      }, attempts, &firstR1);
  assert(retried == 0x01U && attempts == 2U && commandCalls == 2U &&
         deselectCalls == 2U && delayCalls == 1U &&
         observedDelay == kCmd0RetryDelayMs && firstR1 == 0x00U);

  commandCalls = deselectCalls = delayCalls = 0U;
  const uint8_t exhausted = enterIdle(
      [&commandCalls](uint8_t, uint32_t) {
        ++commandCalls;
        return static_cast<uint8_t>(0x00U);
      },
      [&deselectCalls]() { ++deselectCalls; },
      [&delayCalls](uint16_t delayMs) {
        assert(delayMs == kCmd0RetryDelayMs);
        ++delayCalls;
      }, attempts, &firstR1);
  assert(exhausted == 0x00U && attempts == kCmd0MaximumAttempts &&
         commandCalls == kCmd0MaximumAttempts &&
         deselectCalls == kCmd0MaximumAttempts &&
         delayCalls == kCmd0MaximumAttempts && firstR1 == 0x00U);

  commandCalls = deselectCalls = delayCalls = 0U;
  const uint8_t mixed = enterIdle(
      [&commandCalls](uint8_t, uint32_t) {
        return commandCalls++ == 0U ? 0x00U : 0x3FU;
      },
      [&deselectCalls]() { ++deselectCalls; },
      [&delayCalls](uint16_t) { ++delayCalls; }, attempts, &firstR1);
  assert(mixed == 0x3FU && firstR1 == 0x00U &&
         attempts == kCmd0MaximumAttempts &&
         deselectCalls == kCmd0MaximumAttempts);

  // CMD8 keeps CS selected while all four R7 bytes are read. CMD58 follows the
  // same rule for OCR; CMD55 and ACMD41 share the selected pre-command byte.
  CommandFixture cmd8;
  const uint8_t cmd8Response[] = {0x01U, 0x00U, 0x00U, 0x01U, 0xAAU};
  for (uint8_t index = 0U; index < sizeof(cmd8Response); ++index)
    cmd8.responses[index] = cmd8Response[index];
  cmd8.responseCount = sizeof(cmd8Response);
  assert(runInitializationCommand(cmd8, 8U, 0x1AAU) == 0x01U);
  for (uint8_t index = 1U; index < sizeof(cmd8Response); ++index)
    assert(!cmd8.chipSelectHigh && cmd8.exchange(0xFFU) == cmd8Response[index]);
  deselect(cmd8);
  assert(cmd8.chipSelectHigh);

  CommandFixture cmd58;
  const uint8_t cmd58Response[] = {0x00U, 0xC0U, 0xFFU, 0x80U, 0x00U};
  for (uint8_t index = 0U; index < sizeof(cmd58Response); ++index)
    cmd58.responses[index] = cmd58Response[index];
  cmd58.responseCount = sizeof(cmd58Response);
  assert(runInitializationCommand(cmd58, 58U, 0U) == 0x00U);
  for (uint8_t index = 1U; index < sizeof(cmd58Response); ++index)
    assert(!cmd58.chipSelectHigh &&
           cmd58.exchange(0xFFU) == cmd58Response[index]);
  deselect(cmd58);
  assert(cmd58.chipSelectHigh);

  CommandFixture cmd17;
  const uint8_t cmd17Response[] = {0x00U, 0xFEU, 0xA5U};
  for (uint8_t index = 0U; index < sizeof(cmd17Response); ++index)
    cmd17.responses[index] = cmd17Response[index];
  cmd17.responseCount = sizeof(cmd17Response);
  assert(runInitializationCommand(cmd17, 17U, 0U) == 0x00U);
  assert(!cmd17.chipSelectHigh && cmd17.exchange(0xFFU) == 0xFEU);
  assert(!cmd17.chipSelectHigh && cmd17.exchange(0xFFU) == 0xA5U);
  deselect(cmd17);
  assert(cmd17.chipSelectHigh);

  CommandFixture cmd17Rejected;
  cmd17Rejected.responses[0] = 0x3FU;
  cmd17Rejected.responseCount = 1U;
  assert(runInitializationCommand(cmd17Rejected, 17U, 0U) == 0x3FU);
  assert(!cmd17Rejected.chipSelectHigh);
  deselect(cmd17Rejected);
  assert(cmd17Rejected.chipSelectHigh &&
         cmd17Rejected.events[cmd17Rejected.eventCount - 1U].kind ==
             EventKind::kTransfer &&
         cmd17Rejected.events[cmd17Rejected.eventCount - 1U].value == 0xFFU);

  const uint8_t initCommands[] = {16U, 17U, 24U, 55U, 41U};
  const uint32_t initArguments[] = {
      512U, 0x12345678UL, 0x12345678UL, 0U, 0x40000000UL};
  for (uint8_t index = 0U; index < sizeof(initCommands); ++index) {
    CommandFixture command;
    command.responses[0] = 0x01U;
    command.responseCount = 1U;
    assert(runInitializationCommand(command, initCommands[index],
                                    initArguments[index]) ==
           command.responses[0]);
    assert(command.events[0].kind == EventKind::kChipSelect &&
           command.events[0].value == 0U);
    assert(command.events[1].kind == EventKind::kTransfer &&
           command.events[1].value == 0xFFU);
    deselect(command);
    assert(command.chipSelectHigh);
  }

  puts("ATmega unified SD command configuration: 59 focused scenarios PASSED");
}
