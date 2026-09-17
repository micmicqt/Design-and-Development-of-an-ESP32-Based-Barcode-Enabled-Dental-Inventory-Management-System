#pragma once

#include <stdint.h>

// IMPORTANT: These constants record nets visible in the final PCB schematic.
// They are not approval to initialize, read, or drive any of the pins. Several
// electrical and semantic mappings remain unresolved; see
// docs/hardware-validation.md before enabling hardware in a later phase.
namespace dental {
namespace hardware {

// Verified Phase 3 breadboard LCD/RTC I2C bus (both modules powered at 3.3 V).
static constexpr uint8_t kI2cSdaGpio = 21;
static constexpr uint8_t kI2cSclGpio = 22;
static constexpr uint8_t kLcdI2cAddress = 0x27;
static constexpr uint8_t kLcdColumnCount = 20;
static constexpr uint8_t kLcdRowCount = 4;
static constexpr uint8_t kDs3231I2cAddress = 0x68;

// Verified Phase 3 breadboard MicroSD SPI nets. The tested module is powered
// from 5 V and provides its own regulation/logic buffering.
static constexpr uint8_t kMicroSdChipSelectGpio = 5;
static constexpr uint8_t kMicroSdClockGpio = 18;
static constexpr uint8_t kMicroSdMosiGpio = 23;
static constexpr uint8_t kMicroSdMisoGpio = 19;

// Switch nets only. SW1/SW2 meanings, safe voltage, active level, pulls, and
// boot-time behavior are unconfirmed. Do not configure these as inputs yet.
static constexpr uint8_t kSwitch1NetGpio = 14;
static constexpr uint8_t kSwitch2NetGpio = 12;

// Verified two-indicator logic controls: 00=off, 11=D1 SUCCESS, 10=D2 ERROR.
static constexpr uint8_t kTwoIndicatorControlAGpio = 32;
static constexpr uint8_t kTwoIndicatorControlBGpio = 33;

// Verified three-indicator logic controls: 00=off, 10=D3 HIGH, 01=D4 LOW,
// 11=D5 EMPTY.
static constexpr uint8_t kThreeIndicatorControlAGpio = 26;
static constexpr uint8_t kThreeIndicatorControlBGpio = 27;

// UART0 nets shown at the scanner connector. The connector labels and signal
// directions have not been confirmed, so these are deliberately not named
// scanner RX/TX. UART0 is also used by Phase 1 Serial development logging.
static constexpr uint8_t kScannerSchematicU0TxdNetGpio = 1;
static constexpr uint8_t kScannerSchematicU0RxdNetGpio = 3;

// GM65 migration pending: no ESP32 scanner UART/GPIO assignment is active.
// Legacy GPIO16/17 ownership is removed; these belong to the ATmega link only.
static constexpr bool kScannerUartEnabled = false;

// Verified Phase 3 breadboard transaction-button assignments. These diagnostic
// mappings remain separate from the unresolved final-PCB switch-net semantics.
static constexpr uint8_t kRestockTestButtonGpio = 13;
static constexpr uint8_t kCheckoutTestButtonGpio = 14;

// FINAL UART1 ownership: RX GPIO16 / TX GPIO17, through the level interface.
// GPIO34/25 are no longer used for this link; GM65 migration is pending.
// Build overrides must pass the conflict guard below; BOTH -1 disable the link.
#ifndef DENTAL_ATMEGA_LINK_RX_GPIO
#define DENTAL_ATMEGA_LINK_RX_GPIO 16
#endif
#ifndef DENTAL_ATMEGA_LINK_TX_GPIO
#define DENTAL_ATMEGA_LINK_TX_GPIO 17
#endif
static constexpr int kAtmegaLinkRxGpio = DENTAL_ATMEGA_LINK_RX_GPIO;
static constexpr int kAtmegaLinkTxGpio = DENTAL_ATMEGA_LINK_TX_GPIO;
static constexpr bool kAtmegaLinkEnabled = kAtmegaLinkRxGpio >= 0 &&
                                         kAtmegaLinkTxGpio >= 0;
constexpr bool isControllerLinkGpio(int pin) {
  return (pin >= 0 && pin <= 19) || (pin >= 21 && pin <= 23) ||
      (pin >= 25 && pin <= 27) || (pin >= 32 && pin <= 36) || pin == 39;
}
constexpr bool isExistingPeripheralGpio(int pin) {
  return pin == 0 || pin == 1 || pin == 3 || (pin >= 6 && pin <= 11) ||
      pin == 12 || pin == kRestockTestButtonGpio ||
      pin == kCheckoutTestButtonGpio || pin == kI2cSdaGpio ||
      pin == kI2cSclGpio || pin == kMicroSdChipSelectGpio ||
      pin == kMicroSdClockGpio || pin == kMicroSdMosiGpio ||
      pin == kMicroSdMisoGpio || pin == kTwoIndicatorControlAGpio ||
      pin == kTwoIndicatorControlBGpio || pin == kThreeIndicatorControlAGpio ||
      pin == kThreeIndicatorControlBGpio;
}
static_assert((kAtmegaLinkRxGpio == -1 && kAtmegaLinkTxGpio == -1) ||
              (kAtmegaLinkEnabled && isControllerLinkGpio(kAtmegaLinkRxGpio) &&
               isControllerLinkGpio(kAtmegaLinkTxGpio) &&
               kAtmegaLinkTxGpio <= 33 &&
               kAtmegaLinkRxGpio != kAtmegaLinkTxGpio &&
               !isExistingPeripheralGpio(kAtmegaLinkRxGpio) &&
               !isExistingPeripheralGpio(kAtmegaLinkTxGpio)),
              "Confirm two distinct usable controller-link pins, not existing nets");

// This hard compile-time gate prevents Phase 1 from being mistaken for an
// electrically approved hardware build.
static constexpr bool kPhase1HardwareActivationEnabled = false;
static_assert(!kPhase1HardwareActivationEnabled,
              "Phase 1 must not activate unverified hardware");

}  // namespace hardware
}  // namespace dental
