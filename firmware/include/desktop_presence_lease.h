#pragma once

#include <stdint.h>

namespace dental {
namespace presence {

// Tracks whether the desktop application has refreshed its presence lease.
// Unsigned subtraction keeps expiry checks correct when millis() wraps.
class DesktopPresenceLease {
 public:
  explicit DesktopPresenceLease(uint32_t leaseDurationMs)
      : leaseDurationMs_(leaseDurationMs),
        lastHeartbeatMs_(0U),
        networkConnected_(false),
        desktopAvailable_(false) {}

  void setNetworkConnected(bool connected) {
    networkConnected_ = connected;
    if (!connected) {
      desktopAvailable_ = false;
    }
  }

  void recordHeartbeat(uint32_t nowMs) {
    if (!networkConnected_) {
      return;
    }

    lastHeartbeatMs_ = nowMs;
    desktopAvailable_ = true;
  }

  void service(uint32_t nowMs) {
    if (!networkConnected_) {
      desktopAvailable_ = false;
      return;
    }

    if (desktopAvailable_ &&
        static_cast<uint32_t>(nowMs - lastHeartbeatMs_) >=
            leaseDurationMs_) {
      desktopAvailable_ = false;
    }
  }

  bool desktopAvailable() const { return desktopAvailable_; }

 private:
  const uint32_t leaseDurationMs_;
  uint32_t lastHeartbeatMs_;
  bool networkConnected_;
  bool desktopAvailable_;
};

}  // namespace presence
}  // namespace dental
