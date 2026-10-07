#pragma once

#include "hardware_config.h"
#include "scanner_capture.h"

namespace dental_atmega {

enum class PhysicalState : uint8_t {
  kIdle, kWaitingRestockScan, kWaitingCheckoutScan, kDispatching, kCooldown,
  kDeliveryError, kStorageUnavailable, kModeRejected, kModeBusy, kInitializing
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

// A button event is a separate controller frame from the later barcode. The
// leading LF recovers the peer parser from any interrupted earlier frame.
class ModeEventTransport {
 public:
  bool queue(dental_link::Frame frame) {
    const char* line = dental_link::modeLine(frame);
    if (active_ || line == nullptr) return false;
    line_ = line;
    position_ = 0U;
    active_ = true;
    recovering_ = false;
    return true;
  }

  template <typename Transmitter>
  void service(uint32_t now, PingClient& ping, Transmitter& tx) {
    if (!active_) {
      ping.service(now, tx);
      return;
    }
    if (ping.state() == LinkState::kSending) {
      ping.service(now, tx);
      return;
    }
    uint8_t byte;
    if (recovering_) byte = position_ == 0U ? 0U : '\n';
    else byte = position_ == 0U ? '\n' :
        static_cast<uint8_t>(dental_link::text::at(line_, position_ - 1U));
    if (!tx.tryWrite(byte)) return;
    ++position_;
    if ((recovering_ && position_ == 2U) ||
        (!recovering_ && position_ > 1U && byte == '\n')) {
      active_ = false;
      recovering_ = false;
      position_ = 0U;
      line_ = nullptr;
    }
  }

  void cancel() {
    if (!active_) return;
    if (position_ == 0U) {
      active_ = false;
      line_ = nullptr;
      return;
    }
    recovering_ = true;
    position_ = 0U;
    line_ = nullptr;
  }
  bool active() const { return active_; }

 private:
  const char* line_ = nullptr;
  uint8_t position_ = 0U;
  bool active_ = false;
  bool recovering_ = false;
};

// ATmega alone selects the physical operation. No stock/database/peripheral
// logic is moved here; one selected operation pairs with one captured barcode.
class PhysicalWorkflow {
 public:
  static constexpr uint32_t kScanTimeoutMs = 10000UL;
  static constexpr uint32_t kCooldownMs = 2000UL;
  static constexpr uint32_t kModeRetryMs = 1200UL;
  static constexpr uint8_t kMaximumModeAttempts = 3U;

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
    const dental_link::Frame mode = restockPress ?
        dental_link::Frame::kRestockMode : dental_link::Frame::kCheckoutMode;
    if (!modeEvent_.queue(mode)) return;
    pendingMode_ = mode;
    modeAttempts_ = 1U;
    modeAcknowledged_ = false;
    modeWaited_ = false;
    busyReplySeen_ = false;
    modeSentAt_ = now;
    state_ = restockPress ? PhysicalState::kWaitingRestockScan :
                           PhysicalState::kWaitingCheckoutScan;
    since_ = now;
    mustRelease_ = true;
    transport_.rejectPartialScan(); // Never promote an earlier partial scan.
  }

  void receive(uint32_t now, uint8_t byte, bool error = false) {
    expire(now);
    const dental_link::Frame frame = waiting() || state_ == PhysicalState::kIdle ?
        dental_link::Frame::kScan : dental_link::Frame::kNone;
    const ScanOutcome outcome = transport_.receive(now, byte, error, frame);
    if (outcome == ScanOutcome::kBarcode && waiting() && modeAcknowledged_)
      state_ = PhysicalState::kDispatching;
  }

  void modeResponse(uint32_t now, dental_link::Frame response) {
    if (!waiting() || pendingMode_ == dental_link::Frame::kNone) return;
    const bool accepted =
        (pendingMode_ == dental_link::Frame::kRestockMode &&
         response == dental_link::Frame::kRestockAccepted) ||
        (pendingMode_ == dental_link::Frame::kCheckoutMode &&
         response == dental_link::Frame::kCheckoutAccepted);
    if (accepted) {
      if (modeWaited_) since_ = now; // Do not consume scan time during protected waiting.
      modeAcknowledged_ = true;
      pendingMode_ = dental_link::Frame::kNone;
      if (transport_.active()) state_ = PhysicalState::kDispatching;
    } else if (response == dental_link::Frame::kModeWaiting) {
      // Explicit live-controller lease while an atomic replacement finishes.
      // No blocking wait; without further replies the existing retry/deadline
      // bounds still expire. Captured scans cannot leave before final OK.
      modeSentAt_ = since_ = now;
      modeWaited_ = true;
    } else if (response == dental_link::Frame::kModeInitializing) {
      failMode(now, PhysicalState::kInitializing);
    } else if (response == dental_link::Frame::kModeStorageUnavailable) {
      failMode(now, PhysicalState::kStorageUnavailable);
    } else if (response == dental_link::Frame::kModeRejected) {
      failMode(now, PhysicalState::kModeRejected);
    } else if (response == dental_link::Frame::kModeBusy) {
      // Busy is retryable; the bounded retry timer remains authoritative.
      busyReplySeen_ = true;
    }
  }

  template <typename Transmitter>
  void service(uint32_t now, PingClient& ping, Transmitter& tx) {
    expire(now);
    if (waiting() && !modeAcknowledged_ && !modeEvent_.active() &&
        static_cast<uint32_t>(now - modeSentAt_) >= kModeRetryMs) {
      if (modeAttempts_ >= kMaximumModeAttempts)
        failMode(now, busyReplySeen_ ? PhysicalState::kModeBusy :
                                              PhysicalState::kDeliveryError);
      else if (modeEvent_.queue(pendingMode_)) {
        ++modeAttempts_;
        modeSentAt_ = now;
      }
    }
    if (modeEvent_.active()) {
      modeEvent_.service(now, ping, tx);
      if (!modeEvent_.active()) modeSentAt_ = now;
      return;
    }
    if (waiting() && !modeAcknowledged_) {
      ping.service(now, tx);
      return; // Never forward a barcode before mode acceptance.
    }
    transport_.service(now, ping, tx);
    if (state_ == PhysicalState::kDispatching && !transport_.active()) {
      state_ = PhysicalState::kCooldown; since_ = now;
    }
  }
  PhysicalState state() const { return state_; }
  bool controllerTransmissionActive() const {
    return modeEvent_.active() || transport_.active();
  }
  bool modeAcknowledged() const { return modeAcknowledged_; }
  uint8_t modeAttempts() const { return modeAttempts_; }

 private:
  bool waiting() const {
    return state_ == PhysicalState::kWaitingRestockScan ||
           state_ == PhysicalState::kWaitingCheckoutScan;
  }
  void cancelWait() {
    state_ = PhysicalState::kIdle;
    mustRelease_ = true;
    modeEvent_.cancel();
    pendingMode_ = dental_link::Frame::kNone;
    modeAcknowledged_ = false;
    transport_.cancelPending();
  }
  void failMode(uint32_t now, PhysicalState failure) {
    cancelWait();
    state_ = failure;
    since_ = now;
  }
  void expire(uint32_t now) {
    if (waiting() && static_cast<uint32_t>(now - since_) >= kScanTimeoutMs) cancelWait();
    if (state_ == PhysicalState::kCooldown &&
        static_cast<uint32_t>(now - since_) >= kCooldownMs) state_ = PhysicalState::kIdle;
    if ((state_ == PhysicalState::kDeliveryError ||
         state_ == PhysicalState::kStorageUnavailable ||
         state_ == PhysicalState::kModeRejected ||
         state_ == PhysicalState::kModeBusy) &&
        static_cast<uint32_t>(now - since_) >= kCooldownMs) state_ = PhysicalState::kIdle;
    if (state_ == PhysicalState::kInitializing &&
        static_cast<uint32_t>(now - since_) >= kCooldownMs) state_ = PhysicalState::kIdle;
  }
  ScannerTransport transport_;
  ModeEventTransport modeEvent_;
  DebouncedInput restock_;
  DebouncedInput checkout_;
  uint32_t since_ = 0UL;
  uint32_t modeSentAt_ = 0UL;
  dental_link::Frame pendingMode_ = dental_link::Frame::kNone;
  uint8_t modeAttempts_ = 0U;
  bool modeAcknowledged_ = false;
  bool modeWaited_ = false;
  bool busyReplySeen_ = false;
  PhysicalState state_ = PhysicalState::kIdle;
  bool mustRelease_ = true; // Boot/held input must first be released.
};

}  // namespace dental_atmega
