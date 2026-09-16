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

}  // namespace hardware
}  // namespace dental_atmega
