#include "button_admission.h"
#include "forwarded_scan_routing.h"
#include "offline_cache_publication_job.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {

using dental::controller_link::ButtonAdmissionGate;
using dental::controller_link::ScanRoute;

struct Workflow {
  bool waiting = false;
  bool ready = true;
  bool reject = false;
  dental_link::Frame operation = dental_link::Frame::kNone;
  bool readyForTransaction() const { return ready && !waiting; }
  bool beginTransactionMode(dental_link::Frame next, uint32_t) {
    if (reject) return false;
    waiting = true;
    operation = next;
    return true;
  }
  bool modeStorageUnavailable() const { return reject; }
  bool readyForBarcode(dental_link::Frame next) const {
    return waiting && operation == next;
  }
  void handleTransactionBarcode(dental_link::Frame, const char*, uint32_t) {
    waiting = false;
  }
};

void backgroundTrafficDoesNotBecomeBusy() {
  assert(dental::controller_link::buttonAdmissionGate(false, false) ==
         ButtonAdmissionGate::kProceed);
  assert(dental::controller_link::buttonAdmissionGate(true, false) ==
         ButtonAdmissionGate::kStorageBridgeActive);
  assert(dental::controller_link::buttonAdmissionGate(false, true) ==
         ButtonAdmissionGate::kOfflineAckActive);
  assert(strcmp(dental::controller_link::buttonAdmissionGateReason(
                    ButtonAdmissionGate::kStorageBridgeActive),
                "STORAGE_BRIDGE_ACTIVE") == 0);
  assert(strcmp(dental::controller_link::buttonAdmissionGateReason(
                    ButtonAdmissionGate::kOfflineAckActive),
                "OFFLINE_ACK_IN_PROGRESS") == 0);
  // RTC polls, heartbeats, status, STA retries, and a queued cache request
  // have no gate input: none owns the exclusive controller/storage bridge.
  assert(strcmp(dental::controller_link::modeReply(
                    ScanRoute::kModeStorageUnavailable,
                    dental_link::Frame::kRestockMode),
                dental_link::kModeStorageUnavailable) == 0);
}

void repeatedModeTimeoutRejectAndRecovery() {
  dental::controller_link::ForwardedOperationRouter router;
  dental::registration::BarcodeCapture capture;
  Workflow workflow;
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    const auto mode = (cycle & 1U) == 0U ?
        dental_link::Frame::kRestockMode : dental_link::Frame::kCheckoutMode;
    assert(router.route(mode, nullptr, cycle * 1000U, capture, workflow) ==
           ScanRoute::kModeAccepted);
    assert(router.route(mode, nullptr, cycle * 1000U + 1U, capture, workflow) ==
           ScanRoute::kModeDuplicate);
    assert(router.route(mode == dental_link::Frame::kRestockMode ?
                            dental_link::Frame::kCheckoutMode :
                            dental_link::Frame::kRestockMode,
                        nullptr, cycle * 1000U + 2U, capture, workflow) ==
           ScanRoute::kModeBusy);
    // Existing workflow timeout returns to idle; a stale router selection
    // cannot retain BUSY into the next mode request.
    workflow.waiting = false;
    workflow.reject = true;
    assert(router.route(mode, nullptr, cycle * 1000U + 3U, capture, workflow) ==
           ScanRoute::kModeStorageUnavailable);
    workflow.reject = false;
    assert(router.route(mode, nullptr, cycle * 1000U + 4U, capture, workflow) ==
           ScanRoute::kModeAccepted);
    workflow.waiting = false;
  }
}

void queuedCacheRequestWaitsAndRechecksPendingInterlock() {
  dental::cache::CachePublicationJob job;
  dental::cache::CacheRequest request = {};
  request.operation = dental::cache::CacheOperation::kBegin;
  strcpy(request.generation,
         "v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  request.itemCount = 1U;
  assert(job.submit(request, 1U) ==
         dental::cache::CachePublicationJob::Submission::kQueued);
  bool offlineTransactionActive = true;
  unsigned storageCalls = 0U;
  if (!offlineTransactionActive) {
    job.run([&](const dental::cache::CacheRequest&) {
      ++storageCalls;
      return dental::cache::CachePublicationJob::Outcome{200U, nullptr, 1U,
                                                          false};
    }, [] { return 2U; });
  }
  assert(job.state() == dental::cache::CachePublicationJob::State::kQueued);
  assert(storageCalls == 0U);
  offlineTransactionActive = false;
  const bool pendingRecordDurablyAppended = true;
  job.run([&](const dental::cache::CacheRequest&) {
    if (pendingRecordDurablyAppended)
      return dental::cache::CachePublicationJob::Outcome{
          409U, "pending_sync_interlock", 0U, false};
    ++storageCalls;
    return dental::cache::CachePublicationJob::Outcome{200U, nullptr, 1U,
                                                        false};
  }, [] { return 3U; });
  assert(job.state() == dental::cache::CachePublicationJob::State::kFailed);
  assert(storageCalls == 0U);
  assert(strcmp(job.outcome().error, "pending_sync_interlock") == 0);
}

}  // namespace

int main() {
  backgroundTrafficDoesNotBecomeBusy();
  repeatedModeTimeoutRejectAndRecovery();
  queuedCacheRequestWaitsAndRechecksPendingInterlock();
  puts("Button admission/cache race: 3 scenarios, 100 mode cycles PASSED");
}
