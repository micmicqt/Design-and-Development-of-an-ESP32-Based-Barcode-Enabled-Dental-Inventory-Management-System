#pragma once

#include "hardware_config.h"

namespace dental_atmega {

enum class SmallStatus : uint8_t { OFF, YELLOW, RED, GREEN };
enum class BigStatus : uint8_t { OFF, RED, GREEN };

struct LogicInputs {
  bool a;
  bool b;
};

constexpr SmallStatus kStartupSmallStatus = SmallStatus::OFF;
constexpr BigStatus kStartupBigStatus = BigStatus::OFF;

// Encode the approved truth-table rows, not older schematic labels.
constexpr LogicInputs encodeSmall(SmallStatus status) {
  return status == SmallStatus::YELLOW ? LogicInputs{false, true}
       : status == SmallStatus::RED ? LogicInputs{true, false}
       : status == SmallStatus::GREEN ? LogicInputs{true, true}
       : LogicInputs{false, false};
}

constexpr LogicInputs encodeBig(BigStatus status) {
  return status == BigStatus::RED ? LogicInputs{true, false}
       : status == BigStatus::GREEN ? LogicInputs{true, true}
       : LogicInputs{false, false};
}

constexpr uint8_t smallPortBits(SmallStatus status) {
  return (encodeSmall(status).a ? (1U << hardware::kSmallInputABit) : 0U) |
         (encodeSmall(status).b ? (1U << hardware::kSmallInputBBit) : 0U);
}

constexpr uint8_t bigPortBits(BigStatus status) {
  return (encodeBig(status).a ? (1U << hardware::kBigInputABit) : 0U) |
         (encodeBig(status).b ? (1U << hardware::kBigInputBBit) : 0U);
}

constexpr uint8_t replaceOwnedBits(uint8_t port, uint8_t mask, uint8_t bits) {
  return (port & static_cast<uint8_t>(~mask)) | (bits & mask);
}

}  // namespace dental_atmega
