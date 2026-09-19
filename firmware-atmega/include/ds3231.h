#pragma once

#include "../../firmware-common/include/rtc_link_protocol.h"
#include "twi_master.h"
#include <stdint.h>

namespace dental_atmega {
namespace ds3231 {

constexpr uint8_t kAddress = 0x68U;
constexpr uint8_t kStatusRegister = 0x0FU;
constexpr uint8_t kOscillatorStopFlag = 0x80U;

inline bool decodeBcd(uint8_t encoded, uint8_t maximum, uint8_t& value) {
  const uint8_t high = static_cast<uint8_t>((encoded >> 4U) & 0x0FU);
  const uint8_t low = static_cast<uint8_t>(encoded & 0x0FU);
  if (high > 9U || low > 9U) return false;
  value = static_cast<uint8_t>(high * 10U + low);
  return value <= maximum;
}

inline uint8_t encodeBcd(uint8_t value) {
  return static_cast<uint8_t>((value / 10U) << 4U) |
      static_cast<uint8_t>(value % 10U);
}

inline bool decodeTime(const uint8_t* registers,
                       dental_link::rtc::DateTime& value) {
  if (!registers) return false;
  uint8_t second, minute, hour, day, month, year;
  if (!decodeBcd(registers[0] & 0x7FU, 59U, second) ||
      !decodeBcd(registers[1] & 0x7FU, 59U, minute)) return false;
  if ((registers[2] & 0x40U) != 0U) {
    uint8_t twelveHour;
    if (!decodeBcd(registers[2] & 0x1FU, 12U, twelveHour) || twelveHour == 0U)
      return false;
    hour = static_cast<uint8_t>(twelveHour % 12U);
    if ((registers[2] & 0x20U) != 0U) hour = static_cast<uint8_t>(hour + 12U);
  } else if (!decodeBcd(registers[2] & 0x3FU, 23U, hour)) {
    return false;
  }
  uint8_t weekday;
  if (!decodeBcd(registers[3] & 0x07U, 7U, weekday) || weekday == 0U ||
      !decodeBcd(registers[4] & 0x3FU, 31U, day) ||
      (registers[5] & 0x80U) != 0U ||
      !decodeBcd(registers[5] & 0x1FU, 12U, month) || month == 0U ||
      !decodeBcd(registers[6], 99U, year)) return false;
  value = {static_cast<uint16_t>(2000U + year), month, day, hour, minute, second};
  return dental_link::rtc::valid(value);
}

inline void encodeTime(const dental_link::rtc::DateTime& value,
                       uint8_t* registers) {
  registers[0] = 0x00U;
  registers[1] = encodeBcd(value.second);
  registers[2] = encodeBcd(value.minute);
  registers[3] = encodeBcd(value.hour); // Explicit DS3231 24-hour mode.
  registers[4] = encodeBcd(dental_link::rtc::dayOfWeek(value));
  registers[5] = encodeBcd(value.day);
  registers[6] = encodeBcd(value.month); // Century bit clear: 2000..2099.
  registers[7] = encodeBcd(static_cast<uint8_t>(value.year - 2000U));
}

enum class Operation : uint8_t {
  kIdle,
  kInitialStatus,
  kInitialTime,
  kReadStatus,
  kReadTime,
  kWriteTime,
  kClearOscillatorStop,
  kVerifyStatus,
  kVerifyTime,
};

template <typename Bus>
class Driver {
 public:
  explicit Driver(Bus& bus) : bus_(bus) {}

  void begin() {
    state_ = dental_link::rtc::State::kUnavailable;
    reason_ = dental_link::rtc::Reason::kCommunicationFailure;
    operation_ = Operation::kInitialStatus;
    waiting_ = false;
  }

  void service(uint32_t now) {
    bus_.service(now);
    if (waiting_) {
      if (bus_.busy()) return;
      waiting_ = false;
      const twi::Result result = bus_.takeResult();
      if (result != twi::Result::kSuccess) { communicationFailure(); return; }
      completeOperation();
    }
    if (operation_ == Operation::kIdle || waiting_ || bus_.busy() ||
        bus_.completionPending()) return;
    submit(now);
  }

  dental_link::rtc::State state() const { return state_; }
  dental_link::rtc::Reason reason() const { return reason_; }
  const dental_link::rtc::DateTime& time() const { return time_; }
  bool idle() const { return operation_ == Operation::kIdle && !waiting_; }
  uint16_t readSequence() const { return readSequence_; }
  uint16_t syncSequence() const { return syncSequence_; }
  bool lastReadSucceeded() const { return lastReadSucceeded_; }
  bool lastSyncSucceeded() const { return lastSyncSucceeded_; }

  bool requestRead() {
    if (!idle() || state_ != dental_link::rtc::State::kReady) return false;
    lastReadSucceeded_ = false;
    operation_ = Operation::kReadStatus;
    return true;
  }

  bool requestSync(const dental_link::rtc::DateTime& value) {
    if (!idle() || state_ == dental_link::rtc::State::kUnavailable ||
        !dental_link::rtc::valid(value)) return false;
    target_ = value;
    lastSyncSucceeded_ = false;
    operation_ = Operation::kWriteTime;
    return true;
  }

 private:
  void submit(uint32_t now) {
    uint8_t registerAddress;
    bool accepted = false;
    switch (operation_) {
      case Operation::kInitialStatus:
      case Operation::kReadStatus:
      case Operation::kVerifyStatus:
        registerAddress = kStatusRegister;
        accepted = bus_.writeRead(now, kAddress, &registerAddress, 1U, 1U);
        break;
      case Operation::kInitialTime:
      case Operation::kReadTime:
      case Operation::kVerifyTime:
        registerAddress = 0x00U;
        accepted = bus_.writeRead(now, kAddress, &registerAddress, 1U, 7U);
        break;
      case Operation::kWriteTime:
        encodeTime(target_, writeBuffer_);
        accepted = bus_.write(now, kAddress, writeBuffer_, 8U);
        break;
      case Operation::kClearOscillatorStop:
        writeBuffer_[0] = kStatusRegister;
        writeBuffer_[1] = static_cast<uint8_t>(status_ & ~kOscillatorStopFlag);
        accepted = bus_.write(now, kAddress, writeBuffer_, 2U);
        break;
      case Operation::kIdle: return;
    }
    waiting_ = accepted;
  }

  void completeOperation() {
    switch (operation_) {
      case Operation::kInitialStatus:
        status_ = bus_.readData(0U);
        if ((status_ & kOscillatorStopFlag) != 0U) {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kLostPower;
          operation_ = Operation::kIdle;
        } else operation_ = Operation::kInitialTime;
        break;
      case Operation::kInitialTime:
        if (readTime(time_)) setReady();
        else {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kInvalidTime;
        }
        operation_ = Operation::kIdle;
        break;
      case Operation::kReadStatus:
        status_ = bus_.readData(0U);
        if ((status_ & kOscillatorStopFlag) != 0U) {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kLostPower;
          finishRead(false);
        } else operation_ = Operation::kReadTime;
        break;
      case Operation::kReadTime:
        if (readTime(time_)) { setReady(); finishRead(true); }
        else {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kInvalidTime;
          finishRead(false);
        }
        break;
      case Operation::kWriteTime:
        operation_ = Operation::kClearOscillatorStop;
        break;
      case Operation::kClearOscillatorStop:
        operation_ = Operation::kVerifyStatus;
        break;
      case Operation::kVerifyStatus:
        status_ = bus_.readData(0U);
        if ((status_ & kOscillatorStopFlag) != 0U) {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kLostPower;
          finishSync(false);
        } else operation_ = Operation::kVerifyTime;
        break;
      case Operation::kVerifyTime: {
        dental_link::rtc::DateTime observed;
        if (!readTime(observed)) {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kVerificationFailed;
          finishSync(false);
          break;
        }
        const uint32_t requested = dental_link::rtc::secondsSince2000(target_);
        const uint32_t actual = dental_link::rtc::secondsSince2000(observed);
        if (actual < requested || actual - requested > 2UL) {
          state_ = dental_link::rtc::State::kNeedsSync;
          reason_ = dental_link::rtc::Reason::kVerificationFailed;
          finishSync(false);
        } else {
          time_ = observed; setReady(); finishSync(true);
        }
        break;
      }
      case Operation::kIdle: break;
    }
  }

  bool readTime(dental_link::rtc::DateTime& output) const {
    uint8_t values[7];
    for (uint8_t i = 0U; i < 7U; ++i) values[i] = bus_.readData(i);
    return decodeTime(values, output);
  }
  void setReady() {
    state_ = dental_link::rtc::State::kReady;
    reason_ = dental_link::rtc::Reason::kNone;
  }
  void finishRead(bool success) {
    lastReadSucceeded_ = success; ++readSequence_; operation_ = Operation::kIdle;
  }
  void finishSync(bool success) {
    lastSyncSucceeded_ = success; ++syncSequence_; operation_ = Operation::kIdle;
  }
  void communicationFailure() {
    state_ = dental_link::rtc::State::kUnavailable;
    reason_ = dental_link::rtc::Reason::kCommunicationFailure;
    if (operation_ == Operation::kReadStatus || operation_ == Operation::kReadTime)
      finishRead(false);
    else if (operation_ == Operation::kWriteTime ||
             operation_ == Operation::kClearOscillatorStop ||
             operation_ == Operation::kVerifyStatus ||
             operation_ == Operation::kVerifyTime) finishSync(false);
    else operation_ = Operation::kIdle;
  }

  Bus& bus_;
  dental_link::rtc::DateTime time_ = {};
  dental_link::rtc::DateTime target_ = {};
  uint8_t writeBuffer_[8] = {};
  uint8_t status_ = 0U;
  uint16_t readSequence_ = 0U;
  uint16_t syncSequence_ = 0U;
  dental_link::rtc::State state_ = dental_link::rtc::State::kUnavailable;
  dental_link::rtc::Reason reason_ = dental_link::rtc::Reason::kCommunicationFailure;
  Operation operation_ = Operation::kIdle;
  bool waiting_ = false;
  bool lastReadSucceeded_ = false;
  bool lastSyncSucceeded_ = false;
};

}  // namespace ds3231
}  // namespace dental_atmega
