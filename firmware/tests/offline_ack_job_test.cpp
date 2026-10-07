#include "offline_ack_job.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>

using Job = dental::offline::AcknowledgementJob;

int main() {
  Job job;
  const char* first = "off-AAAAAAAAAAAA-0000000000000001";
  const char* next = "off-AAAAAAAAAAAA-0000000000000002";
  assert(job.classify(first) == Job::Request::kStart);
  char requestId[40] = {};
  strcpy(requestId, first);
  assert(job.start(requestId, 1U, 0xfffffff0U));
  memset(requestId, 'X', strlen(requestId));
  assert(job.state() == Job::State::kQueued);
  assert(job.running() && job.pendingCountBefore() == 1U);
  assert(strcmp(job.eventId(), first) == 0);
  assert(job.attempts() == 1U);
  assert(job.classify(first) == Job::Request::kInProgress);
  assert(job.classify(next) == Job::Request::kBusy);
  assert(!job.start(next, 1U));
  job.markRunning(1);
  assert(job.state() == Job::State::kRunning && job.workerCore() == 1);
  job.setStage(Job::Stage::kCopyRows);
  job.recordStackHighWater(4096U);
  assert(job.stage() == Job::Stage::kCopyRows);
  assert(job.stackHighWater() == 4096U);
  job.setStage(Job::Stage::kInstalledVerify);
  assert(job.state() == Job::State::kVerifying);
  job.finish(false, 0x10U, Job::Failure::kStorageTimeout);
  assert(!job.running());
  assert(job.elapsedMs(0x10U) == 32U);
  assert(job.failure() == Job::Failure::kStorageTimeout);
  assert(job.classify(first) == Job::Request::kStart);
  assert(job.start(first, 1U, 123U));
  job.markRunning(1);
  job.finish(true, 128U);
  assert(job.state() == Job::State::kSucceeded);
  assert(job.stage() == Job::Stage::kDone);
  assert(job.failure() == Job::Failure::kNone);
  assert(job.elapsedMs(128U) == 5U);
  assert(job.classify(first) == Job::Request::kAlreadyDone);
  assert(job.classify(next) == Job::Request::kStart);
  assert(job.start(next, 1U, 200U));
  job.cancelStart(201U);
  assert(job.state() == Job::State::kFailed);
  assert(job.failure() == Job::Failure::kWorkerCreate);
  assert(job.classify(next) == Job::Request::kStart);
  assert(job.attempts() == 3U);
  puts("offline ACK job tests: PASS");
}
