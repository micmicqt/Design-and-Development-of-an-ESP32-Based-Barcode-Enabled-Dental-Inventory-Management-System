#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace software_uart {

constexpr uint8_t kRxPortBit = 6U;  // Controller RX: PD6 / Uno D6.
constexpr uint8_t kTxPortBit = 7U;  // Controller TX: PD7 / Uno D7.
// Reuse the Step 2 Timer1/PCINT2 software-UART timing for the controller link.
constexpr uint16_t kBitTicks = 208U;  // Timer1: 16 MHz / 8 / 9600, rounded.
constexpr uint16_t kHalfBitTicks = 104U;

inline bool deadlineDue(uint16_t now, uint16_t deadline) {
  return static_cast<int16_t>(now - deadline) >= 0;
}
inline bool deadlineBefore(uint16_t left, uint16_t right) {
  return static_cast<int16_t>(left - right) < 0;
}

enum class SampleResult : uint8_t { kMore, kFalseStart, kByte, kFramingError };

// Called at half a bit after the falling start edge, then once per bit.
class Receiver {
 public:
  void begin() { phase_ = 0U; byte_ = 0U; active_ = true; }
  bool active() const { return active_; }
  uint8_t byte() const { return byte_; }
  SampleResult sample(bool high) {
    if (!active_) return SampleResult::kMore;
    if (phase_ == 0U) {
      if (high) { active_ = false; return SampleResult::kFalseStart; }
    } else if (phase_ <= 8U) {
      if (high) byte_ |= static_cast<uint8_t>(1U << (phase_ - 1U));
    } else {
      active_ = false;
      return high ? SampleResult::kByte : SampleResult::kFramingError;
    }
    ++phase_;
    return SampleResult::kMore;
  }
 private:
  uint8_t phase_ = 0U;
  uint8_t byte_ = 0U;
  bool active_ = false;
};

// begin() drives start LOW externally; ticks produce eight LSB-first data
// bits, stop HIGH, then complete only after a full stop-bit interval.
class Sender {
 public:
  void begin(uint8_t byte) { byte_ = byte; phase_ = 0U; active_ = true; }
  bool active() const { return active_; }
  bool tick() {
    if (!active_) return true;
    if (phase_ < 8U) return (byte_ & (1U << phase_++)) != 0U;
    if (phase_++ == 9U) active_ = false;
    return true;
  }
 private:
  uint8_t byte_ = 0U;
  uint8_t phase_ = 0U;
  bool active_ = false;
};

class TimedSender {
 public:
  void begin(uint8_t byte, uint16_t now) {
    sender_.begin(byte); next_ = static_cast<uint16_t>(now + kBitTicks);
  }
  bool active() const { return sender_.active(); }
  bool due(uint16_t now) const { return active() && deadlineDue(now, next_); }
  uint16_t next() const { return next_; }
  bool tick() {
    const bool high = sender_.tick();
    next_ = static_cast<uint16_t>(next_ + kBitTicks);
    return high;
  }
 private:
  Sender sender_;
  uint16_t next_ = 0U;
};

class TimedReceiver {
 public:
  void begin(uint16_t now) {
    receiver_.begin(); next_ = static_cast<uint16_t>(now + kHalfBitTicks);
  }
  bool active() const { return receiver_.active(); }
  bool due(uint16_t now) const { return active() && deadlineDue(now, next_); }
  uint16_t next() const { return next_; }
  SampleResult sample(bool high) {
    const SampleResult result = receiver_.sample(high);
    next_ = static_cast<uint16_t>(next_ + kBitTicks);
    return result;
  }
  uint8_t byte() const { return receiver_.byte(); }
 private:
  Receiver receiver_;
  uint16_t next_ = 0U;
};

// Single ISR/main producer/consumer ring, used inside atomic main sections.
// One slot is reserved to distinguish full/empty; no heap or blocking wait.
struct ReceivedByte { uint8_t byte; bool error; };
template <typename T, uint8_t Capacity = 16U>
class Ring {
 public:
  static_assert(Capacity >= 2U && (Capacity & (Capacity - 1U)) == 0U,
                "Ring capacity must be a power of two");
  bool push(const T& value) {
    const uint8_t next = static_cast<uint8_t>((head_ + 1U) & (Capacity - 1U));
    if (next == tail_) return false;
    entries_[head_] = value;
    head_ = next;
    return true;
  }
  bool pop(T& value) {
    if (head_ == tail_) return false;
    value = entries_[tail_];
    tail_ = static_cast<uint8_t>((tail_ + 1U) & (Capacity - 1U));
    return true;
  }
  void clear() { tail_ = head_; }
  uint8_t size() const {
    return static_cast<uint8_t>((head_ - tail_) & (Capacity - 1U));
  }
  static constexpr uint8_t usableCapacity() { return Capacity - 1U; }
 private:
  T entries_[Capacity] = {};
  volatile uint8_t head_ = 0U;
  volatile uint8_t tail_ = 0U;
};

}  // namespace software_uart
}  // namespace dental_atmega
