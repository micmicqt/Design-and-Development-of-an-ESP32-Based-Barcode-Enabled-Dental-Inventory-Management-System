#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace dental { namespace discovery {

static constexpr char kIdentifyRequest[] = "@ATD:IDENTIFY:1";
static constexpr char kFirmwareVersion[] = "0.1.0";

class UsbRequestParser {
 public:
  bool accept(uint8_t byte) {
    if (byte == '\n') {
      if (discard_) { reset(); return false; }
      line_[length_] = '\0';
      if (length_ > 0U && line_[length_ - 1U] == '\r') line_[length_ - 1U] = '\0';
      const bool matched = strcmp(line_, kIdentifyRequest) == 0;
      reset();
      return matched;
    }
    if (discard_) return false;
    if ((byte >= 32U && byte <= 126U) || byte == '\r') {
      if (length_ + 1U < sizeof(line_)) line_[length_++] = static_cast<char>(byte);
      else discard_ = true;
    } else discard_ = true;
    return false;
  }

 private:
  void reset() { length_ = 0U; discard_ = false; }
  char line_[32] = {};
  uint8_t length_ = 0U;
  bool discard_ = false;
};

inline bool formatIdentity(char* output, size_t capacity, const char* deviceId,
                           bool wifiConnected, const char* ipAddress) {
  if (!output || capacity == 0U || !deviceId || !ipAddress) return false;
  const int count = snprintf(output, capacity, "@ATD:DEVICE:1:%s:%u:%s:%s",
                             deviceId, wifiConnected ? 1U : 0U,
                             wifiConnected ? ipAddress : "-", kFirmwareVersion);
  return count > 0 && static_cast<size_t>(count) < capacity;
}

} }  // namespace dental::discovery
