#pragma once
#include "hardware_config.h"
#include "physical_workflow.h"
#include "twi_master.h"
#include "../../firmware-common/include/rtc_link_protocol.h"
#include <stdio.h>
#include <string.h>

namespace dental_atmega {
namespace lcd {
constexpr uint8_t kColumns = 20U, kRows = 4U;
// Verified repository backpack map: RS=P0, RW=P1 (always LOW), E=P2,
// backlight=P3, D4..D7=P4..P7. This is not universal to every backpack.
inline void nibble(uint8_t value, bool data, uint8_t* out) {
  const uint8_t pins = (value & 0xF0U) | 0x08U | (data ? 0x01U : 0U);
  out[0] = pins; out[1] = pins | 0x04U; out[2] = pins;
}
inline void encode(uint8_t value, bool data, uint8_t* out) {
  nibble(value, data, out); nibble(static_cast<uint8_t>(value << 4U), data, out + 3U);
}
inline bool cursorCommand(uint8_t column, uint8_t row, uint8_t& command) {
  if (column >= kColumns || row >= kRows) return false;
  const uint8_t offsets[kRows] = {0x00U, 0x40U, 0x14U, 0x54U};
  command = 0x80U | static_cast<uint8_t>(offsets[row] + column); return true;
}
enum class State : uint8_t { kInitializing, kReady, kFailed };

template <typename Bus>
class Display {
 public:
  explicit Display(Bus& bus) : bus_(bus) {}
  void begin(uint32_t now) {
    state_ = State::kInitializing; operation_ = Operation::kNone;
    init_ = 0U; since_ = now; delay_ = 50U; pending_ = false;
    column_ = length_ = index_ = 0U;
    error_ = twi::Result::kIdle;
  }
  void service(uint32_t now) {
    bus_.service(now);
    if (state_ == State::kFailed) return;
    if (pending_) {
      if (bus_.busy()) return;
      const twi::Result result = bus_.takeResult();
      if (result != twi::Result::kSuccess) { fail(result); return; }
      pending_ = false; since_ = now;
      if (state_ == State::kInitializing) {
        // Reset expander, 3/3/3/2 nibble handshake, 28/08/01/06/0C commands.
        delay_ = init_ == 2U || init_ == 3U ? 5U : init_ == 8U ? 2U : 1U;
      }
      return;
    }
    // Another shared-bus client (currently the RTC) owns this transfer or its
    // completion. Defer rather than misclassifying normal serialization as an
    // LCD failure; the initiating client must consume its own completion.
    if (bus_.busy() || bus_.completionPending()) return;
    if (static_cast<uint32_t>(now - since_) < delay_) return;
    if (state_ == State::kInitializing) {
      if (init_ == 10U) { state_ = State::kReady; return; }
      uint8_t bytes[6] = {}; uint8_t count = 6U;
      if (init_ == 0U) { bytes[0] = 0x08U; count = 1U; }
      else if (init_ <= 4U) { nibble(init_ == 4U ? 0x20U : 0x30U, false, bytes); count = 3U; }
      else {
        const uint8_t commands[5] = {0x28U, 0x08U, 0x01U, 0x06U, 0x0CU};
        encode(commands[init_ - 5U], false, bytes);
      }
      ++init_; submit(now, bytes, count); return;
    }
    if (operation_ == Operation::kText && index_ < length_) {
      uint8_t bytes[6]; encode(static_cast<uint8_t>(text_[index_++]), true, bytes);
      delay_ = 1U; submit(now, bytes, 6U); return;
    }
    operation_ = Operation::kNone;
  }
  bool clear(uint32_t now) {
    if (!command(now, 0x01U, 2U)) return false;
    column_ = 0U; return true;
  }
  bool setCursor(uint32_t now, uint8_t column, uint8_t row) {
    uint8_t value;
    if (!cursorCommand(column, row, value) || !command(now, value, 1U)) return false;
    column_ = column; return true;
  }
  bool write(uint32_t now, const char* text, uint8_t length) {
    if (!available() || busy() || !text || !length || length > kColumns - column_) return false;
    for (uint8_t i = 0U; i < length; ++i) {
      if (static_cast<uint8_t>(text[i]) < 0x20U || static_cast<uint8_t>(text[i]) > 0x7EU) return false;
    }
    memcpy(text_, text, length); length_ = length; index_ = 0U;
    column_ += length; operation_ = Operation::kText; since_ = now; delay_ = 0U;
    return true;
  }
  bool available() const { return state_ == State::kReady; }
  bool busy() const {
    return state_ == State::kInitializing || pending_ ||
        operation_ != Operation::kNone || bus_.busy() ||
        bus_.completionPending();
  }
  State state() const { return state_; }
  twi::Result error() const { return error_; }
 private:
  enum class Operation : uint8_t { kNone, kCommand, kText };
  void fail(twi::Result error) {
    error_ = error; state_ = State::kFailed; pending_ = false; operation_ = Operation::kNone;
  }
  void submit(uint32_t now, const uint8_t* bytes, uint8_t count) {
    if (!bus_.write(now, hardware::kLcdAddress, bytes, count)) { fail(bus_.result()); return; }
    pending_ = true;
  }
  bool command(uint32_t now, uint8_t value, uint8_t delay) {
    if (!available() || busy()) return false;
    uint8_t bytes[6]; encode(value, false, bytes);
    operation_ = Operation::kCommand; delay_ = delay;
    submit(now, bytes, 6U); return state_ != State::kFailed;
  }
  Bus& bus_;
  char text_[kColumns] = {};
  uint32_t since_ = 0UL;
  uint8_t init_ = 0U, column_ = 0U, length_ = 0U, index_ = 0U, delay_ = 50U;
  bool pending_ = false;
  State state_ = State::kInitializing;
  Operation operation_ = Operation::kNone;
  twi::Result error_ = twi::Result::kIdle;
};

enum class Screen : uint8_t {
  kClock, kRtcNeedsSync, kRtcUnavailable, kRestockWait, kCheckoutWait
};
inline Screen screenFor(PhysicalState state, dental_link::rtc::State rtcState) {
  if (state == PhysicalState::kWaitingRestockScan) return Screen::kRestockWait;
  if (state == PhysicalState::kWaitingCheckoutScan) return Screen::kCheckoutWait;
  return rtcState == dental_link::rtc::State::kReady ? Screen::kClock :
      rtcState == dental_link::rtc::State::kNeedsSync ? Screen::kRtcNeedsSync :
      Screen::kRtcUnavailable;
}
inline void screenLine(Screen screen, uint8_t row,
                       const dental_link::rtc::DateTime& time, char* out) {
  char formatted[21] = {};
  const char* text = "";
  if (row == 0U) text = "Dental Inventory";
  else if (screen == Screen::kClock && row == 1U) {
    snprintf(formatted, sizeof(formatted), "%04u-%02u-%02u",
        static_cast<unsigned>(time.year), static_cast<unsigned>(time.month),
        static_cast<unsigned>(time.day));
    text = formatted;
  } else if (screen == Screen::kClock && row == 2U) {
    snprintf(formatted, sizeof(formatted), "%02u:%02u:%02u",
        static_cast<unsigned>(time.hour), static_cast<unsigned>(time.minute),
        static_cast<unsigned>(time.second));
    text = formatted;
  } else if (screen == Screen::kClock && row == 3U) text = "SYSTEM READY";
  else if (screen == Screen::kRtcNeedsSync && row == 1U)
    text = "RTC NEEDS SYNC";
  else if (screen == Screen::kRtcUnavailable && row == 1U)
    text = "RTC UNAVAILABLE";
  else if (row == 1U && (screen == Screen::kRestockWait ||
                         screen == Screen::kCheckoutWait))
    text = "ATmega Controller";
  else if (screen == Screen::kRestockWait && row == 2U)
    text = "RESTOCK WAIT";
  else if (screen == Screen::kCheckoutWait && row == 2U)
    text = "CHECKOUT WAIT";
  else if ((screen == Screen::kRtcNeedsSync ||
            screen == Screen::kRtcUnavailable) && row == 3U)
    text = "SYSTEM READY";
  memset(out, ' ', kColumns);
  for (uint8_t i = 0U; i < kColumns && text[i]; ++i) out[i] = text[i];
}

// Latest screen wins; one row at a time, no screen clears/flicker on updates.
// Failure is retained in Display::state/error and never gates PhysicalWorkflow.
class WorkflowScreen {
 public:
  template <typename Lcd>
  void service(uint32_t now, PhysicalState state,
               dental_link::rtc::State rtcState,
               const dental_link::rtc::DateTime& rtcTime, Lcd& display) {
    display.service(now);
    if (!display.available()) { started_ = false; return; }
    if (display.busy()) return;
    const Screen desired = screenFor(state, rtcState);
    if (!started_ || desired != screen_) {
      started_ = true; screen_ = desired; step_ = 0U; endStep_ = 8U;
      renderTime_ = rtcTime; renderedTimeValid_ = false;
    } else if (screen_ == Screen::kClock && step_ >= endStep_) {
      const uint32_t next = dental_link::rtc::secondsSince2000(rtcTime);
      if (!renderedTimeValid_ || next != renderedSeconds_) {
        renderTime_ = rtcTime;
        const bool dateChanged = !renderedTimeValid_ ||
            next / 86400UL != renderedSeconds_ / 86400UL;
        step_ = dateChanged ? 2U : 4U;
        endStep_ = 6U; // Update date when needed and time once per RTC second.
      }
    }
    if (step_ >= endStep_) return;
    const uint8_t row = step_ / 2U;
    if ((step_ & 1U) == 0U) {
      if (display.setCursor(now, 0U, row)) ++step_;
    } else {
      char text[kColumns]; screenLine(screen_, row, renderTime_, text);
      if (display.write(now, text, kColumns)) {
        ++step_;
        if (screen_ == Screen::kClock && step_ >= endStep_) {
          renderedSeconds_ = dental_link::rtc::secondsSince2000(renderTime_);
          renderedTimeValid_ = true;
        }
      }
    }
  }
 private:
  dental_link::rtc::DateTime renderTime_ = {};
  uint32_t renderedSeconds_ = 0UL;
  Screen screen_ = Screen::kRtcUnavailable;
  uint8_t step_ = 0U;
  uint8_t endStep_ = 8U;
  bool started_ = false;
  bool renderedTimeValid_ = false;
};
} // namespace lcd
} // namespace dental_atmega
