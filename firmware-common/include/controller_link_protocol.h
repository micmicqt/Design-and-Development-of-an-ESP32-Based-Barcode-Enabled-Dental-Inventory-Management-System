#pragma once

#include <stdint.h>
#include <string.h>

namespace dental_link {

constexpr uint32_t kBaud = 9600UL;
constexpr char kPing[] = "PING\n";
constexpr char kPong[] = "PONG\n";
constexpr uint8_t kMaximumBarcodeLength = 64U;
constexpr char kScanPrefix[] = "SCAN:";
constexpr char kRestockPrefix[] = "RESTOCK:";
constexpr char kCheckoutPrefix[] = "CHECKOUT:";
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

enum class Frame : uint8_t { kNone, kPing, kPong, kScan, kRestock, kCheckout, kRejected };

inline const char* barcodePrefix(Frame frame) {
  return frame == Frame::kScan ? kScanPrefix :
      frame == Frame::kRestock ? kRestockPrefix :
      frame == Frame::kCheckout ? kCheckoutPrefix : nullptr;
}

// Fixed storage; a bad/oversized frame is discarded through its next LF.
class LineParser {
 public:
  void reset() { length_ = 0U; rejected_ = false; carriageReturn_ = false; }
  void rejectUntilNewline() { rejected_ = true; }
  // Read immediately after kScan; next receive may overwrite this storage.
  const char* barcode() const { return buffer_ + barcodeOffset_; }

  Frame receive(uint8_t byte) {
    if (byte == '\n') {
      Frame frame = Frame::kRejected;
      if (!rejected_) {
        buffer_[length_] = '\0';
        if (length_ == 0U) frame = Frame::kNone;
        else if (strcmp(buffer_, "PING") == 0) frame = Frame::kPing;
        else if (strcmp(buffer_, "PONG") == 0) frame = Frame::kPong;
        else if (matchesBarcodePrefix(kScanPrefix, 5U)) frame = Frame::kScan;
        else if (matchesBarcodePrefix(kRestockPrefix, 8U)) frame = Frame::kRestock;
        else if (matchesBarcodePrefix(kCheckoutPrefix, 9U)) frame = Frame::kCheckout;
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
        length_ == kMaximumLineLength) {
      rejected_ = true;
      return Frame::kNone;
    }
    buffer_[length_++] = static_cast<char>(byte);
    return Frame::kNone;
  }

 private:
  bool matchesBarcodePrefix(const char* prefix, uint8_t offset) {
    if (length_ <= offset || memcmp(buffer_, prefix, offset) != 0 ||
        !validBarcode(buffer_ + offset, length_ - offset)) return false;
    barcodeOffset_ = offset;
    return true;
  }
  char buffer_[kMaximumLineLength + 1U] = {};
  uint8_t barcodeOffset_ = 0U;
  uint8_t length_ = 0U;
  bool rejected_ = false;
  bool carriageReturn_ = false;
};

}  // namespace dental_link
