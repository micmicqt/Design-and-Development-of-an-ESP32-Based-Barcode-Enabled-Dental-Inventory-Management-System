#pragma once

#include <stdint.h>
#include <string.h>

namespace dental_link {

constexpr uint32_t kBaud = 9600UL;
constexpr char kPing[] = "PING\n";
constexpr char kPong[] = "PONG\n";
constexpr uint8_t kMaximumLineLength = 8U;

enum class Frame : uint8_t { kNone, kPing, kPong, kRejected };

// Fixed storage; a bad/oversized frame is discarded through its next LF.
class LineParser {
 public:
  void reset() { length_ = 0U; rejected_ = false; carriageReturn_ = false; }
  void rejectUntilNewline() { rejected_ = true; }

  Frame receive(uint8_t byte) {
    if (byte == '\n') {
      Frame frame = Frame::kRejected;
      if (!rejected_) {
        buffer_[length_] = '\0';
        if (length_ == 0U) frame = Frame::kNone;
        else if (strcmp(buffer_, "PING") == 0) frame = Frame::kPing;
        else if (strcmp(buffer_, "PONG") == 0) frame = Frame::kPong;
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
