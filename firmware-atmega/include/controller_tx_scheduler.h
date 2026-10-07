#pragma once

#include "ping_client.h"
#include <stdint.h>

namespace dental_atmega {

// Serializes complete outgoing lines, not long-lived SD read operations.
// Receive dispatch remains independent and must run before service().
class ControllerTxScheduler {
 public:
  enum class Owner : uint8_t { kNone, kStorage, kRtc, kScanner };

  template <typename Storage, typename RtcLink, typename Scanner,
            typename Ping, typename Rtc, typename Transmitter>
  void service(uint32_t now, Storage& storage, RtcLink& rtcLink,
               Scanner& scanner, Ping& ping, Rtc& rtc,
               Transmitter& transmitter) {
    if (owner_ == Owner::kStorage) {
      storage.service(transmitter);
      if (!storage.outputFrameActive()) owner_ = Owner::kNone;
      return;
    }
    if (owner_ == Owner::kRtc) {
      rtcLink.service(rtc, transmitter, true);
      if (!rtcLink.transmitting()) owner_ = Owner::kNone;
      return;
    }
    if (owner_ == Owner::kScanner) {
      scanner.service(now, ping, transmitter);
      if (!scanner.controllerTransmissionActive() &&
          ping.state() != LinkState::kSending) owner_ = Owner::kNone;
      return;
    }

    if (storage.outputFrameActive()) {
      owner_ = Owner::kStorage;
      storage.service(transmitter);
    } else if (rtcLink.transmitting()) {
      owner_ = Owner::kRtc;
      rtcLink.service(rtc, transmitter, true);
    } else if (scanner.controllerTransmissionActive() ||
               ping.state() == LinkState::kSending) {
      owner_ = Owner::kScanner;
      scanner.service(now, ping, transmitter);
    } else {
      // A logical RTC request is not TX ownership until it has a line ready.
      rtcLink.service(rtc, transmitter, true);
      if (rtcLink.transmitting()) owner_ = Owner::kRtc;
      else {
        storage.service(transmitter);
        if (storage.outputFrameActive()) owner_ = Owner::kStorage;
        else {
          scanner.service(now, ping, transmitter);
          if (scanner.controllerTransmissionActive() ||
              ping.state() == LinkState::kSending) owner_ = Owner::kScanner;
        }
      }
    }
  }

  Owner owner() const { return owner_; }

 private:
  Owner owner_ = Owner::kNone;
};

}  // namespace dental_atmega
