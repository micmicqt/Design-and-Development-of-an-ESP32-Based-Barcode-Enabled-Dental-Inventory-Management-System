#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace hardware {

constexpr uint8_t kTwiSdaBit = 4U; // PC4 / Uno A4, LCD only (RTC stays ESP32).
constexpr uint8_t kTwiSclBit = 5U; // PC5 / Uno A5.
constexpr uint8_t kTwiMask = (1U << kTwiSdaBit) | (1U << kTwiSclBit);
constexpr uint8_t kLcdAddress = 0x27U;
constexpr uint8_t kScannerRxBit = 0U; // PC0 / Uno A0: GM65 TX -> ATmega RX.
constexpr uint8_t kScannerTxBit = 1U; // PC1 / Uno A1: ATmega TX -> GM65 RX.
constexpr uint8_t kScannerMask = (1U << kScannerRxBit) | (1U << kScannerTxBit);
static_assert((kScannerMask & kTwiMask) == 0U,
              "Scanner software UART must not share the LCD TWI pins");
constexpr uint8_t scannerDdr(uint8_t current) {
  return (current & static_cast<uint8_t>(~(1U << kScannerRxBit))) |
      (1U << kScannerTxBit);
}
constexpr uint8_t scannerPort(uint8_t current) { return current | kScannerMask; }

// AVR port bits are authoritative; Arduino numbers are documentation only.
constexpr uint8_t kSmallInputABit = 5U;  // PD5 / Arduino D5
constexpr uint8_t kSmallInputBBit = 4U;  // PD4 / Arduino D4
constexpr uint8_t kBigInputABit = 0U;    // PB0 / Arduino D8
constexpr uint8_t kBigInputBBit = 1U;    // PB1 / Arduino D9
constexpr uint8_t kSmallMask = (1U << kSmallInputABit) | (1U << kSmallInputBBit);
constexpr uint8_t kBigMask = (1U << kBigInputABit) | (1U << kBigInputBBit);
constexpr uint8_t kRestockButtonBit = 2U;  // PD2 / Uno D2, active HIGH.
constexpr uint8_t kCheckoutButtonBit = 3U; // PD3 / Uno D3, active HIGH.
constexpr uint8_t kButtonMask = (1U << kRestockButtonBit) | (1U << kCheckoutButtonBit);
static_assert((kButtonMask & kSmallMask) == 0U && (kButtonMask & 0xC3U) == 0U,
              "Buttons must not share LED, scanner or controller UART pins");
constexpr uint8_t buttonDdr(uint8_t current) {
  return current & static_cast<uint8_t>(~kButtonMask);
}
constexpr uint8_t buttonPort(uint8_t current) {
  return current & static_cast<uint8_t>(~kButtonMask); // No internal pull-ups.
}
constexpr bool buttonPressed(uint8_t pins, uint8_t bit) {
  return (pins & (1U << bit)) != 0U;
}

}  // namespace hardware
}  // namespace dental_atmega
