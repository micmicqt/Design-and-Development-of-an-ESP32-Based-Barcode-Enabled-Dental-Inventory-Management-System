#pragma once

#include "../../firmware-common/include/controller_link_protocol.h"
#include <string.h>

namespace dental {
namespace controller_link {

// Transport-only responder. No references to inventory, storage or HTTP APIs.
class PingResponder {
 public:
  template <typename Transmitter>
  dental_link::Frame receive(uint8_t byte, Transmitter& transmitter) {
    atBoundary_ = byte == '\n';
    const dental_link::Frame frame = parser_.receive(byte);
    if (frame == dental_link::Frame::kPing) queueLine(dental_link::kPong);
    service(transmitter);
    return frame;
  }

  const char* barcode() const { return parser_.barcode(); }
  const char* payload() const { return parser_.payload(); }
  void rejectPartialInput() {
    if (!atBoundary_) parser_.rejectUntilNewline();
  }

  template <typename Transmitter>
  void service(Transmitter& transmitter) {
    // Only one byte per call. Busy TX never stalls the existing state machine.
    if (length_ != 0U && transmitter.tryWrite(
            static_cast<uint8_t>(output_[position_]))) {
      ++position_;
      if (position_ == length_) length_ = position_ = 0U;
    }
  }

  bool queueLine(const char* line) {
    if (!line || length_ != 0U) return false;
    const size_t length = strlen(line);
    if (length == 0U || length >= sizeof(output_)) return false;
    memcpy(output_, line, length);
    length_ = static_cast<uint8_t>(length);
    position_ = 0U;
    return true;
  }
  bool busy() const { return length_ != 0U; }

 private:
  dental_link::LineParser parser_;
  char output_[64] = {};
  uint8_t position_ = 0U;
  uint8_t length_ = 0U;
  bool atBoundary_ = true;
};

}  // namespace controller_link
}  // namespace dental
