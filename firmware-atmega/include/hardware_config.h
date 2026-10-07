#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace hardware {

constexpr uint8_t kControllerRxBit = 6U; // PD6 / Uno D6: ESP32 GPIO17 TX.
constexpr uint8_t kControllerTxBit = 7U; // PD7 / Uno D7: ESP32 GPIO16 RX.
constexpr uint8_t kControllerMask =
    (1U << kControllerRxBit) | (1U << kControllerTxBit);

constexpr uint8_t kTwiSdaBit = 4U; // PC4 / Uno A4, shared LCD + DS3231 SDA.
constexpr uint8_t kTwiSclBit = 5U; // PC5 / Uno A5.
constexpr uint8_t kTwiMask = (1U << kTwiSdaBit) | (1U << kTwiSclBit);
constexpr uint8_t kLcdAddress = 0x27U;
constexpr uint8_t kRtcAddress = 0x68U;
constexpr uint8_t kScannerRxBit = 0U; // PD0 / Uno D0: GM65 TX -> RXD.
constexpr uint8_t kScannerTxBit = 1U; // PD1 / Uno D1: TXD -> GM65 RX.
constexpr uint8_t kScannerMask = (1U << kScannerRxBit) | (1U << kScannerTxBit);
static_assert((kScannerMask & kControllerMask) == 0U,
              "Scanner USART0 and controller software UART must have separate pins");

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
static_assert((kButtonMask & kSmallMask) == 0U &&
                  (kButtonMask & (kControllerMask | kScannerMask)) == 0U,
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

constexpr uint8_t kMicroSdChipSelectBit = 2U; // PB2 / Uno D10.
constexpr uint8_t kMicroSdMosiBit = 3U;       // PB3 / Uno D11.
constexpr uint8_t kMicroSdMisoBit = 4U;       // PB4 / Uno D12.
constexpr uint8_t kMicroSdClockBit = 5U;      // PB5 / Uno D13.
constexpr uint8_t kMicroSdOutputMask =
    (1U << kMicroSdChipSelectBit) | (1U << kMicroSdMosiBit) |
    (1U << kMicroSdClockBit);
static_assert((kMicroSdOutputMask & kBigMask) == 0U,
              "MicroSD SPI must not share the big status outputs");

}  // namespace hardware
}  // namespace dental_atmega
