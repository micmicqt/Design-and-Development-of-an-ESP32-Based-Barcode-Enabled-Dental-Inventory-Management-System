#pragma once

#include "registration_barcode_capture.h"
#include "../../firmware-common/include/controller_link_protocol.h"

namespace dental {
namespace controller_link {

enum class ScanRoute : uint8_t {
  kIgnored, kInvalid, kModeAccepted, kModeDuplicate, kModeBusy,
  kModeRegistrationBusy, kModeRejected, kModeStorageUnavailable,
  kRegistration, kTransaction
};
inline const char* modeReply(ScanRoute route, dental_link::Frame request) {
  if (route == ScanRoute::kModeAccepted || route == ScanRoute::kModeDuplicate)
    return request == dental_link::Frame::kRestockMode ?
        dental_link::kRestockAccepted : dental_link::kCheckoutAccepted;
  return route == ScanRoute::kModeStorageUnavailable ?
      dental_link::kModeStorageUnavailable :
      route == ScanRoute::kModeRejected ? dental_link::kModeRejected :
                                            dental_link::kModeBusy;
}
// Correlates a button-mode frame with exactly one later SCAN frame. The
// renderer cannot supply either value; both arrive through the authenticated
// controller link. Legacy combined operation frames remain accepted while the
// deployed ATmega/ESP32 pair transitions to the separated protocol.
class ForwardedOperationRouter {
 public:
  template <typename Workflow>
  ScanRoute route(dental_link::Frame frame, const char* barcode,
                  uint32_t nowMs, registration::BarcodeCapture& capture,
                  Workflow& workflow) {
    capture.service(nowMs);
    const dental_link::Frame selected = dental_link::operationForMode(frame);
    if (selected != dental_link::Frame::kNone) {
      if (operation_ != dental_link::Frame::kNone &&
          workflow.readyForBarcode(operation_)) {
        return operation_ == selected ? ScanRoute::kModeDuplicate :
                                        ScanRoute::kModeBusy;
      }
      operation_ = dental_link::Frame::kNone;
      if (capture.active()) {
        suppressNextScan_ = true;
        return ScanRoute::kModeRegistrationBusy;
      }
      if (!workflow.readyForTransaction()) {
        suppressNextScan_ = true;
        return ScanRoute::kModeBusy;
      }
      if (!workflow.beginTransactionMode(selected, nowMs)) {
        suppressNextScan_ = true;
        return workflow.modeStorageUnavailable() ?
            ScanRoute::kModeStorageUnavailable : ScanRoute::kModeRejected;
      }
      suppressNextScan_ = false;
      operation_ = selected;
      return ScanRoute::kModeAccepted;
    }

    if (frame == dental_link::Frame::kScan) {
      if (suppressNextScan_) {
        suppressNextScan_ = false;
        return ScanRoute::kIgnored;
      }
      if (operation_ != dental_link::Frame::kNone) {
        const dental_link::Frame operation = operation_;
        operation_ = dental_link::Frame::kNone;
        if (!valid(barcode) || !workflow.readyForBarcode(operation))
          return ScanRoute::kIgnored;
        workflow.handleTransactionBarcode(operation, barcode, nowMs);
        return ScanRoute::kTransaction;
      }
      if (!capture.active() || !valid(barcode)) return ScanRoute::kIgnored;
      const uint8_t length = barcodeLength(barcode);
      for (uint8_t i = 0U; i < length; ++i) capture.receive(barcode[i], nowMs);
      capture.receive('\n', nowMs);
      return ScanRoute::kRegistration;
    }

    if (frame != dental_link::Frame::kRestock &&
        frame != dental_link::Frame::kCheckout)
      return ScanRoute::kInvalid;
    if (!valid(barcode) || capture.active() || !workflow.readyForTransaction())
      return ScanRoute::kIgnored;
    workflow.handleTransactionBarcode(frame, barcode, nowMs);
    return ScanRoute::kTransaction;
  }

  dental_link::Frame pendingOperation() const { return operation_; }

 private:
  static uint8_t barcodeLength(const char* barcode) {
    if (barcode == nullptr) return 0U;
    uint8_t length = 0U;
    while (length <= dental_link::kMaximumBarcodeLength && barcode[length])
      ++length;
    return length;
  }
  static bool valid(const char* barcode) {
    const uint8_t length = barcodeLength(barcode);
    return dental_link::validBarcode(barcode, length);
  }

  dental_link::Frame operation_ = dental_link::Frame::kNone;
  bool suppressNextScan_ = false;
};

// One completed controller-link frame, one call to the existing transaction
// entry point. No mode selection, lookup, timestamp, CSV, FIFO or stock logic.
template <typename Workflow>
ScanRoute routeForwardedFrame(dental_link::Frame frame, const char* barcode, uint32_t nowMs,
                            registration::BarcodeCapture& capture,
                            Workflow& workflow) {
  if (barcode == nullptr) return ScanRoute::kInvalid;
  uint8_t length = 0U;
  while (length <= dental_link::kMaximumBarcodeLength && barcode[length]) ++length;
  if (!dental_link::validBarcode(barcode, length)) return ScanRoute::kInvalid;
  if (frame != dental_link::Frame::kScan && frame != dental_link::Frame::kRestock &&
      frame != dental_link::Frame::kCheckout) return ScanRoute::kInvalid;
  // Registration and physical operation frames are never interchangeable.
  const bool wasCapturing = capture.active();
  capture.service(nowMs);
  if (frame == dental_link::Frame::kScan) {
    if (!wasCapturing || !capture.active()) return ScanRoute::kIgnored;
    for (uint8_t i = 0U; i < length; ++i) capture.receive(barcode[i], nowMs);
    capture.receive('\n', nowMs);
    return ScanRoute::kRegistration;
  }
  if (wasCapturing || !workflow.readyForTransaction()) return ScanRoute::kIgnored;
  workflow.handleTransactionBarcode(frame, barcode, nowMs);
  return ScanRoute::kTransaction;
}

}  // namespace controller_link
}  // namespace dental
