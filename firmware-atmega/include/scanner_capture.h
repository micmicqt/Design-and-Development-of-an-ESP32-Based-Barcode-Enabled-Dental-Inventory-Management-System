#pragma once

#include "ping_client.h"

namespace dental_atmega {

enum class ScanOutcome : uint8_t { kNone, kBarcode, kRejected };

// Completed text remains valid until the next receive. CR/LF are the only
// removed bytes; malformed frames are discarded in full, never truncated.
class ScannerCapture {
 public:
  static constexpr uint32_t kTimeoutMs = 1000UL;
  ScanOutcome receive(uint32_t now, uint8_t byte) {
    service(now);
    if (byte == '\r' || byte == '\n') {
      buffer_[length_] = '\0';
      const ScanOutcome result = rejected_ ? ScanOutcome::kRejected :
          length_ == 0U ? ScanOutcome::kNone :
          dental_link::validBarcode(buffer_, length_) ? ScanOutcome::kBarcode :
          ScanOutcome::kRejected;
      length_ = 0U;
      rejected_ = false;
      return result;
    }
    lastByte_ = now;
    if (rejected_) return ScanOutcome::kNone;
    if (byte < 0x20U || byte > 0x7EU ||
        length_ == dental_link::kMaximumBarcodeLength) rejected_ = true;
    else buffer_[length_++] = static_cast<char>(byte);
    return ScanOutcome::kNone;
  }
  void receiveError() { rejected_ = true; }
  void rejectPartialInput() { if (length_ || rejected_) rejected_ = true; }
  void service(uint32_t now) {
    if (length_ && static_cast<uint32_t>(now - lastByte_) >= kTimeoutMs)
      rejected_ = true;
  }
  const char* barcode() const { return buffer_; }
 private:
  char buffer_[dental_link::kMaximumBarcodeLength + 1U] = {};
  uint32_t lastByte_ = 0UL;
  uint8_t length_ = 0U;
  bool rejected_ = false;
};

// One pending scan, no unbounded queue. Additional completed scans are dropped
// while busy, not merged. No scan/PING byte interleaving is permitted.
class ScannerTransport {
 public:
  ScanOutcome receive(uint32_t now, uint8_t byte, bool error = false,
                      dental_link::Frame frame = dental_link::Frame::kScan) {
    if (error) { capture_.receiveError(); return ScanOutcome::kRejected; }
    const ScanOutcome outcome = capture_.receive(now, byte);
    if (outcome != ScanOutcome::kBarcode) return outcome;
    if (frame == dental_link::Frame::kNone) return ScanOutcome::kNone;
    const char* prefix = dental_link::barcodePrefix(frame);
    if (!prefix) return ScanOutcome::kRejected;
    if (active_) { ++dropped_; return ScanOutcome::kRejected; }
    frame_ = frame;
    prefixLength_ = static_cast<uint8_t>(dental_link::text::length(prefix));
    const size_t length = strlen(capture_.barcode());
    memcpy(barcode_, capture_.barcode(), length + 1U);
    length_ = static_cast<uint8_t>(length);
    position_ = 0U;
    active_ = true;
    started_ = false;
    recoveryMarkerSent_ = false;
    return ScanOutcome::kBarcode;
  }
  void rejectPartialScan() { capture_.rejectPartialInput(); }
  void cancelPending() {
    active_ = false;
    capture_.rejectPartialInput();
  }
  template <typename Transmitter>
  void service(uint32_t now, PingClient& ping, Transmitter& tx) {
    capture_.service(now);
    if (!active_ || ping.state() == LinkState::kSending) {
      ping.service(now, tx);
      return;
    }
    if (!started_) { started_ = true; since_ = now; }
    if (static_cast<uint32_t>(now - since_) >= ScannerCapture::kTimeoutMs) {
      // Poison before LF: LF alone could validate a truncated barcode.
      if (!recoveryMarkerSent_) {
        if (tx.tryWrite(0U)) recoveryMarkerSent_ = true;
      } else if (tx.tryWrite('\n')) { active_ = false; ++dropped_; }
      return;
    }
    // Leading LF resynchronizes after any earlier incomplete PING/frame.
    const uint8_t byte = position_ == 0U ? '\n' : position_ <= prefixLength_ ?
        static_cast<uint8_t>(dental_link::text::at(
            dental_link::barcodePrefix(frame_), position_ - 1U)) :
        position_ <= prefixLength_ + length_ ?
        static_cast<uint8_t>(barcode_[position_ - prefixLength_ - 1U]) : '\n';
    if (tx.tryWrite(byte) && ++position_ == length_ + prefixLength_ + 2U) active_ = false;
  }
  bool active() const { return active_; }
  uint16_t droppedCount() const { return dropped_; }
 private:
  ScannerCapture capture_;
  char barcode_[dental_link::kMaximumBarcodeLength + 1U] = {};
  uint32_t since_ = 0UL;
  uint16_t dropped_ = 0U;
  uint8_t length_ = 0U;
  uint8_t position_ = 0U;
  bool active_ = false;
  bool started_ = false;
  bool recoveryMarkerSent_ = false;
  uint8_t prefixLength_ = 5U;
  dental_link::Frame frame_ = dental_link::Frame::kScan;
};

}  // namespace dental_atmega
