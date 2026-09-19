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

// One bounded write or register-write/read transaction, serviced cooperatively.
// A completion remains owned until its caller consumes it, preventing another
// LCD/RTC client from replacing the result on the shared bus.
template <typename Hardware>
class Master {
 public:
  static constexpr uint8_t kCapacity = 8U;
  static constexpr uint32_t kTimeoutMs = 20UL;
  explicit Master(Hardware& hardware) : hw_(hardware) {}
  void initialize() { hw_.initialize(); }
  bool write(uint32_t now, uint8_t address, const uint8_t* data, uint8_t count) {
    return begin(now, address, data, count, 0U);
  }
  bool writeRead(uint32_t now, uint8_t address, const uint8_t* data,
                 uint8_t writeCount, uint8_t readCount) {
    if (readCount == 0U || readCount > kCapacity) {
      result_ = Result::kInvalid; return false;
    }
    return begin(now, address, data, writeCount, readCount);
  }
  uint8_t readData(uint8_t index) const {
    return index < readCount_ ? readBytes_[index] : 0U;
  }
  uint8_t readCount() const { return readCount_; }
  void service(uint32_t now) {
    if (!busy()) return;
    if (static_cast<uint32_t>(now - since_) >= kTimeoutMs) {
      // Reset only TWI, not timers/USART/ports. A stuck external bus stays an
      // explicit error; never bit-bang indefinitely or retry forever.
      hw_.reset(); phase_ = Phase::kIdle; result_ = Result::kTimeout;
      completionPending_ = true; return;
    }
    if (phase_ == Phase::kStop) {
      if (!hw_.stopping()) {
        phase_ = Phase::kIdle; result_ = completion_; completionPending_ = true;
      }
      return;
    }
    if (!hw_.ready()) return;
    const uint8_t status = hw_.status();
    if (status == 0x38U) {
      // Arbitration lost: release bus, do not STOP another master's transfer.
      hw_.reset(); phase_ = Phase::kIdle; result_ = Result::kArbitrationLost;
      completionPending_ = true; return;
    }
    if ((phase_ == Phase::kStart || phase_ == Phase::kRestart) &&
        (status == 0x08U || status == 0x10U)) {
      const bool reading = phase_ == Phase::kRestart;
      hw_.send(static_cast<uint8_t>((address_ << 1U) | (reading ? 1U : 0U)));
      phase_ = reading ? Phase::kAddressRead : Phase::kAddressWrite;
    } else if (phase_ == Phase::kAddressWrite && status == 0x18U) {
      hw_.send(writeBytes_[writeIndex_++]); phase_ = Phase::kWriteData;
    } else if (phase_ == Phase::kWriteData && status == 0x28U) {
      if (writeIndex_ < writeCount_) hw_.send(writeBytes_[writeIndex_++]);
      else if (readCount_ != 0U) { phase_ = Phase::kRestart; hw_.start(); }
      else finish(Result::kSuccess);
    } else if (phase_ == Phase::kAddressRead && status == 0x40U) {
      hw_.receive(readCount_ > 1U); phase_ = Phase::kReadData;
    } else if (phase_ == Phase::kReadData &&
               ((status == 0x50U && readIndex_ + 1U < readCount_) ||
                (status == 0x58U && readIndex_ + 1U == readCount_))) {
      readBytes_[readIndex_++] = hw_.read();
      if (readIndex_ < readCount_) hw_.receive(readIndex_ + 1U < readCount_);
      else finish(Result::kSuccess);
    } else if ((phase_ == Phase::kAddressWrite && status == 0x20U) ||
               (phase_ == Phase::kAddressRead && status == 0x48U)) {
      finish(Result::kAddressNack);
    } else if (phase_ == Phase::kWriteData && status == 0x30U) {
      finish(Result::kDataNack);
    } else finish(Result::kBusError);
  }
  bool busy() const { return phase_ != Phase::kIdle; }
  Result result() const { return result_; }
  bool completionPending() const { return completionPending_; }
  Result takeResult() {
    if (!completionPending_) return Result::kIdle;
    completionPending_ = false;
    return result_;
  }
 private:
  enum class Phase : uint8_t {
    kIdle, kStart, kAddressWrite, kWriteData, kRestart, kAddressRead,
    kReadData, kStop
  };
  bool begin(uint32_t now, uint8_t address, const uint8_t* data,
             uint8_t writeCount, uint8_t readCount) {
    if (busy() || completionPending_) return false;
    if (address < 0x08U || address > 0x77U || !data || !writeCount ||
        writeCount > kCapacity || readCount > kCapacity) {
      result_ = Result::kInvalid; return false;
    }
    memcpy(writeBytes_, data, writeCount);
    memset(readBytes_, 0, sizeof(readBytes_));
    address_ = address; writeCount_ = writeCount; readCount_ = readCount;
    writeIndex_ = readIndex_ = 0U;
    since_ = now; result_ = Result::kPending; phase_ = Phase::kStart;
    hw_.start(); return true;
  }
  void finish(Result result) {
    completion_ = result; phase_ = Phase::kStop; hw_.stop();
  }
  Hardware& hw_;
  uint32_t since_ = 0UL;
  uint8_t writeBytes_[kCapacity] = {};
  uint8_t readBytes_[kCapacity] = {};
  uint8_t address_ = 0U, writeCount_ = 0U, readCount_ = 0U;
  uint8_t writeIndex_ = 0U, readIndex_ = 0U;
  Phase phase_ = Phase::kIdle;
  Result result_ = Result::kIdle, completion_ = Result::kIdle;
  bool completionPending_ = false;
};

// Actual AVR adapter implemented separately so the same Master is host tested.
struct AvrHardware {
  void initialize();
  void start();
  void send(uint8_t value);
  void receive(bool acknowledge);
  uint8_t read() const;
  void stop();
  void reset();
  bool ready() const;
  bool stopping() const;
  uint8_t status() const;
};
} // namespace twi
} // namespace dental_atmega
