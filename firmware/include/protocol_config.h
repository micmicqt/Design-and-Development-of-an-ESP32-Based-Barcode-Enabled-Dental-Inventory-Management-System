#pragma once

#include <stdint.h>

namespace dental {
namespace protocol {

// Must match the desktop/shared protocol version when transport is added in a
// later phase. Phase 1 does not start Wi-Fi or expose a network service.
static constexpr uint8_t kVersion = 1;
static constexpr char kDeviceTokenHeader[] = "X-Device-Token";

}  // namespace protocol

namespace firmware {

static constexpr char kName[] = "Dental Inventory ESP32";
static constexpr char kVersion[] = "0.1.0-phase1";
static constexpr uint32_t kSerialBaud = 115200UL;

}  // namespace firmware
}  // namespace dental

