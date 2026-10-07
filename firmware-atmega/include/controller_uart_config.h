#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace controller_uart {

constexpr uint32_t kCpuHz = 16000000UL;
constexpr uint32_t kBaud = 9600UL;
constexpr uint8_t kRxPortBit = 6U;  // PD6 / Uno D6, software UART RX.
constexpr uint8_t kTxPortBit = 7U;  // PD7 / Uno D7, software UART TX.
constexpr uint8_t kRxMask = 1U << kRxPortBit;
constexpr uint8_t kTxMask = 1U << kTxPortBit;

constexpr uint8_t configuredDdr(uint8_t current) {
  return (current & static_cast<uint8_t>(~kRxMask)) | kTxMask;
}
constexpr uint8_t configuredPort(uint8_t current) {
  return current | kRxMask | kTxMask;
}

constexpr uint8_t kQueueStorage = 16U;
constexpr uint8_t kQueueUsable = kQueueStorage - 1U;

}  // namespace controller_uart
}  // namespace dental_atmega
