#pragma once

#include "../../firmware-common/include/controller_link_protocol.h"
#include "../../firmware-common/include/rtc_link_protocol.h"
#include <stdint.h>
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
          // The reply slot is idle and exclusively owned by this main-loop
          // client. Format directly into it; no temporary timestamp escapes.
          if (!queueTime(rtc.time()))
            queueState(dental_link::kRtcStatusPrefix, rtc.state(), rtc.reason());
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
  bool queueTime(const dental_link::rtc::DateTime& time) {
    if (txLength_ != 0U) return false;
    constexpr uint8_t prefixLength = sizeof(dental_link::kRtcTimePrefix) - 1U;
    if (!dental_link::rtc::formatDateTime(
            time, tx_ + prefixLength, sizeof(tx_) - prefixLength)) return false;
    dental_link::text::copy(tx_, dental_link::kRtcTimePrefix, prefixLength);
    tx_[prefixLength + 19U] = '\n'; tx_[prefixLength + 20U] = '\0';
    txLength_ = prefixLength + 20U; txPosition_ = 0U;
    return true;
  }
  void queueState(const char* prefix, dental_link::rtc::State state,
                  dental_link::rtc::Reason reason) {
    queueParts(prefix, dental_link::rtc::stateName(state),
               dental_link::rtc::reasonName(reason));
  }
  void queueParts(const char* prefix, const char* first, const char* second) {
    if (txLength_ != 0U || !prefix || !first) return;
    const size_t prefixLength = dental_link::text::length(prefix);
    const size_t firstLength = dental_link::text::length(first);
    const size_t secondLength = second ? dental_link::text::length(second) : 0U;
    const size_t total = prefixLength + firstLength +
        (second ? 1U + secondLength : 0U) + 1U;
    if (total >= sizeof(tx_)) return;
    size_t position = 0U;
    dental_link::text::copy(tx_ + position, prefix, prefixLength); position += prefixLength;
    dental_link::text::copy(tx_ + position, first, firstLength); position += firstLength;
    if (second) {
      tx_[position++] = ':';
      dental_link::text::copy(tx_ + position, second, secondLength); position += secondLength;
    }
    tx_[position++] = '\n';
    tx_[position] = '\0';
    txLength_ = static_cast<uint8_t>(position); txPosition_ = 0U;
  }

  // RTC requests/sync are shorter than barcode frames. A smaller parser
  // leaves stack headroom on the ATmega's 2 KB SRAM during SD initialization.
  dental_link::BasicLineParser<30U> parser_;
  // Longest state reply is RTC_STATUS:unavailable:communication_failure\n
  // (45 bytes plus NUL); 48 avoids an unused 16-byte reserve in SRAM.
  char tx_[48] = {};
  uint16_t sequence_ = 0U;
  uint8_t txLength_ = 0U;
  uint8_t txPosition_ = 0U;
  RtcReply reply_ = RtcReply::kNone;
};

}  // namespace dental_atmega
