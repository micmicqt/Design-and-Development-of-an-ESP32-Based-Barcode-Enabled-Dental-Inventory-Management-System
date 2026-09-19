#pragma once

#include "hardware_config.h"
#include "scanner_capture.h"

namespace dental_atmega {

enum class PhysicalState : uint8_t {
  kIdle, kWaitingRestockScan, kWaitingCheckoutScan, kDispatching, kCooldown
};

class DebouncedInput {
 public:
  static constexpr uint32_t kDebounceMs = 50UL;
  bool update(uint32_t now, bool pressed) {
    if (!initialized_) {
      initialized_ = true; raw_ = stable_ = pressed; changed_ = now; return false;
    }
    if (pressed != raw_) { raw_ = pressed; changed_ = now; }
    if (raw_ != stable_ && static_cast<uint32_t>(now - changed_) >= kDebounceMs) {
      stable_ = raw_; return stable_;
    }
    return false;
  }
  bool released() const { return !raw_ && !stable_; }
 private:
  uint32_t changed_ = 0UL;
  bool initialized_ = false;
  bool raw_ = false;
  bool stable_ = false;
};

// ATmega alone selects the physical operation. No stock/database/peripheral
// logic is moved here; one selected operation pairs with one captured barcode.
class PhysicalWorkflow {
 public:
  static constexpr uint32_t kScanTimeoutMs = 10000UL;
  static constexpr uint32_t kCooldownMs = 2000UL;

  void buttons(uint32_t now, bool restockPressed, bool checkoutPressed) {
    expire(now);
    const bool restockPress = restock_.update(now, restockPressed);
    const bool checkoutPress = checkout_.update(now, checkoutPressed);
    if (restockPressed && checkoutPressed) {
      mustRelease_ = true;
      if (waiting()) cancelWait();
      return; // Reject simultaneous input, never guess an operation.
    }
    if (state_ != PhysicalState::kIdle || transport_.active()) {
      if (restockPressed || checkoutPressed) mustRelease_ = true;
      return; // Busy presses are not deferred or replayed.
    }
    if (mustRelease_) {
      if (restock_.released() && checkout_.released()) mustRelease_ = false;
      return;
    }
    if (restockPress == checkoutPress) return;
    if (restockPress && !checkout_.released()) return;
    if (checkoutPress && !restock_.released()) return;
    state_ = restockPress ? PhysicalState::kWaitingRestockScan :
                           PhysicalState::kWaitingCheckoutScan;
    since_ = now;
    mustRelease_ = true;
    transport_.rejectPartialScan(); // Never promote an earlier partial scan.
  }

  void receive(uint32_t now, uint8_t byte, bool error = false) {
    expire(now);
    const dental_link::Frame frame = state_ == PhysicalState::kWaitingRestockScan ?
        dental_link::Frame::kRestock : state_ == PhysicalState::kWaitingCheckoutScan ?
        dental_link::Frame::kCheckout : state_ == PhysicalState::kIdle ?
        dental_link::Frame::kScan : dental_link::Frame::kNone;
    const ScanOutcome outcome = transport_.receive(now, byte, error, frame);
    if (outcome == ScanOutcome::kBarcode && waiting()) state_ = PhysicalState::kDispatching;
  }

  template <typename Transmitter>
  void service(uint32_t now, PingClient& ping, Transmitter& tx) {
    expire(now);
    transport_.service(now, ping, tx);
    if (state_ == PhysicalState::kDispatching && !transport_.active()) {
      state_ = PhysicalState::kCooldown; since_ = now;
    }
  }
  PhysicalState state() const { return state_; }

 private:
  bool waiting() const {
    return state_ == PhysicalState::kWaitingRestockScan ||
           state_ == PhysicalState::kWaitingCheckoutScan;
  }
  void cancelWait() {
    state_ = PhysicalState::kIdle; mustRelease_ = true; transport_.rejectPartialScan();
  }
  void expire(uint32_t now) {
    if (waiting() && static_cast<uint32_t>(now - since_) >= kScanTimeoutMs) cancelWait();
    if (state_ == PhysicalState::kCooldown &&
        static_cast<uint32_t>(now - since_) >= kCooldownMs) state_ = PhysicalState::kIdle;
  }
  ScannerTransport transport_;
  DebouncedInput restock_;
  DebouncedInput checkout_;
  uint32_t since_ = 0UL;
  PhysicalState state_ = PhysicalState::kIdle;
  bool mustRelease_ = true; // Boot/held input must first be released.
};

}  // namespace dental_atmega
