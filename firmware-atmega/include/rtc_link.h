#pragma once

#include "../../firmware-common/include/controller_link_protocol.h"
#include "../../firmware-common/include/rtc_link_protocol.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace dental_atmega {

enum class RtcReply : uint8_t { kNone, kStatus, kTime, kSync };

class RtcLink {
 public:
  template <typename Rtc>
  void receive(uint8_t byte, bool error, Rtc& rtc) {
    if (error) { parser_.rejectUntilNewline(); return; }
    const dental_link::Frame frame = parser_.receive(byte);
    if (frame == dental_link::Frame::kRtcStatusRequest) {
      if (reply_ == RtcReply::kNone && txLength_ == 0U) reply_ = RtcReply::kStatus;
    } else if (frame == dental_link::Frame::kRtcTimeRequest) {
      if (reply_ != RtcReply::kNone || txLength_ != 0U) return;
      sequence_ = rtc.readSequence();
      if (rtc.state() == dental_link::rtc::State::kReady) {
        // If the one-second LCD refresh already owns a read, wait for that
        // result; otherwise start a fresh bounded read when the RTC is idle.
        if (rtc.idle()) rtc.requestRead();
        reply_ = RtcReply::kTime;
      } else reply_ = RtcReply::kStatus;
    } else if (frame == dental_link::Frame::kRtcSync) {
      if (reply_ != RtcReply::kNone || txLength_ != 0U) return;
      dental_link::rtc::DateTime value;
      if (!dental_link::rtc::parseDateTime(parser_.payload(), value)) {
        queueState(dental_link::kRtcSyncResultPrefix,
                   dental_link::rtc::State::kNeedsSync,
                   dental_link::rtc::Reason::kInvalidTime);
      } else if (rtc.state() == dental_link::rtc::State::kReady) {
        queueState(dental_link::kRtcSyncResultPrefix, rtc.state(), rtc.reason());
      } else if (rtc.requestSync(value)) {
        sequence_ = rtc.syncSequence(); reply_ = RtcReply::kSync;
      } else {
        queueState(dental_link::kRtcSyncResultPrefix, rtc.state(), rtc.reason());
      }
    }
  }

  template <typename Rtc, typename Transmitter>
  void service(Rtc& rtc, Transmitter& transmitter, bool canStart) {
    if (reply_ == RtcReply::kStatus && rtc.idle()) {
      queueState(dental_link::kRtcStatusPrefix, rtc.state(), rtc.reason());
      reply_ = RtcReply::kNone;
    } else if (reply_ == RtcReply::kTime) {
      if (rtc.readSequence() != sequence_) {
        if (rtc.lastReadSucceeded()) {
          char timestamp[20];
          if (dental_link::rtc::formatDateTime(rtc.time(), timestamp,
                                               sizeof(timestamp))) {
            queuePayload(dental_link::kRtcTimePrefix, timestamp);
          } else queueState(dental_link::kRtcStatusPrefix, rtc.state(), rtc.reason());
        } else queueState(dental_link::kRtcStatusPrefix, rtc.state(), rtc.reason());
        reply_ = RtcReply::kNone;
      } else if (rtc.idle()) {
        if (rtc.state() == dental_link::rtc::State::kReady) rtc.requestRead();
        else {
          queueState(dental_link::kRtcStatusPrefix, rtc.state(), rtc.reason());
          reply_ = RtcReply::kNone;
        }
      }
    } else if (reply_ == RtcReply::kSync && rtc.syncSequence() != sequence_) {
      queueState(dental_link::kRtcSyncResultPrefix, rtc.state(), rtc.reason());
      reply_ = RtcReply::kNone;
    }

    if (txLength_ == 0U || (txPosition_ == 0U && !canStart)) return;
    if (transmitter.tryWrite(static_cast<uint8_t>(tx_[txPosition_])) &&
        ++txPosition_ == txLength_) {
      txLength_ = txPosition_ = 0U;
    }
  }

  bool transmitting() const { return txLength_ != 0U; }
  bool pending() const { return reply_ != RtcReply::kNone || transmitting(); }

 private:
  void queuePayload(const char* prefix, const char* payload) {
    if (txLength_ != 0U) return;
    const int written = snprintf(tx_, sizeof(tx_), "%s%s\n", prefix, payload);
    if (written > 0 && written < static_cast<int>(sizeof(tx_))) {
      txLength_ = static_cast<uint8_t>(written); txPosition_ = 0U;
    }
  }
  void queueState(const char* prefix, dental_link::rtc::State state,
                  dental_link::rtc::Reason reason) {
    char value[40];
    const int written = snprintf(value, sizeof(value), "%s:%s",
        dental_link::rtc::stateName(state), dental_link::rtc::reasonName(reason));
    if (written > 0 && written < static_cast<int>(sizeof(value)))
      queuePayload(prefix, value);
  }

  dental_link::LineParser parser_;
  char tx_[64] = {};
  uint16_t sequence_ = 0U;
  uint8_t txLength_ = 0U;
  uint8_t txPosition_ = 0U;
  RtcReply reply_ = RtcReply::kNone;
};

}  // namespace dental_atmega
