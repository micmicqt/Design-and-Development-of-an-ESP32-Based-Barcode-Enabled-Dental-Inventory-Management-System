#pragma once

#include <stddef.h>
#include <stdint.h>

namespace dental::registration {

constexpr size_t kMaximumBarcodeLength = 256U;
constexpr uint32_t kAcknowledgementTimeoutMs = 2000UL;
constexpr uint32_t kBarcodeTimeoutMs = 10000UL;
constexpr uint32_t kBarcodeIdleTimeoutMs = 100UL;
constexpr uint8_t kScannerAcknowledgement[] = {
    0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};

enum class CaptureState : uint8_t {
  kIdle,
  kWaitingForAcknowledgement,
  kWaitingForBarcode,
  kComplete,
  kFailed,
};

enum class CaptureFailure : uint8_t {
  kNone,
  kAcknowledgementTimeout,
  kBarcodeTimeout,
  kInvalidBarcode,
};

/**
 * Bounded parser for one explicitly requested registration scan. It has no
 * transaction mode, event queue, RTC, stock, or journal dependencies.
 */
class BarcodeCapture {
 public:
  bool start(uint32_t nowMs) {
    if (active()) return false;
    state_ = CaptureState::kWaitingForAcknowledgement;
    failure_ = CaptureFailure::kNone;
    acknowledgementMatchIndex_ = 0U;
    barcodeLength_ = 0U;
    barcode_[0] = '\0';
    barcodeInvalid_ = false;
    receivedBarcodeByte_ = false;
    stateStartedMs_ = nowMs;
    lastBarcodeByteMs_ = nowMs;
    return true;
  }

  bool active() const {
    return state_ == CaptureState::kWaitingForAcknowledgement ||
           state_ == CaptureState::kWaitingForBarcode;
  }

  CaptureState state() const { return state_; }
  CaptureFailure failure() const { return failure_; }
  const char* barcode() const { return barcode_; }

  void receive(uint8_t byte, uint32_t nowMs) {
    if (state_ == CaptureState::kWaitingForAcknowledgement) {
      receiveAcknowledgementByte(byte, nowMs);
      return;
    }
    if (state_ != CaptureState::kWaitingForBarcode) return;

    if (byte == '\r' || byte == '\n') {
      if (barcodeLength_ == 0U && !barcodeInvalid_) return;
      completeBarcode();
      return;
    }

    receivedBarcodeByte_ = true;
    lastBarcodeByteMs_ = nowMs;
    if (byte < 0x20U || byte > 0x7EU || byte == ',') {
      barcodeInvalid_ = true;
      return;
    }
    if (barcodeLength_ >= kMaximumBarcodeLength) {
      barcodeInvalid_ = true;
      return;
    }

    barcode_[barcodeLength_++] = static_cast<char>(byte);
    barcode_[barcodeLength_] = '\0';
  }

  void service(uint32_t nowMs) {
    if (state_ == CaptureState::kWaitingForAcknowledgement &&
        nowMs - stateStartedMs_ >= kAcknowledgementTimeoutMs) {
      fail(CaptureFailure::kAcknowledgementTimeout);
      return;
    }
    if (state_ != CaptureState::kWaitingForBarcode) return;

    if ((barcodeLength_ > 0U || barcodeInvalid_) && receivedBarcodeByte_ &&
        nowMs - lastBarcodeByteMs_ >= kBarcodeIdleTimeoutMs) {
      completeBarcode();
      return;
    }
    if (nowMs - stateStartedMs_ >= kBarcodeTimeoutMs) {
      fail(CaptureFailure::kBarcodeTimeout);
    }
  }

 private:
  void receiveAcknowledgementByte(uint8_t byte, uint32_t nowMs) {
    if (byte == kScannerAcknowledgement[acknowledgementMatchIndex_]) {
      ++acknowledgementMatchIndex_;
      if (acknowledgementMatchIndex_ == sizeof(kScannerAcknowledgement)) {
        acknowledgementMatchIndex_ = 0U;
        state_ = CaptureState::kWaitingForBarcode;
        stateStartedMs_ = nowMs;
        lastBarcodeByteMs_ = nowMs;
      }
      return;
    }
    acknowledgementMatchIndex_ = byte == kScannerAcknowledgement[0] ? 1U : 0U;
  }

  void completeBarcode() {
    bool hasVisibleCharacter = false;
    for (size_t index = 0U; index < barcodeLength_; ++index) {
      if (barcode_[index] != ' ') {
        hasVisibleCharacter = true;
        break;
      }
    }
    if (barcodeInvalid_ || barcodeLength_ == 0U || !hasVisibleCharacter) {
      fail(CaptureFailure::kInvalidBarcode);
      return;
    }
    state_ = CaptureState::kComplete;
    failure_ = CaptureFailure::kNone;
  }

  void fail(CaptureFailure failure) {
    state_ = CaptureState::kFailed;
    failure_ = failure;
    barcodeLength_ = 0U;
    barcode_[0] = '\0';
  }

  CaptureState state_ = CaptureState::kIdle;
  CaptureFailure failure_ = CaptureFailure::kNone;
  size_t acknowledgementMatchIndex_ = 0U;
  char barcode_[kMaximumBarcodeLength + 1U] = {};
  size_t barcodeLength_ = 0U;
  bool barcodeInvalid_ = false;
  bool receivedBarcodeByte_ = false;
  uint32_t stateStartedMs_ = 0UL;
  uint32_t lastBarcodeByteMs_ = 0UL;
};

inline const char* failureCode(CaptureFailure failure) {
  switch (failure) {
    case CaptureFailure::kAcknowledgementTimeout:
      return "scanner_acknowledgement_timeout";
    case CaptureFailure::kBarcodeTimeout: return "barcode_timeout";
    case CaptureFailure::kInvalidBarcode: return "invalid_barcode";
    case CaptureFailure::kNone: return "none";
  }
  return "invalid_barcode";
}

}  // namespace dental::registration
