#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace software_uart {

constexpr uint8_t kRxPortBit = 6U;  // PD6 / Uno D6
constexpr uint8_t kTxPortBit = 7U;  // PD7 / Uno D7
constexpr uint16_t kBitTicks = 208U;  // Timer1: 16 MHz / 8 / 9600, rounded.
constexpr uint16_t kHalfBitTicks = 104U;

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

// Single ISR/main producer/consumer ring, used inside atomic main sections.
// One slot is reserved to distinguish full/empty; no heap or blocking wait.
struct ReceivedByte { uint8_t byte; bool error; };
template <typename T>
class Ring {
 public:
  bool push(const T& value) {
    const uint8_t next = static_cast<uint8_t>((head_ + 1U) & 15U);
    if (next == tail_) return false;
    entries_[head_] = value;
    head_ = next;
    return true;
  }
  bool pop(T& value) {
    if (head_ == tail_) return false;
    value = entries_[tail_];
    tail_ = static_cast<uint8_t>((tail_ + 1U) & 15U);
    return true;
  }
 private:
  T entries_[16] = {};
  volatile uint8_t head_ = 0U;
  volatile uint8_t tail_ = 0U;
};

}  // namespace software_uart
}  // namespace dental_atmega
