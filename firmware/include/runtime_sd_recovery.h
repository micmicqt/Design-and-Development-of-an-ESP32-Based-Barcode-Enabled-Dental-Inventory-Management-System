#pragma once

#include <stdint.h>

namespace dental {
namespace storage {

// Driven only from the outer application loop, never from FatFs disk callbacks.
class RuntimeSdRecovery {
 public:
  enum class State : uint8_t { kReady, kUnavailable, kRecovering, kExhausted };
  static constexpr uint32_t kInitialDelayMs = 3000UL;
  static constexpr uint32_t kRetryCooldownMs = 30000UL;
  static constexpr uint8_t kMaximumAttempts = 2U;

  void unavailable(uint32_t now) {
    if (state_ != State::kReady) return;
    state_ = State::kUnavailable;
    nextAttemptAt_ = now + kInitialDelayMs;
    attempts_ = 0U;
  }
  void ready() { state_ = State::kReady; attempts_ = 0U; }
  bool due(uint32_t now, bool safe) const {
    return safe && state_ == State::kUnavailable &&
           static_cast<int32_t>(now - nextAttemptAt_) >= 0;
  }
  void begin() { state_ = State::kRecovering; ++attempts_; }
  void finish(uint32_t now, bool success) {
    if (success) { ready(); return; }
    if (attempts_ >= kMaximumAttempts) state_ = State::kExhausted;
    else { state_ = State::kUnavailable; nextAttemptAt_ = now + kRetryCooldownMs; }
  }
  State state() const { return state_; }
  uint8_t attempts() const { return attempts_; }

 private:
  uint32_t nextAttemptAt_ = 0UL;
  uint8_t attempts_ = 0U;
  State state_ = State::kReady;
};

}  // namespace storage
}  // namespace dental
