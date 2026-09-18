#pragma once

#include "registration_barcode_capture.h"
#include "../../firmware-common/include/controller_link_protocol.h"

namespace dental {
namespace controller_link {

enum class ScanRoute : uint8_t { kIgnored, kInvalid, kRegistration, kTransaction };

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
