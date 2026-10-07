#pragma once

#include "hardware_config.h"

#include <stdint.h>

namespace dental_atmega { namespace storage { namespace spi_config {

// ATmega328P SPI control-register bit positions. Keeping these values in a
// host-testable header makes the production register configuration explicit.
constexpr uint8_t kSpcrSpe = 6U;
constexpr uint8_t kSpcrDord = 5U;
constexpr uint8_t kSpcrMstr = 4U;
constexpr uint8_t kSpcrCpol = 3U;
constexpr uint8_t kSpcrCpha = 2U;
constexpr uint8_t kSpcrSpr1 = 1U;
constexpr uint8_t kSpcrSpr0 = 0U;
constexpr uint8_t kSpsrSpi2x = 0U;
constexpr uint8_t kStartupClockBytes = 10U; // 80 clocks with CS high.
// The physically working standalone initializer waits this long after boot
// before touching the card. Timer0 milliseconds start at zero on each boot.
constexpr uint16_t kPowerUpSettleMs = 500U;
constexpr uint8_t kResponsePollBytes = 20U;
constexpr uint8_t kCmd0MaximumAttempts = 20U;
constexpr uint16_t kCmd0RetryDelayMs = 100U;
constexpr uint16_t kAcmd41MaximumAttempts = 300U;
constexpr uint16_t kAcmd41RetryDelayMs = 10U;
constexpr uint32_t kSdSpiClockHz = 125000UL;

constexpr uint8_t kSpcr =
    (1U << kSpcrSpe) | (1U << kSpcrMstr) |
    (1U << kSpcrSpr1) | (1U << kSpcrSpr0); // Mode 0, MSB first, F_CPU / 128.

class PowerUpSettle {
 public:
  template <typename Clock, typename Pause>
  void beforeFirstInitialization(Clock milliseconds, Pause pauseOneMs) {
    if (firstInitializationStarted_) return;
    // Wait only for the part of the boot interval that has not yet elapsed.
    // Later initialization attempts never repeat the delay, even after failure.
    while (milliseconds() < kPowerUpSettleMs) pauseOneMs();
    firstInitializationStarted_ = true;
  }

 private:
  bool firstInitializationStarted_ = false;
};

constexpr uint8_t configuredDdrb(uint8_t current) {
  return (current | hardware::kMicroSdOutputMask) &
      static_cast<uint8_t>(~(1U << hardware::kMicroSdMisoBit));
}

constexpr uint8_t configuredPortb(uint8_t current) {
  // Keep CS deasserted while explicitly disabling the AVR pull-up on the
  // card-driven MISO input. Preserve all unrelated PORTB output latches.
  return (current | (1U << hardware::kMicroSdChipSelectBit)) &
      static_cast<uint8_t>(~(1U << hardware::kMicroSdMisoBit));
}

inline void commandPacket(uint8_t command, uint32_t argument,
                          uint8_t (&packet)[6]) {
  packet[0] = static_cast<uint8_t>(0x40U | command);
  packet[1] = static_cast<uint8_t>(argument >> 24U);
  packet[2] = static_cast<uint8_t>(argument >> 16U);
  packet[3] = static_cast<uint8_t>(argument >> 8U);
  packet[4] = static_cast<uint8_t>(argument);
  packet[5] = command == 0U ? 0x95U : command == 8U ? 0x87U : 0x01U;
}

constexpr bool isR1Response(uint8_t value) {
  return (value & 0x80U) == 0U;
}

constexpr bool cmd0EnteredIdle(uint8_t response) { return response == 0x01U; }

struct CommandObservation {
  uint8_t selectedByte = 0xFFU;
  uint8_t pollIndex = 0xFFU;
  uint8_t precedingByte = 0xFFU;
  uint8_t candidate = 0xFFU;
};

template <typename ChipSelect, typename Exchange>
void sendStartupClocks(ChipSelect chipSelectHigh, Exchange exchange) {
  chipSelectHigh(true);
  for (uint8_t index = 0U; index < kStartupClockBytes; ++index)
    exchange(0xFFU);
}

// Physically verified command transaction shared by every SD command: select,
// clock one complete 0xFF byte while selected, send the command packet, then
// return the first R1-shaped response while leaving CS selected. The caller
// reads any extended response before deselecting and supplying trailing clocks.
template <typename ChipSelect, typename Exchange>
uint8_t commandTransaction(uint8_t command, uint32_t argument,
                           ChipSelect chipSelectHigh, Exchange exchange,
                           CommandObservation* observation = nullptr) {
  uint8_t packet[6];
  commandPacket(command, argument, packet);
  chipSelectHigh(false);
  const uint8_t selectedByte = exchange(0xFFU);
  if (observation) observation->selectedByte = selectedByte;
  for (uint8_t index = 0U; index < sizeof(packet); ++index)
    exchange(packet[index]);

  uint8_t precedingByte = 0xFFU;
  for (uint8_t index = 0U; index < kResponsePollBytes; ++index) {
    const uint8_t received = exchange(0xFFU);
    if (isR1Response(received)) {
      if (observation) {
        observation->pollIndex = index;
        observation->precedingByte = precedingByte;
        observation->candidate = received;
      }
      return received;
    }
    precedingByte = received;
  }
  if (observation) observation->precedingByte = precedingByte;
  return 0xFFU;
}

template <typename Command, typename Deselect, typename Delay>
uint8_t enterIdle(Command command, Deselect deselect, Delay delay,
                  uint8_t& attemptsUsed,
                  uint8_t* firstResponse = nullptr) {
  uint8_t response = 0xFFU;
  attemptsUsed = 0U;
  if (firstResponse) *firstResponse = 0xFFU;
  while (attemptsUsed < kCmd0MaximumAttempts) {
    response = command(0U, 0U);
    if (firstResponse && attemptsUsed == 0U) *firstResponse = response;
    deselect();
    ++attemptsUsed;
    if (cmd0EnteredIdle(response)) break;
    delay(kCmd0RetryDelayMs);
  }
  return response;
}

constexpr bool blockAddressed(const uint8_t* ocr) {
  return ocr && (ocr[0] & 0x40U) != 0U;
}

} } }
