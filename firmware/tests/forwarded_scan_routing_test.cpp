#include "atmega_link.h"
#include "forwarded_scan_routing.h"
#include "hardware_config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
struct WorkflowSpy {
  bool ready = true;
  bool waiting = false;
  bool storageUnavailable = false;
  bool rejectMode = false;
  unsigned modeCalls = 0U;
  unsigned calls = 0U;
  dental_link::Frame mode = dental_link::Frame::kNone;
  char barcode[65] = {};
  bool readyForTransaction() const { return ready && !waiting; }
  bool beginTransactionMode(dental_link::Frame operation, uint32_t) {
    if (!readyForTransaction()) return false;
    if (rejectMode) return false;
    ++modeCalls; mode = operation; waiting = true; return true;
  }
  bool modeStorageUnavailable() const { return storageUnavailable; }
  bool readyForBarcode(dental_link::Frame operation) const {
    return waiting && mode == operation;
  }
  void handleTransactionBarcode(dental_link::Frame operation, const char* text, uint32_t) {
    ++calls; mode = operation; strcpy(barcode, text); ready = false; waiting = false;
  }
};
struct Writer {
  char bytes[32] = {}; unsigned count = 0U;
  bool tryWrite(uint8_t byte) { assert(count < sizeof(bytes)); bytes[count++] = byte; return true; }
};
struct Fixture {
  dental::controller_link::PingResponder responder;
  dental::controller_link::ForwardedOperationRouter router;
  dental::registration::BarcodeCapture capture;
  WorkflowSpy workflow;
  Writer writer;
  unsigned registrationRoutes = 0U;
  void feed(const char* text, uint32_t now = 1UL) {
    for (; *text; ++text) {
      const dental_link::Frame frame = responder.receive(*text, writer);
      if (frame == dental_link::Frame::kScan || frame == dental_link::Frame::kRestock ||
          frame == dental_link::Frame::kCheckout ||
          frame == dental_link::Frame::kRestockMode ||
          frame == dental_link::Frame::kCheckoutMode) {
        if (router.route(frame,
                         frame == dental_link::Frame::kRestockMode ||
                                 frame == dental_link::Frame::kCheckoutMode
                             ? nullptr : responder.barcode(),
                         now, capture, workflow) ==
            dental::controller_link::ScanRoute::kRegistration) ++registrationRoutes;
      }
    }
    for (unsigned i = 0U; i < 5U; ++i) responder.service(writer);
  }
};
void validScanOnce() {
  Fixture f; f.feed("RESTOCK:4806016001569\n");
  assert(f.workflow.calls == 1U && strcmp(f.workflow.barcode, "4806016001569") == 0);
  assert(f.workflow.mode == dental_link::Frame::kRestock);
}
void separatedRestockAndCheckout() {
  Fixture restock;
  restock.feed("BTN:RESTOCK\n");
  assert(restock.workflow.modeCalls == 1U && restock.workflow.calls == 0U &&
         restock.workflow.waiting);
  restock.feed("SCAN:4806016001569\n");
  assert(restock.workflow.calls == 1U &&
         restock.workflow.mode == dental_link::Frame::kRestock &&
         strcmp(restock.workflow.barcode, "4806016001569") == 0);

  Fixture checkout;
  checkout.feed("BTN:CHECKOUT\n");
  assert(checkout.workflow.modeCalls == 1U && checkout.workflow.calls == 0U &&
         checkout.workflow.waiting);
  checkout.feed("SCAN:0012345678905\n");
  assert(checkout.workflow.calls == 1U &&
         checkout.workflow.mode == dental_link::Frame::kCheckout &&
         strcmp(checkout.workflow.barcode, "0012345678905") == 0);
}
void duplicateModeAndScanDoNotRestart() {
  Fixture f;
  f.feed("BTN:CHECKOUT\nBTN:CHECKOUT\n");
  assert(f.workflow.modeCalls == 1U && f.workflow.calls == 0U);
  f.feed("SCAN:00123\nSCAN:00123\n");
  assert(f.workflow.calls == 1U);
}
void zeroesAndWhitespace() {
  Fixture f; f.feed("CHECKOUT: 0012345678905 \r\n");
  assert(f.workflow.calls == 1U && strcmp(f.workflow.barcode, " 0012345678905 ") == 0);
  assert(f.workflow.mode == dental_link::Frame::kCheckout);
}
void malformed() {
  Fixture f; f.feed("RESTOCK:\nCHECKOUT:  \nrestock:123\nRESTOCK:12\r34\n");
  f.responder.receive(0U, f.writer); f.feed("RESTOCK:123\n");
  assert(f.workflow.calls == 0U);
  f.feed("RESTOCK:00123\n"); assert(f.workflow.calls == 1U);
}
void oversized() {
  Fixture f; f.feed("CHECKOUT:");
  for (unsigned i = 0U; i < 4096U; ++i) f.responder.receive('1', f.writer);
  f.feed("\n"); assert(f.workflow.calls == 0U);
  f.feed("RESTOCK:00123\n"); assert(f.workflow.calls == 1U);
}
void pingPong() {
  Fixture f; f.feed("PING\nRESTOCK:00123\nPING\n");
  assert(f.writer.count == 10U && memcmp(f.writer.bytes, "PONG\nPONG\n", 10U) == 0);
  assert(f.workflow.calls == 1U);
}
void directScannerDisabled() {
  assert(!dental::hardware::kScannerUartEnabled);
  assert(!dental::hardware::kLegacyTransactionButtonsEnabled);
  assert(dental::hardware::kAtmegaLinkRxGpio == 16 && dental::hardware::kAtmegaLinkTxGpio == 17);
}
void idleAndFeedbackIgnored() {
  Fixture f; f.workflow.ready = false; f.feed("RESTOCK:00123\n");
  assert(f.workflow.calls == 0U);
  f.workflow.ready = true; f.feed("RESTOCK:00123\nRESTOCK:00123\n");
  assert(f.workflow.calls == 1U); // First dispatch enters the existing busy/feedback path.
}
void registrationIsolation() {
  Fixture f; assert(f.capture.start(0UL, false)); f.feed("SCAN:0012345678905\n");
  assert(f.registrationRoutes == 1U && f.workflow.calls == 0U);
  assert(f.capture.state() == dental::registration::CaptureState::kComplete);
  assert(strcmp(f.capture.barcode(), "0012345678905") == 0);
  f.workflow.ready = false; f.feed("SCAN:123\n");
  assert(f.registrationRoutes == 1U && f.workflow.calls == 0U);
}
void physicalModeCannotPopulateRegistration() {
  Fixture f; assert(f.capture.start(0UL, false));
  f.feed("BTN:RESTOCK\nSCAN:0012345678905\n");
  assert(f.workflow.modeCalls == 0U && f.workflow.calls == 0U &&
         f.registrationRoutes == 0U && f.capture.active());
}
void registrationFailureAndTimeout() {
  Fixture f; assert(f.capture.start(0UL, false)); f.feed("SCAN:12,34\n");
  assert(f.capture.failure() == dental::registration::CaptureFailure::kInvalidBarcode);
  assert(f.workflow.calls == 0U);
  assert(f.capture.start(1UL, false)); f.feed("SCAN:00123\n", 10001UL);
  assert(f.capture.failure() == dental::registration::CaptureFailure::kBarcodeTimeout);
  assert(f.workflow.calls == 0U); // Expired registration never falls into transaction.
}
void maximumAndDefensiveValidation() {
  Fixture f; f.feed("CHECKOUT:");
  for (unsigned i = 0U; i < 64U; ++i) f.responder.receive('0', f.writer);
  f.feed("\n"); assert(f.workflow.calls == 1U && strlen(f.workflow.barcode) == 64U);
  WorkflowSpy spy; dental::registration::BarcodeCapture capture;
  assert(dental::controller_link::routeForwardedFrame(dental_link::Frame::kRestock, nullptr, 1UL, capture, spy) == dental::controller_link::ScanRoute::kInvalid);
  char tooLong[66]; memset(tooLong, '1', 65U); tooLong[65] = '\0';
  assert(dental::controller_link::routeForwardedFrame(dental_link::Frame::kCheckout, tooLong, 1UL, capture, spy) == dental::controller_link::ScanRoute::kInvalid);
  assert(spy.calls == 0U);
}
void freshCaptureAndParserQuarantine() {
  Fixture clean; clean.responder.rejectPartialInput(); clean.feed("RESTOCK:00123\n");
  assert(clean.workflow.calls == 1U); // Clean arming must not discard first scan.
  Fixture f; f.feed("CHECKOUT:stale"); f.responder.rejectPartialInput();
  f.feed("tail\n"); assert(f.workflow.calls == 0U);
  f.feed("\nCHECKOUT:00123\n"); assert(f.workflow.calls == 1U);
  dental::registration::BarcodeCapture capture;
  assert(capture.start(UINT32_MAX - 100UL, false));
  capture.service(9898UL); assert(capture.active());
  capture.service(9899UL); assert(capture.failure() == dental::registration::CaptureFailure::kBarcodeTimeout);
}
}
void bareScanNeverCreatesTransaction() {
  Fixture f; f.feed("SCAN:00123\nSCAN:00123\n");
  assert(f.workflow.calls == 0U);
}
void physicalOperationCannotBecomeRegistration() {
  Fixture f; assert(f.capture.start(0UL, false));
  f.feed("RESTOCK:00123\nCHECKOUT:00123\n");
  assert(f.capture.active() && f.workflow.calls == 0U && f.registrationRoutes == 0U);
  f.feed("SCAN:00123\n");
  assert(f.capture.state() == dental::registration::CaptureState::kComplete &&
         f.registrationRoutes == 1U && f.workflow.calls == 0U);
}
void repeatedBarcodeAfterRearmIsDistinctOperation() {
  Fixture f; f.feed("RESTOCK:00123\nRESTOCK:00123\n");
  assert(f.workflow.calls == 1U);
  f.workflow.ready = true; f.feed("CHECKOUT:00123\n");
  assert(f.workflow.calls == 2U && f.workflow.mode == dental_link::Frame::kCheckout);
}
void explicitModeRepliesAndIdempotentRetry() {
  using dental::controller_link::ScanRoute;
  Fixture f;
  const auto first = f.router.route(dental_link::Frame::kCheckoutMode,
      nullptr, 1UL, f.capture, f.workflow);
  assert(first == ScanRoute::kModeAccepted);
  assert(strcmp(dental::controller_link::modeReply(first,
      dental_link::Frame::kCheckoutMode), "BTN:OK:CHECKOUT\n") == 0);
  const auto retry = f.router.route(dental_link::Frame::kCheckoutMode,
      nullptr, 2UL, f.capture, f.workflow);
  assert(retry == ScanRoute::kModeDuplicate && f.workflow.modeCalls == 1U);
  assert(strcmp(dental::controller_link::modeReply(retry,
      dental_link::Frame::kCheckoutMode), "BTN:OK:CHECKOUT\n") == 0);
  const auto conflict = f.router.route(dental_link::Frame::kRestockMode,
      nullptr, 3UL, f.capture, f.workflow);
  assert(conflict == ScanRoute::kModeBusy && f.workflow.modeCalls == 1U);
  assert(strcmp(dental::controller_link::modeReply(conflict,
      dental_link::Frame::kRestockMode), "BTN:BUSY\n") == 0);
  f.router.route(dental_link::Frame::kScan, "00123", 4UL, f.capture, f.workflow);
  assert(f.workflow.calls == 1U);
}
void registrationAndRejectionReply() {
  using dental::controller_link::ScanRoute;
  Fixture f; assert(f.capture.start(0UL, false));
  const auto busy = f.router.route(dental_link::Frame::kRestockMode,
      nullptr, 1UL, f.capture, f.workflow);
  assert(busy == ScanRoute::kModeRegistrationBusy && f.workflow.modeCalls == 0U);
  assert(strcmp(dental::controller_link::modeReply(busy,
      dental_link::Frame::kRestockMode), "BTN:BUSY\n") == 0);
  dental_link::LineParser parser;
  dental_link::Frame frame = dental_link::Frame::kNone;
  for (const char* p = "BTN:CHECKOUT\n"; *p; ++p) frame = parser.receive(*p);
  assert(frame == dental_link::Frame::kCheckoutMode);
  for (const char* p = "BTN:OK:CHECKOUT\n"; *p; ++p) frame = parser.receive(*p);
  assert(frame == dental_link::Frame::kCheckoutAccepted);
  for (const char* p = "BTN:CHECKOUT:GARBAGE\n"; *p; ++p) frame = parser.receive(*p);
  assert(frame == dental_link::Frame::kRejected);
}
void storageFailureGetsExplicitTypedReply() {
  using dental::controller_link::ScanRoute;
  Fixture f;
  f.workflow.rejectMode = true;
  f.workflow.storageUnavailable = true;
  const auto route = f.router.route(dental_link::Frame::kRestockMode,
      nullptr, 1UL, f.capture, f.workflow);
  assert(route == ScanRoute::kModeStorageUnavailable);
  assert(strcmp(dental::controller_link::modeReply(route,
      dental_link::Frame::kRestockMode), "BTN:REJECT:STORAGE\n") == 0);
  dental_link::LineParser parser;
  dental_link::Frame reply = dental_link::Frame::kNone;
  for (const char* p = dental_link::kModeStorageUnavailable; *p; ++p)
    reply = parser.receive(*p);
  assert(reply == dental_link::Frame::kModeStorageUnavailable);
  assert(f.router.route(dental_link::Frame::kScan, "00123", 2UL,
                        f.capture, f.workflow) == ScanRoute::kIgnored);
  assert(f.workflow.calls == 0U);
}

int main() {
  validScanOnce(); separatedRestockAndCheckout(); duplicateModeAndScanDoNotRestart();
  zeroesAndWhitespace(); malformed(); oversized(); pingPong();
  directScannerDisabled(); idleAndFeedbackIgnored(); registrationIsolation();
  physicalModeCannotPopulateRegistration(); registrationFailureAndTimeout();
  maximumAndDefensiveValidation(); freshCaptureAndParserQuarantine();
  bareScanNeverCreatesTransaction(); physicalOperationCannotBecomeRegistration(); repeatedBarcodeAfterRearmIsDistinctOperation();
  explicitModeRepliesAndIdempotentRetry(); registrationAndRejectionReply();
  storageFailureGetsExplicitTypedReply();
  puts("ATmega operation routing/registration: 20 focused scenarios PASSED");
}
