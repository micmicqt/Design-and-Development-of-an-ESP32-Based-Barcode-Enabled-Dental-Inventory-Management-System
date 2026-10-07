#pragma once

#include <atomic>
#include <stdint.h>
#include <string.h>

#include "offline_inventory_cache.h"

namespace dental { namespace cache {

// One bounded request at a time. submit() never touches storage; the caller
// executes the queued operation outside the synchronous HTTP handler.
class CachePublicationJob {
 public:
  enum class State : uint8_t { kIdle, kQueued, kRunning, kSucceeded, kFailed };
  enum class Submission : uint8_t { kQueued, kProcessing, kCompleted, kBusy };

  struct Outcome {
    Outcome() = default;
    Outcome(uint16_t status, const char* reason, uint32_t received,
            bool current)
        : httpStatus(status), error(reason), receivedItems(received),
          alreadyCurrent(current) {}
    uint16_t httpStatus = 500U;
    const char* error = "cache_operation_failed";
    uint32_t receivedItems = 0U;
    bool alreadyCurrent = false;
  };

  static const char* stateName(State state) {
    switch (state) {
      case State::kIdle: return "IDLE";
      case State::kQueued: return "QUEUED";
      case State::kRunning: return "RUNNING";
      case State::kSucceeded: return "SUCCEEDED";
      case State::kFailed: return "FAILED";
    }
    return "FAILED";
  }

  // Called once during boot, before HTTP is started, so a stale progress URL
  // from an earlier boot cannot ordinarily identify a new operation.
  void seedJobId(uint32_t seed) {
    if (state() == State::kIdle) jobId_.store(seed, std::memory_order_relaxed);
  }

  Submission submit(const CacheRequest& request, uint32_t nowMs) {
    const State current = state_.load(std::memory_order_acquire);
    if (current == State::kQueued || current == State::kRunning)
      return sameRequest(request_, request) ? Submission::kProcessing
                                            : Submission::kBusy;
    if (current == State::kSucceeded && sameRequest(request_, request))
      return Submission::kCompleted;

    request_ = request;
    outcome_ = Outcome{};
    startedMs_.store(nowMs, std::memory_order_relaxed);
    finishedMs_.store(0U, std::memory_order_relaxed);
    uint32_t next = jobId_.load(std::memory_order_relaxed) + 1U;
    if (next == 0U) next = 1U;
    jobId_.store(next, std::memory_order_relaxed);
    state_.store(State::kQueued, std::memory_order_release);
    return Submission::kQueued;
  }

  void cancelQueued() {
    if (state_.load(std::memory_order_acquire) == State::kQueued)
      state_.store(State::kIdle, std::memory_order_release);
  }

  // Only the storage owner calls this. It may run for a long time, but not
  // from a WebServer handler; its completion is published with release order.
  template <typename Operation, typename Clock>
  void run(Operation operation, Clock now) {
    if (state_.load(std::memory_order_acquire) != State::kQueued) return;
    state_.store(State::kRunning, std::memory_order_release);
    const Outcome completed = operation(request_);
    outcome_ = completed;
    finishedMs_.store(now(), std::memory_order_relaxed);
    state_.store(completed.httpStatus == 200U ? State::kSucceeded
                                              : State::kFailed,
                 std::memory_order_release);
  }

  bool active() const {
    const State current = state();
    return current == State::kQueued || current == State::kRunning;
  }
  State state() const { return state_.load(std::memory_order_acquire); }
  uint32_t jobId() const { return jobId_.load(std::memory_order_relaxed); }
  uint32_t startedMs() const { return startedMs_.load(std::memory_order_relaxed); }
  uint32_t finishedMs() const { return finishedMs_.load(std::memory_order_relaxed); }
  const CacheRequest& request() const { return request_; }
  const Outcome& outcome() const { return outcome_; }

 private:
  static bool sameRequest(const CacheRequest& left, const CacheRequest& right) {
    if (left.operation != right.operation ||
        strcmp(left.generation, right.generation) != 0) return false;
    if (left.operation != CacheOperation::kItem)
      return left.itemCount == right.itemCount;
    const CacheProduct& a = left.product;
    const CacheProduct& b = right.product;
    return left.index == right.index && strcmp(a.id, b.id) == 0 &&
           strcmp(a.barcode, b.barcode) == 0 &&
           strcmp(a.name, b.name) == 0 &&
           strcmp(a.category, b.category) == 0 &&
           a.currentStock == b.currentStock &&
           a.lowStockThreshold == b.lowStockThreshold &&
           a.status == b.status;
  }

  std::atomic<State> state_{State::kIdle};
  std::atomic<uint32_t> jobId_{0U};
  std::atomic<uint32_t> startedMs_{0U};
  std::atomic<uint32_t> finishedMs_{0U};
  CacheRequest request_ = {};
  Outcome outcome_ = {};
};

} }  // namespace dental::cache
