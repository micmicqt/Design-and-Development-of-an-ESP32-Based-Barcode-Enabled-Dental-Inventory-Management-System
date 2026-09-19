#pragma once
#include <stdint.h>
#include <string.h>

namespace dental_atmega {
namespace twi {
constexpr uint32_t kClockHz = 100000UL;
constexpr uint8_t bitRate(uint32_t cpuHz) {
  return static_cast<uint8_t>((cpuHz / kClockHz - 16UL) / 2UL);
}
static_assert(bitRate(16000000UL) == 72U, "100 kHz, prescaler one");
enum class Result : uint8_t {
  kIdle, kPending, kSuccess, kInvalid, kAddressNack, kDataNack,
  kArbitrationLost, kBusError, kTimeout
};

// One bounded write, serviced cooperatively. Hardware TWINT is polled; no TWI
// ISR or interrupt masking, and no waits inside service(). STOP is bounded too.
template <typename Hardware>
class Master {
 public:
  static constexpr uint8_t kCapacity = 6U;
  static constexpr uint32_t kTimeoutMs = 20UL;
  explicit Master(Hardware& hardware) : hw_(hardware) {}
  void initialize() { hw_.initialize(); }
  bool write(uint32_t now, uint8_t address, const uint8_t* data, uint8_t count) {
    if (busy()) return false;
    if (address < 0x08U || address > 0x77U || !data || !count || count > kCapacity) {
      result_ = Result::kInvalid; return false;
    }
    memcpy(bytes_, data, count);
    address_ = address; count_ = count; index_ = 0U;
    since_ = now; result_ = Result::kPending; phase_ = Phase::kStart;
    hw_.start(); return true;
  }
  void service(uint32_t now) {
    if (!busy()) return;
    if (static_cast<uint32_t>(now - since_) >= kTimeoutMs) {
      // Reset only TWI, not timers/USART/ports. A stuck external bus stays an
      // explicit error; never bit-bang indefinitely or retry forever.
      hw_.reset(); phase_ = Phase::kIdle; result_ = Result::kTimeout; return;
    }
    if (phase_ == Phase::kStop) {
      if (!hw_.stopping()) { phase_ = Phase::kIdle; result_ = completion_; }
      return;
    }
    if (!hw_.ready()) return;
    const uint8_t status = hw_.status();
    if (status == 0x38U) {
      // Arbitration lost: release bus, do not STOP another master's transfer.
      hw_.reset(); phase_ = Phase::kIdle; result_ = Result::kArbitrationLost; return;
    }
    if (phase_ == Phase::kStart && (status == 0x08U || status == 0x10U)) {
      hw_.send(static_cast<uint8_t>(address_ << 1U)); phase_ = Phase::kAddress;
    } else if (phase_ == Phase::kAddress && status == 0x18U) {
      hw_.send(bytes_[index_++]); phase_ = Phase::kData;
    } else if (phase_ == Phase::kData && status == 0x28U) {
      if (index_ < count_) hw_.send(bytes_[index_++]);
      else finish(Result::kSuccess);
    } else if (phase_ == Phase::kAddress && status == 0x20U) {
      finish(Result::kAddressNack);
    } else if (phase_ == Phase::kData && status == 0x30U) {
      finish(Result::kDataNack);
    } else finish(Result::kBusError);
  }
  bool busy() const { return phase_ != Phase::kIdle; }
  Result result() const { return result_; }
 private:
  enum class Phase : uint8_t { kIdle, kStart, kAddress, kData, kStop };
  void finish(Result result) {
    completion_ = result; phase_ = Phase::kStop; hw_.stop();
  }
  Hardware& hw_;
  uint32_t since_ = 0UL;
  uint8_t bytes_[kCapacity] = {};
  uint8_t address_ = 0U, count_ = 0U, index_ = 0U;
  Phase phase_ = Phase::kIdle;
  Result result_ = Result::kIdle, completion_ = Result::kIdle;
};

// Actual AVR adapter implemented separately so the same Master is host tested.
struct AvrHardware {
  void initialize();
  void start();
  void send(uint8_t value);
  void stop();
  void reset();
  bool ready() const;
  bool stopping() const;
  uint8_t status() const;
};
} // namespace twi
} // namespace dental_atmega
