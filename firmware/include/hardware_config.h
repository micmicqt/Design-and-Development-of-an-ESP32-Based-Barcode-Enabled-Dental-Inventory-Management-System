#pragma once

#include <stdint.h>

// IMPORTANT: These constants record nets visible in the final PCB schematic.
// They are not approval to initialize, read, or drive any of the pins. Several
// electrical and semantic mappings remain unresolved; see
// docs/hardware-validation.md before enabling hardware in a later phase.
namespace dental {
namespace hardware {

// Shared LCD/RTC I2C nets. Bus voltage and pull-ups are not yet verified.
static constexpr uint8_t kI2cSdaGpio = 21;
static constexpr uint8_t kI2cSclGpio = 22;

// MicroSD SPI nets. Module voltage and level shifting are not yet verified.
static constexpr uint8_t kMicroSdChipSelectGpio = 5;
static constexpr uint8_t kMicroSdClockGpio = 18;
static constexpr uint8_t kMicroSdMosiGpio = 23;
static constexpr uint8_t kMicroSdMisoGpio = 19;

// Switch nets only. SW1/SW2 meanings, safe voltage, active level, pulls, and
// boot-time behavior are unconfirmed. Do not configure these as inputs yet.
static constexpr uint8_t kSwitch1NetGpio = 14;
static constexpr uint8_t kSwitch2NetGpio = 12;

// Two-indicator logic-network controls only. The D1/D2 assignment to
// SUCCESS/ERROR and the visible active polarity are unconfirmed.
static constexpr uint8_t kTwoIndicatorControlAGpio = 32;
static constexpr uint8_t kTwoIndicatorControlBGpio = 33;

// Three-indicator logic-network controls only. The D3/D4/D5 assignment to
// HIGH/LOW/EMPTY and the visible active polarity are unconfirmed.
static constexpr uint8_t kThreeIndicatorControlAGpio = 26;
static constexpr uint8_t kThreeIndicatorControlBGpio = 27;

// UART0 nets shown at the scanner connector. The connector labels and signal
// directions have not been confirmed, so these are deliberately not named
// scanner RX/TX. UART0 is also used by Phase 1 Serial development logging.
static constexpr uint8_t kScannerSchematicU0TxdNetGpio = 1;
static constexpr uint8_t kScannerSchematicU0RxdNetGpio = 3;

// This hard compile-time gate prevents Phase 1 from being mistaken for an
// electrically approved hardware build.
static constexpr bool kPhase1HardwareActivationEnabled = false;
static_assert(!kPhase1HardwareActivationEnabled,
              "Phase 1 must not activate unverified hardware");

}  // namespace hardware
}  // namespace dental

