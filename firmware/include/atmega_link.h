#pragma once

#include "../../firmware-common/include/controller_link_protocol.h"

namespace dental {
namespace controller_link {

// Transport-only responder. No references to inventory, storage or HTTP APIs.
class PingResponder {
 public:
  template <typename Transmitter>
  dental_link::Frame receive(uint8_t byte, Transmitter& transmitter) {
    const dental_link::Frame frame = parser_.receive(byte);
    if (frame == dental_link::Frame::kPing && remaining_ == 0U) {
      remaining_ = sizeof(dental_link::kPong) - 1U;
      position_ = 0U;
    }
    service(transmitter);
    return frame;
  }

  const char* barcode() const { return parser_.barcode(); }

  template <typename Transmitter>
  void service(Transmitter& transmitter) {
    // Only one byte per call. Busy TX never stalls the existing state machine.
    if (remaining_ != 0U && transmitter.tryWrite(
            static_cast<uint8_t>(dental_link::kPong[position_]))) {
      ++position_;
      --remaining_;
    }
  }

 private:
  dental_link::LineParser parser_;
  uint8_t position_ = 0U;
  uint8_t remaining_ = 0U;
};

}  // namespace controller_link
}  // namespace dental
