#pragma once

#include "../../firmware-common/include/controller_link_protocol.h"

namespace dental_atmega {

enum class LinkState : uint8_t { kIdle, kSending, kWaiting };
enum class LinkOutcome : uint8_t { kNone, kVerified, kTimedOut };

class PingClient {
 public:
  static constexpr uint32_t kRetryIntervalMs = 2000UL;
  static constexpr uint32_t kTimeoutMs = 1000UL;

  // Start the first attempt after a short startup interval. No blocking waits.
  explicit PingClient(uint32_t now = 0UL) : stateSince_(now) {}

  template <typename Transmitter>
  void service(uint32_t now, Transmitter& transmitter) {
    expire(now);
    if (state_ == LinkState::kIdle) {
      if (static_cast<uint32_t>(now - stateSince_) < kRetryIntervalMs) return;
      parser_.reset();
      position_ = 0U;
      state_ = LinkState::kSending;
      stateSince_ = now;
      outcome_ = LinkOutcome::kNone;
    }
    if (state_ == LinkState::kSending &&
        transmitter.tryWrite(static_cast<uint8_t>(
            dental_link::text::at(dental_link::kPing, position_)))) {
      if (++position_ == sizeof(dental_link::kPing) - 1U) {
        state_ = LinkState::kWaiting;
        stateSince_ = now;
      }
    }
  }

  dental_link::Frame receive(uint32_t now, uint8_t byte) {
    expire(now);
    const dental_link::Frame frame = parser_.receive(byte);
    if (state_ == LinkState::kWaiting && frame == dental_link::Frame::kPong) {
      ++verifiedCount_;
      finish(now, LinkOutcome::kVerified);
    }
    return frame;
  }

  void receiveError() { parser_.rejectUntilNewline(); }
  const char* payload() const { return parser_.payload(); }
  LinkState state() const { return state_; }
  LinkOutcome outcome() const { return outcome_; }
  uint16_t verifiedCount() const { return verifiedCount_; }
  uint16_t timeoutCount() const { return timeoutCount_; }

 private:
  void expire(uint32_t now) {
    if (state_ != LinkState::kIdle &&
        static_cast<uint32_t>(now - stateSince_) >= kTimeoutMs) {
      ++timeoutCount_;
      finish(now, LinkOutcome::kTimedOut);
    }
  }
  void finish(uint32_t now, LinkOutcome outcome) {
    state_ = LinkState::kIdle;
    stateSince_ = now;
    outcome_ = outcome;
    parser_.reset();
  }

  // PONG, bounded BTN replies and advisory 20-column LCD rows; never barcodes.
  dental_link::BasicLineParser<26U> parser_;
  uint32_t stateSince_;
  uint16_t verifiedCount_ = 0U;
  uint16_t timeoutCount_ = 0U;
  uint8_t position_ = 0U;
  LinkState state_ = LinkState::kIdle;
  LinkOutcome outcome_ = LinkOutcome::kNone;
};

}  // namespace dental_atmega
