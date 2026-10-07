#pragma once
#include "hardware_config.h"
#include "physical_workflow.h"
#include "twi_master.h"
#include "../../firmware-common/include/rtc_link_protocol.h"
#include <string.h>
#ifdef __AVR__
#include <avr/pgmspace.h>
#define DENTAL_LCD_LITERAL(value) PSTR(value)
#else
#define DENTAL_LCD_LITERAL(value) value
#endif

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
  kReset, kClock, kRtcNeedsSync, kRtcUnavailable, kRestockWait, kCheckoutWait,
  kLinkError, kStorageError, kModeRejected, kModeBusy, kInitializing,
  kRestockCommitted, kCheckoutCommitted, kRestockOffline, kCheckoutOffline,
  kScanError, kScanDismissed, kUnknownBarcode
};
inline Screen feedbackScreen(dental_link::Frame frame) {
  switch (frame) {
    case dental_link::Frame::kRestockCommittedFeedback: return Screen::kRestockCommitted;
    case dental_link::Frame::kCheckoutCommittedFeedback: return Screen::kCheckoutCommitted;
    case dental_link::Frame::kRestockOfflineFeedback: return Screen::kRestockOffline;
    case dental_link::Frame::kCheckoutOfflineFeedback: return Screen::kCheckoutOffline;
    case dental_link::Frame::kScanErrorFeedback: return Screen::kScanError;
    case dental_link::Frame::kScanDismissedFeedback: return Screen::kScanDismissed;
    case dental_link::Frame::kUnknownBarcodeFeedback: return Screen::kUnknownBarcode;
    default: return Screen::kClock;
  }
}
inline Screen screenFor(PhysicalState state, dental_link::rtc::State rtcState) {
  if (state == PhysicalState::kDeliveryError) return Screen::kLinkError;
  if (state == PhysicalState::kStorageUnavailable) return Screen::kStorageError;
  if (state == PhysicalState::kModeRejected) return Screen::kModeRejected;
  if (state == PhysicalState::kModeBusy) return Screen::kModeBusy;
  if (state == PhysicalState::kInitializing) return Screen::kInitializing;
  if (state == PhysicalState::kWaitingRestockScan) return Screen::kRestockWait;
  if (state == PhysicalState::kWaitingCheckoutScan) return Screen::kCheckoutWait;
  return rtcState == dental_link::rtc::State::kReady ? Screen::kClock :
      rtcState == dental_link::rtc::State::kNeedsSync ? Screen::kRtcNeedsSync :
      Screen::kRtcUnavailable;
}
// Equivalent to unsigned decimal with minimum zero-padded width. The caller
// supplies a 20-column row; even uint16_t year + uint8_t fields fit. No varargs,
// temporary string, shared scratch, or pointers retained by this formatter.
inline uint8_t decimal(uint16_t value, uint8_t width, char* out) {
  uint16_t divisor = 1U;
  uint8_t digits = 1U;
  while (value / divisor >= 10U) { divisor *= 10U; ++digits; }
  uint8_t position = 0U;
  while (position + digits < width) out[position++] = '0';
  do {
    out[position++] = static_cast<char>('0' + value / divisor);
    value %= divisor; divisor /= 10U;
  } while (divisor != 0U);
  return position;
}
inline void screenLine(Screen screen, uint8_t row,
                       const dental_link::rtc::DateTime& time, char* out) {
  memset(out, ' ', kColumns);
  if (screen == Screen::kClock && (row == 1U || row == 2U)) {
    uint8_t position = decimal(row == 1U ? time.year : time.hour,
                               row == 1U ? 4U : 2U, out);
    out[position++] = row == 1U ? '-' : ':';
    position += decimal(row == 1U ? time.month : time.minute, 2U, out + position);
    out[position++] = row == 1U ? '-' : ':';
    decimal(row == 1U ? time.day : time.second, 2U, out + position);
    return;
  }
  const char* text = DENTAL_LCD_LITERAL("");
  if (screen == Screen::kReset) {
    if (row == 1U) text = DENTAL_LCD_LITERAL("    SYSTEM RESET");
    else if (row == 2U) text = DENTAL_LCD_LITERAL("  INITIALIZING...");
  } else if (row == 0U) text = DENTAL_LCD_LITERAL("Any Time Dental");
  else if (screen == Screen::kClock && row == 3U) text = DENTAL_LCD_LITERAL("SYSTEM READY");
  else if (screen == Screen::kRtcNeedsSync && row == 1U)
    text = DENTAL_LCD_LITERAL("RTC NEEDS SYNC");
  else if (screen == Screen::kRtcUnavailable && row == 1U)
    text = DENTAL_LCD_LITERAL("RTC UNAVAILABLE");
  else if (row == 1U && (screen == Screen::kRestockWait ||
                         screen == Screen::kCheckoutWait))
    text = DENTAL_LCD_LITERAL("READY TO SCAN");
  else if (screen == Screen::kRestockWait && row == 2U)
    text = DENTAL_LCD_LITERAL("RESTOCK MODE");
  else if (screen == Screen::kCheckoutWait && row == 2U)
    text = DENTAL_LCD_LITERAL("CHECKOUT MODE");
  else if (screen == Screen::kLinkError && row == 1U)
    text = DENTAL_LCD_LITERAL("CONTROLLER LINK ERROR");
  else if (screen == Screen::kLinkError && row == 2U)
    text = DENTAL_LCD_LITERAL("NO CONTROLLER REPLY");
  else if (screen == Screen::kStorageError && row == 1U)
    text = DENTAL_LCD_LITERAL("STORAGE UNAVAILABLE");
  else if (screen == Screen::kModeRejected && row == 1U)
    text = DENTAL_LCD_LITERAL("MODE REJECTED");
  else if (screen == Screen::kModeBusy && row == 1U)
    text = DENTAL_LCD_LITERAL("CONTROLLER BUSY");
  else if (screen == Screen::kInitializing && row == 1U)
    text = DENTAL_LCD_LITERAL("SYSTEM INITIALIZING");
  else if (screen == Screen::kInitializing && row == 2U)
    text = DENTAL_LCD_LITERAL("PLEASE WAIT");
  else if (screen == Screen::kRestockCommitted && row == 1U)
    text = DENTAL_LCD_LITERAL("RESTOCK SUCCESS");
  else if (screen == Screen::kCheckoutCommitted && row == 1U)
    text = DENTAL_LCD_LITERAL("CHECKOUT SUCCESS");
  else if (screen == Screen::kRestockOffline && row == 1U)
    text = DENTAL_LCD_LITERAL("OFFLINE RESTOCK");
  else if (screen == Screen::kCheckoutOffline && row == 1U)
    text = DENTAL_LCD_LITERAL("OFFLINE CHECKOUT");
  else if (screen == Screen::kScanError && row == 1U)
    text = DENTAL_LCD_LITERAL("TRANSACTION ERROR");
  else if (screen == Screen::kScanDismissed && row == 1U)
    text = DENTAL_LCD_LITERAL("SCAN DISMISSED");
  else if (screen == Screen::kUnknownBarcode && row == 1U)
    text = DENTAL_LCD_LITERAL("ITEM NOT FOUND");
  else if ((screen == Screen::kRestockCommitted ||
            screen == Screen::kCheckoutCommitted) && row == 2U)
    text = DENTAL_LCD_LITERAL("Inventory updated");
  else if ((screen == Screen::kRestockOffline ||
            screen == Screen::kCheckoutOffline) && row == 2U)
    text = DENTAL_LCD_LITERAL("Saved for sync");
  else if ((screen == Screen::kScanError ||
            screen == Screen::kScanDismissed ||
            screen == Screen::kUnknownBarcode) && row == 2U)
    text = DENTAL_LCD_LITERAL("No stock changed");
  else if ((screen == Screen::kRtcNeedsSync ||
            screen == Screen::kRtcUnavailable) && row == 3U)
    text = DENTAL_LCD_LITERAL("SYSTEM READY");
  for (uint8_t i = 0U; i < kColumns; ++i) {
#ifdef __AVR__
    const char character = static_cast<char>(pgm_read_byte(text + i));
#else
    const char character = text[i];
#endif
    if (!character) break;
    out[i] = character;
  }
}

// Latest screen wins; one row at a time, no screen clears/flicker on updates.
// Failure is retained in Display::state/error and never gates PhysicalWorkflow.
class WorkflowScreen {
 public:
  static constexpr uint32_t kFeedbackMs = 2500UL;
  static constexpr uint32_t kStartupResetMs = 1200UL;
  explicit WorkflowScreen(bool showStartupReset = true)
      : startupResetActive_(showStartupReset) {}
  void feedback(uint32_t now, dental_link::Frame frame) {
    const Screen incoming = feedbackScreen(frame);
    if (incoming == Screen::kClock) return;
    customActive_ = false;
    feedback_ = incoming;
    feedbackSince_ = now;
    feedbackActive_ = true;
  }
  // Advisory bounded rows only; never select a workflow or mutate stock.
  void displayFrame(uint32_t now, const char* payload) {
    if (!payload) return;
    if ((dental_link::text::compare(payload, DENTAL_LCD_LITERAL("P:R")) == 0 ||
         dental_link::text::compare(payload, DENTAL_LCD_LITERAL("P:C")) == 0 ||
         dental_link::text::compare(payload, DENTAL_LCD_LITERAL("S:R")) == 0 ||
         dental_link::text::compare(payload, DENTAL_LCD_LITERAL("S:C")) == 0)) {
      customActive_ = true; customProcessing_ = payload[0] == 'P';
      feedbackActive_ = false; customRows_ = 0U;
      memset(customText_, ' ', sizeof(customText_));
      if (customProcessing_) {
        setCustomConstant(0U, payload[2] == 'R' ? DENTAL_LCD_LITERAL("OFFLINE RESTOCK") : DENTAL_LCD_LITERAL("OFFLINE CHECKOUT"));
        setCustomConstant(1U, DENTAL_LCD_LITERAL("PROCESSING..."));
        setCustomConstant(3U, DENTAL_LCD_LITERAL("PLEASE WAIT"));
      }
      started_ = false; feedbackSince_ = now;
      return;
    }
    if (!customActive_ || payload[0] < '0' || payload[0] > '3' || payload[1] != ':') return;
    const size_t length = strlen(payload + 2);
    if (length > kColumns) return;
    for (size_t i = 0; i < length; ++i)
      if (payload[2 + i] < 0x20 || payload[2 + i] > 0x7E) return;
    const uint8_t row = payload[0] - '0';
    memset(customText_[row], ' ', kColumns);
    memcpy(customText_[row], payload + 2, length);
    customRows_ |= static_cast<uint8_t>(1U << row);
    started_ = false;
    if (customRows_ == 15U) feedbackSince_ = now;
  }
  template <typename Lcd>
  void service(uint32_t now, PhysicalState state,
                dental_link::rtc::State rtcState,
                const dental_link::rtc::DateTime& rtcTime, Lcd& display) {
    display.service(now);
    if (!display.available()) { started_ = false; return; }
    if (display.busy()) return;
    if (customActive_ && !customProcessing_ &&
        static_cast<uint32_t>(now - feedbackSince_) >= kFeedbackMs) {
      customActive_ = false; started_ = false;
    }
    Screen desired = screenFor(state, rtcState);
    if (feedbackActive_) {
      if (static_cast<uint32_t>(now - feedbackSince_) >= kFeedbackMs)
        feedbackActive_ = false;
      else if (state == PhysicalState::kIdle ||
               state == PhysicalState::kDispatching ||
               state == PhysicalState::kCooldown)
        desired = feedback_;
    }
    if (startupResetActive_) {
      // Render once after LCD initialization, then keep it visible without
      // blocking UART, RTC, scanner, buttons, or shared-TWI servicing.
      if (startupResetRendered_ &&
          static_cast<uint32_t>(now - startupResetSince_) >= kStartupResetMs)
        startupResetActive_ = false;
      else
        desired = Screen::kReset;
    }
    if (!started_ || (!customActive_ && desired != screen_)) {
      started_ = true; screen_ = desired; step_ = 0U; endStep_ = 8U;
      renderTime_ = rtcTime; renderedTimeValid_ = false;
    } else if (!customActive_ && screen_ == Screen::kClock && step_ >= endStep_) {
      const uint32_t next = dental_link::rtc::secondsSince2000(rtcTime);
      if (!renderedTimeValid_ || next != renderedSeconds_) {
        renderTime_ = rtcTime;
        const bool dateChanged = !renderedTimeValid_ ||
            next / 86400UL != renderedSeconds_ / 86400UL;
        step_ = dateChanged ? 2U : 4U;
        endStep_ = 6U; // Update date when needed and time once per RTC second.
      }
    }
    if (step_ >= endStep_) {
      if (screen_ == Screen::kReset && !startupResetRendered_) {
        startupResetRendered_ = true;
        startupResetSince_ = now;
      }
      return;
    }
    const uint8_t row = step_ / 2U;
    if ((step_ & 1U) == 0U) {
      if (display.setCursor(now, 0U, row)) ++step_;
    } else {
      char text[kColumns];
      if (customActive_) memcpy(text, customText_[row], kColumns);
      else screenLine(screen_, row, renderTime_, text);
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
  void setCustomConstant(uint8_t row, const char* text) {
    for (uint8_t column = 0U; column < kColumns; ++column) {
      const char character = dental_link::text::at(text, column);
      if (!character) break;
      customText_[row][column] = character;
    }
  }
  dental_link::rtc::DateTime renderTime_ = {};
  uint32_t renderedSeconds_ = 0UL;
  uint32_t feedbackSince_ = 0UL;
  uint32_t startupResetSince_ = 0UL;
  Screen screen_ = Screen::kRtcUnavailable;
  Screen feedback_ = Screen::kClock;
  uint8_t step_ = 0U;
  uint8_t endStep_ = 8U;
  bool started_ = false;
  bool renderedTimeValid_ = false;
  bool feedbackActive_ = false;
  bool startupResetActive_ = true;
  bool startupResetRendered_ = false;
  char customText_[4][kColumns] = {};
  uint8_t customRows_ = 0U;
  bool customActive_ = false, customProcessing_ = false;
};
} // namespace lcd
} // namespace dental_atmega
#undef DENTAL_LCD_LITERAL
