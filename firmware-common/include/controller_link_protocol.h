#pragma once

#include <stdint.h>
#include <string.h>
#include "immutable_text.h"

namespace dental_link {

constexpr uint32_t kBaud = 9600UL;
constexpr char kPing[] DENTAL_FLASH_STORAGE = "PING\n";
constexpr char kPong[] DENTAL_FLASH_STORAGE = "PONG\n";
constexpr uint8_t kMaximumBarcodeLength = 64U;
constexpr char kScanPrefix[] DENTAL_FLASH_STORAGE = "SCAN:";
constexpr char kRestockPrefix[] DENTAL_FLASH_STORAGE = "RESTOCK:";
constexpr char kCheckoutPrefix[] DENTAL_FLASH_STORAGE = "CHECKOUT:";
constexpr char kRestockMode[] DENTAL_FLASH_STORAGE = "BTN:RESTOCK\n";
constexpr char kCheckoutMode[] DENTAL_FLASH_STORAGE = "BTN:CHECKOUT\n";
constexpr char kRestockAccepted[] DENTAL_FLASH_STORAGE = "BTN:OK:RESTOCK\n";
constexpr char kCheckoutAccepted[] DENTAL_FLASH_STORAGE = "BTN:OK:CHECKOUT\n";
constexpr char kModeBusy[] DENTAL_FLASH_STORAGE = "BTN:BUSY\n";
constexpr char kModeRejected[] DENTAL_FLASH_STORAGE = "BTN:REJECT\n";
constexpr char kModeStorageUnavailable[] DENTAL_FLASH_STORAGE = "BTN:REJECT:STORAGE\n";
constexpr char kModeInitializing[] DENTAL_FLASH_STORAGE = "BTN:INITIALIZING\n";
constexpr char kModeWaiting[] DENTAL_FLASH_STORAGE = "BTN:WAIT\n";
// Display-only feedback after the existing online commit or offline journal
// commit. These short frames never select a transaction mode or carry stock.
constexpr char kRestockCommittedFeedback[] DENTAL_FLASH_STORAGE = "FB:RESTOCK:OK\n";
constexpr char kCheckoutCommittedFeedback[] DENTAL_FLASH_STORAGE = "FB:CHECKOUT:OK\n";
constexpr char kRestockOfflineFeedback[] DENTAL_FLASH_STORAGE = "FB:RESTOCK:OFF\n";
constexpr char kCheckoutOfflineFeedback[] DENTAL_FLASH_STORAGE = "FB:CHECKOUT:OFF\n";
constexpr char kScanErrorFeedback[] DENTAL_FLASH_STORAGE = "FB:SCAN:ERROR\n";
constexpr char kScanDismissedFeedback[] DENTAL_FLASH_STORAGE = "FB:SCAN:DISMISSED\n";
constexpr char kUnknownBarcodeFeedback[] DENTAL_FLASH_STORAGE = "FB:ITEM:UNKNOWN\n";
// Advisory LED stock state from an authoritative online result or a durably
// saved offline row. These frames cannot select a mode or mutate inventory.
constexpr char kStockHighFeedback[] DENTAL_FLASH_STORAGE = "STOCK:H\n";
constexpr char kStockLowFeedback[] DENTAL_FLASH_STORAGE = "STOCK:L\n";
constexpr char kStockEmptyFeedback[] DENTAL_FLASH_STORAGE = "STOCK:E\n";
constexpr char kRtcStatusRequest[] DENTAL_FLASH_STORAGE = "RTC_STATUS?\n";
constexpr char kRtcTimeRequest[] DENTAL_FLASH_STORAGE = "RTC_TIME?\n";
constexpr char kRtcStatusPrefix[] DENTAL_FLASH_STORAGE = "RTC_STATUS:";
constexpr char kRtcTimePrefix[] DENTAL_FLASH_STORAGE = "RTC_TIME:";
constexpr char kRtcSyncPrefix[] DENTAL_FLASH_STORAGE = "RTC_SYNC:";
constexpr char kRtcSyncResultPrefix[] DENTAL_FLASH_STORAGE = "RTC_SYNCED:";
constexpr uint8_t kMaximumLineLength = 9U + kMaximumBarcodeLength;

inline bool validBarcode(const char* text, uint8_t length) {
  if (length == 0U || length > kMaximumBarcodeLength) return false;
  bool visible = false;
  for (uint8_t i = 0U; i < length; ++i) {
    const uint8_t byte = static_cast<uint8_t>(text[i]);
    if (byte < 0x20U || byte > 0x7EU) return false;
    if (byte != ' ') visible = true;
  }
  return visible;
}

enum class Frame : uint8_t {
  kNone, kPing, kPong, kScan, kRestock, kCheckout,
  kRestockMode, kCheckoutMode,
  kRestockAccepted, kCheckoutAccepted, kModeBusy, kModeRejected,
  kModeStorageUnavailable, kModeInitializing, kModeWaiting,
  kRestockCommittedFeedback, kCheckoutCommittedFeedback,
  kRestockOfflineFeedback, kCheckoutOfflineFeedback,
  kScanErrorFeedback, kScanDismissedFeedback, kUnknownBarcodeFeedback,
  kStockHighFeedback, kStockLowFeedback, kStockEmptyFeedback,
  kRtcStatusRequest, kRtcStatus, kRtcTimeRequest, kRtcTime, kRtcSync,
  kRtcSyncResult, kRejected, kLcdDisplay
};

inline Frame operationForMode(Frame frame) {
  return frame == Frame::kRestockMode ? Frame::kRestock :
      frame == Frame::kCheckoutMode ? Frame::kCheckout : Frame::kNone;
}

inline const char* modeLine(Frame frame) {
  return frame == Frame::kRestockMode ? kRestockMode :
      frame == Frame::kCheckoutMode ? kCheckoutMode : nullptr;
}

inline const char* barcodePrefix(Frame frame) {
  return frame == Frame::kScan ? kScanPrefix :
      frame == Frame::kRestock ? kRestockPrefix :
      frame == Frame::kCheckout ? kCheckoutPrefix : nullptr;
}

// Fixed storage; a bad/oversized frame is discarded through its next LF.
template <uint8_t Capacity>
class BasicLineParser {
 public:
  static_assert(Capacity >= 18U && Capacity <= kMaximumLineLength,
                "Controller line parser capacity must fit mode replies");
  void reset() { length_ = 0U; rejected_ = false; carriageReturn_ = false; }
  void rejectUntilNewline() { rejected_ = true; }
  // Read immediately after kScan; next receive may overwrite this storage.
  const char* barcode() const { return buffer_ + barcodeOffset_; }
  // Read immediately after a payload-bearing RTC frame.
  const char* payload() const { return buffer_ + payloadOffset_; }

  Frame receive(uint8_t byte) {
    if (byte == '\n') {
      Frame frame = Frame::kRejected;
      if (!rejected_) {
        buffer_[length_] = '\0';
        if (length_ == 0U) frame = Frame::kNone;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("PING")) == 0) frame = Frame::kPing;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("PONG")) == 0) frame = Frame::kPong;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:RESTOCK")) == 0) frame = Frame::kRestockMode;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:CHECKOUT")) == 0) frame = Frame::kCheckoutMode;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:OK:RESTOCK")) == 0) frame = Frame::kRestockAccepted;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:OK:CHECKOUT")) == 0) frame = Frame::kCheckoutAccepted;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:BUSY")) == 0) frame = Frame::kModeBusy;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:REJECT")) == 0) frame = Frame::kModeRejected;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:REJECT:STORAGE")) == 0)
          frame = Frame::kModeStorageUnavailable;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:INITIALIZING")) == 0)
          frame = Frame::kModeInitializing;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("BTN:WAIT")) == 0)
          frame = Frame::kModeWaiting;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:RESTOCK:OK")) == 0)
          frame = Frame::kRestockCommittedFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:CHECKOUT:OK")) == 0)
          frame = Frame::kCheckoutCommittedFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:RESTOCK:OFF")) == 0)
          frame = Frame::kRestockOfflineFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:CHECKOUT:OFF")) == 0)
          frame = Frame::kCheckoutOfflineFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:SCAN:ERROR")) == 0)
          frame = Frame::kScanErrorFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:SCAN:DISMISSED")) == 0)
          frame = Frame::kScanDismissedFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("FB:ITEM:UNKNOWN")) == 0)
          frame = Frame::kUnknownBarcodeFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("STOCK:H")) == 0)
          frame = Frame::kStockHighFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("STOCK:L")) == 0)
          frame = Frame::kStockLowFeedback;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("STOCK:E")) == 0)
          frame = Frame::kStockEmptyFeedback;
        else if (matchesPayloadPrefix(DENTAL_TEXT_LITERAL("LCD:"), 4U))
          frame = Frame::kLcdDisplay;
        else if (matchesBarcodePrefix(kScanPrefix, 5U)) frame = Frame::kScan;
        else if (matchesBarcodePrefix(kRestockPrefix, 8U)) frame = Frame::kRestock;
        else if (matchesBarcodePrefix(kCheckoutPrefix, 9U)) frame = Frame::kCheckout;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("RTC_STATUS?")) == 0) frame = Frame::kRtcStatusRequest;
        else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("RTC_TIME?")) == 0) frame = Frame::kRtcTimeRequest;
        else if (matchesPayloadPrefix(kRtcStatusPrefix, 11U)) frame = Frame::kRtcStatus;
        else if (matchesPayloadPrefix(kRtcTimePrefix, 9U)) frame = Frame::kRtcTime;
        else if (matchesPayloadPrefix(kRtcSyncPrefix, 9U)) frame = Frame::kRtcSync;
        else if (matchesPayloadPrefix(kRtcSyncResultPrefix, 11U)) frame = Frame::kRtcSyncResult;
      }
      reset();
      return frame;
    }
    if (rejected_) return Frame::kNone;
    if (byte == '\r' && !carriageReturn_) {
      carriageReturn_ = true;
      return Frame::kNone;
    }
    if (carriageReturn_ || byte < 0x20U || byte > 0x7EU ||
        length_ == Capacity) {
      rejected_ = true;
      return Frame::kNone;
    }
    buffer_[length_++] = static_cast<char>(byte);
    return Frame::kNone;
  }

 private:
  bool matchesBarcodePrefix(const char* prefix, uint8_t offset) {
    if (length_ <= offset || text::compare(buffer_, prefix, offset) != 0 ||
        !validBarcode(buffer_ + offset, length_ - offset)) return false;
    barcodeOffset_ = offset;
    return true;
  }
  bool matchesPayloadPrefix(const char* prefix, uint8_t offset) {
    if (length_ <= offset || text::compare(buffer_, prefix, offset) != 0) return false;
    payloadOffset_ = offset;
    return true;
  }
  char buffer_[Capacity + 1U] = {};
  uint8_t barcodeOffset_ = 0U;
  uint8_t payloadOffset_ = 0U;
  uint8_t length_ = 0U;
  bool rejected_ = false;
  bool carriageReturn_ = false;
};

using LineParser = BasicLineParser<kMaximumLineLength>;

}  // namespace dental_link
