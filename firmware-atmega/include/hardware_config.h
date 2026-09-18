#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace hardware {

// AVR port bits are authoritative; Arduino numbers are documentation only.
constexpr uint8_t kSmallInputABit = 5U;  // PD5 / Arduino D5
constexpr uint8_t kSmallInputBBit = 4U;  // PD4 / Arduino D4
constexpr uint8_t kBigInputABit = 0U;    // PB0 / Arduino D8
constexpr uint8_t kBigInputBBit = 1U;    // PB1 / Arduino D9
constexpr uint8_t kSmallMask = (1U << kSmallInputABit) | (1U << kSmallInputBBit);
constexpr uint8_t kBigMask = (1U << kBigInputABit) | (1U << kBigInputBBit);
constexpr uint8_t kRestockButtonBit = 2U;  // PD2 / Uno D2, active LOW to GND.
constexpr uint8_t kCheckoutButtonBit = 3U; // PD3 / Uno D3, active LOW to GND.
constexpr uint8_t kButtonMask = (1U << kRestockButtonBit) | (1U << kCheckoutButtonBit);
static_assert((kButtonMask & kSmallMask) == 0U && (kButtonMask & 0xC3U) == 0U,
              "Buttons must not share LED, scanner or controller UART pins");

}  // namespace hardware
}  // namespace dental_atmega
