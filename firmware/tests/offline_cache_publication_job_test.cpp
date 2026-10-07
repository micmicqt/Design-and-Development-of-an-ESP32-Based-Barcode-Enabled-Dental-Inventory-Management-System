#include "offline_cache_publication_job.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

using Job = dental::cache::CachePublicationJob;
using Request = dental::cache::CacheRequest;

int main() {
  Job job;
  job.seedJobId(0x12340000U);
  Request begin = {};
  begin.operation = dental::cache::CacheOperation::kBegin;
  strcpy(begin.generation, "v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  begin.itemCount = 2U;
  Request different = begin;
  different.operation = dental::cache::CacheOperation::kCommit;
  unsigned storageCalls = 0U;
  unsigned servedStatus = 0U, servedOnlineEvent = 0U;
  assert(job.submit(begin, 100U) == Job::Submission::kQueued);
  assert(storageCalls == 0U && job.active());
  const uint32_t firstId = job.jobId();
  assert(firstId == 0x12340001U);
  assert(job.submit(begin, 101U) == Job::Submission::kProcessing);
  assert(job.jobId() == firstId);
  assert(job.submit(different, 102U) == Job::Submission::kBusy);
  assert(storageCalls == 0U);
  job.run([&](const Request& request) {
    ++storageCalls;
    assert(request.operation == dental::cache::CacheOperation::kBegin);
    assert(job.state() == Job::State::kRunning);
    // The storage owner can yield to RAM-only HTTP routes while the durable
    // operation is still running; neither route advances or copies the job.
    ++servedStatus;
    ++servedOnlineEvent;
    assert(job.active() && storageCalls == 1U);
    assert(job.submit(begin, 103U) == Job::Submission::kProcessing);
    assert(job.submit(different, 104U) == Job::Submission::kBusy);
    return Job::Outcome{200U, nullptr, 0U, false};
  }, []() { return 140U; });
  assert(storageCalls == 1U && job.state() == Job::State::kSucceeded);
  assert(servedStatus == 1U && servedOnlineEvent == 1U);
  assert(job.finishedMs() == 140U);
  assert(job.submit(begin, 141U) == Job::Submission::kCompleted);
  assert(storageCalls == 1U);
  assert(job.submit(different, 142U) == Job::Submission::kQueued);
  assert(job.jobId() != firstId);
  job.run([&](const Request&) {
    ++storageCalls;
    return Job::Outcome{500U, "cache_write_failed", 0U, false};
  }, []() { return 160U; });
  assert(storageCalls == 2U && job.state() == Job::State::kFailed);
  assert(strcmp(job.outcome().error, "cache_write_failed") == 0);
  assert(job.submit(different, 161U) == Job::Submission::kQueued);
  job.cancelQueued();
  assert(!job.active() && job.state() == Job::State::kIdle);

  Request item = begin;
  item.operation = dental::cache::CacheOperation::kItem;
  item.index = 0U;
  strcpy(item.product.id, "3");
  strcpy(item.product.barcode, "04806016001569");
  assert(job.submit(item, 200U) == Job::Submission::kQueued);
  Request changed = item;
  strcpy(changed.product.barcode, "4806016001569");
  assert(job.submit(changed, 201U) == Job::Submission::kBusy);
  assert(job.submit(item, 202U) == Job::Submission::kProcessing);
  puts("offline cache publication job tests: PASS");
}
