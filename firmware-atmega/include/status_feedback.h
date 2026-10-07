#pragma once

#include "status_encoding.h"
#include "../../firmware-common/include/controller_link_protocol.h"

namespace dental_atmega {

// A display-only mirror of committed/durable transaction feedback. Stock LEDs
// retain the latest reported status; transaction LEDs pulse briefly. No frame
// handled here can start a scan or change inventory.
class StatusFeedback {
 public:
  static constexpr uint32_t kTransactionPulseMs = 1000UL;

  void receive(uint32_t now, dental_link::Frame frame) {
    switch (frame) {
      case dental_link::Frame::kStockHighFeedback:
        small_ = SmallStatus::GREEN;
        break;
      case dental_link::Frame::kStockLowFeedback:
        small_ = SmallStatus::YELLOW;
        break;
      case dental_link::Frame::kStockEmptyFeedback:
        small_ = SmallStatus::RED;
        break;
      case dental_link::Frame::kRestockCommittedFeedback:
      case dental_link::Frame::kCheckoutCommittedFeedback:
      case dental_link::Frame::kRestockOfflineFeedback:
      case dental_link::Frame::kCheckoutOfflineFeedback:
        pulse(now, BigStatus::GREEN);
        break;
      case dental_link::Frame::kScanErrorFeedback:
      case dental_link::Frame::kUnknownBarcodeFeedback:
        pulse(now, BigStatus::RED);
        break;
      case dental_link::Frame::kScanDismissedFeedback:
        big_ = BigStatus::OFF;
        pulseActive_ = false;
        break;
      default:
        break;
    }
  }

  void localError(uint32_t now) { pulse(now, BigStatus::RED); }

  void service(uint32_t now) {
    if (pulseActive_ &&
        static_cast<uint32_t>(now - pulseStartedMs_) >= kTransactionPulseMs) {
      big_ = BigStatus::OFF;
      pulseActive_ = false;
    }
  }

  SmallStatus small() const { return small_; }
  BigStatus big() const { return big_; }

 private:
  void pulse(uint32_t now, BigStatus status) {
    big_ = status;
    pulseStartedMs_ = now;
    pulseActive_ = true;
  }

  uint32_t pulseStartedMs_ = 0UL;
  SmallStatus small_ = SmallStatus::OFF;
  BigStatus big_ = BigStatus::OFF;
  bool pulseActive_ = false;
};

}  // namespace dental_atmega
