#pragma once

#include <stdint.h>
#include <string.h>

namespace dental_link {

constexpr uint32_t kBaud = 9600UL;
constexpr char kPing[] = "PING\n";
constexpr char kPong[] = "PONG\n";
constexpr uint8_t kMaximumBarcodeLength = 64U;
constexpr char kScanPrefix[] = "SCAN:";
constexpr uint8_t kMaximumLineLength = 5U + kMaximumBarcodeLength;

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

enum class Frame : uint8_t { kNone, kPing, kPong, kScan, kRejected };

// Fixed storage; a bad/oversized frame is discarded through its next LF.
class LineParser {
 public:
  void reset() { length_ = 0U; rejected_ = false; carriageReturn_ = false; }
  void rejectUntilNewline() { rejected_ = true; }
  // Read immediately after kScan; next receive may overwrite this storage.
  const char* barcode() const { return buffer_ + 5U; }

  Frame receive(uint8_t byte) {
    if (byte == '\n') {
      Frame frame = Frame::kRejected;
      if (!rejected_) {
        buffer_[length_] = '\0';
        if (length_ == 0U) frame = Frame::kNone;
        else if (strcmp(buffer_, "PING") == 0) frame = Frame::kPing;
        else if (strcmp(buffer_, "PONG") == 0) frame = Frame::kPong;
        else if (length_ > 5U && memcmp(buffer_, kScanPrefix, 5U) == 0 &&
                 validBarcode(buffer_ + 5U, length_ - 5U)) frame = Frame::kScan;
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
  char buffer_[kMaximumLineLength + 1U] = {};
  uint8_t length_ = 0U;
  bool rejected_ = false;
  bool carriageReturn_ = false;
};

}  // namespace dental_link
