#pragma once

#include <stdint.h>

namespace dental { namespace controller_link {

// The existing router handles user workflow conflicts. Only a controller
// non-preemptible storage owner prevents a fresh mode request before that router
// runs. Background staging/preview instead records the mode and defers SCAN
// until a completed FatFs boundary; it is not a storage-unavailable condition.
enum class ButtonAdmissionGate : uint8_t {
  kProceed,
  kStorageBridgeActive,
  kOfflineAckActive,
};

inline ButtonAdmissionGate buttonAdmissionGate(bool storageBridgeActive,
                                               bool offlineAckActive,
                                               bool backgroundPreemptible = false) {
  if (offlineAckActive) return ButtonAdmissionGate::kOfflineAckActive;
  if (storageBridgeActive && !backgroundPreemptible)
    return ButtonAdmissionGate::kStorageBridgeActive;
  return ButtonAdmissionGate::kProceed;
}

inline const char* buttonAdmissionGateReason(ButtonAdmissionGate gate) {
  switch (gate) {
    case ButtonAdmissionGate::kStorageBridgeActive:
      return "STORAGE_BRIDGE_ACTIVE";
    case ButtonAdmissionGate::kOfflineAckActive:
      return "OFFLINE_ACK_IN_PROGRESS";
    default: return "NONE";
  }
}

}}  // namespace dental::controller_link
