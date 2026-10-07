#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <atomic>

namespace dental { namespace offline {

// HTTP-visible state only. The journal itself remains the durable authority.
// The single worker owns all FatFs access until finish() is called.
class AcknowledgementJob {
 public:
  enum class State : uint8_t {
    kIdle, kQueued, kRunning, kVerifying, kSucceeded, kFailed
  };
  enum class Stage : uint8_t {
    kNone, kSourceScan, kTempCleanup, kTempHeader, kCopyRows,
    kTempVerify, kPromote, kInstalledVerify, kDone
  };
  enum class Failure : uint8_t {
    kNone, kWorkerCreate, kJournalUnavailable, kInvalidJournal,
    kWriteFailed, kStorageTimeout, kStorageUnavailable, kStorageRejected,
    kUnexpectedResult
  };
  enum class Request : uint8_t { kStart, kInProgress, kAlreadyDone, kBusy };

  static const char* stateName(State state) {
    switch (state) {
      case State::kIdle: return "IDLE";
      case State::kQueued: return "QUEUED";
      case State::kRunning: return "RUNNING";
      case State::kVerifying: return "VERIFYING";
      case State::kSucceeded: return "SUCCEEDED";
      case State::kFailed: return "FAILED";
    }
    return "FAILED";
  }
  static const char* stageName(Stage stage) {
    switch (stage) {
      case Stage::kNone: return "NONE";
      case Stage::kSourceScan: return "SOURCE_SCAN";
      case Stage::kTempCleanup: return "TEMP_CLEANUP";
      case Stage::kTempHeader: return "TEMP_HEADER";
      case Stage::kCopyRows: return "COPY_ROWS";
      case Stage::kTempVerify: return "TEMP_VERIFY";
      case Stage::kPromote: return "PROMOTE";
      case Stage::kInstalledVerify: return "INSTALLED_VERIFY";
      case Stage::kDone: return "DONE";
    }
    return "NONE";
  }
  static const char* failureName(Failure failure) {
    switch (failure) {
      case Failure::kNone: return "NONE";
      case Failure::kWorkerCreate: return "WORKER_CREATE";
      case Failure::kJournalUnavailable: return "JOURNAL_UNAVAILABLE";
      case Failure::kInvalidJournal: return "INVALID_JOURNAL";
      case Failure::kWriteFailed: return "WRITE_FAILED";
      case Failure::kStorageTimeout: return "STORAGE_TIMEOUT";
      case Failure::kStorageUnavailable: return "STORAGE_UNAVAILABLE";
      case Failure::kStorageRejected: return "STORAGE_REJECTED";
      case Failure::kUnexpectedResult: return "UNEXPECTED_RESULT";
    }
    return "UNEXPECTED_RESULT";
  }

  Request classify(const char* eventId) const {
    if (eventId == nullptr || eventId[0] == '\0') return Request::kBusy;
    const State state = state_.load(std::memory_order_acquire);
    if (state == State::kQueued || state == State::kRunning ||
        state == State::kVerifying)
      return strcmp(eventId_, eventId) == 0 ? Request::kInProgress : Request::kBusy;
    if (state == State::kSucceeded && strcmp(eventId_, eventId) == 0)
      return Request::kAlreadyDone;
    return Request::kStart;
  }

  bool start(const char* eventId, uint32_t pendingCount, uint32_t nowMs = 0U) {
    if (classify(eventId) != Request::kStart ||
        strlen(eventId) >= sizeof(eventId_)) return false;
    memcpy(eventId_, eventId, strlen(eventId) + 1U);
    pendingCount_ = pendingCount;
    startedMs_.store(nowMs, std::memory_order_relaxed);
    elapsedMs_.store(0U, std::memory_order_relaxed);
    stage_.store(Stage::kNone, std::memory_order_relaxed);
    failure_.store(Failure::kNone, std::memory_order_relaxed);
    stackHighWater_.store(0U, std::memory_order_relaxed);
    workerCore_.store(-1, std::memory_order_relaxed);
    if (attempts_.load(std::memory_order_relaxed) < UINT16_MAX)
      attempts_.fetch_add(1U, std::memory_order_relaxed);
    state_.store(State::kQueued, std::memory_order_release);
    return true;
  }

  void markRunning(int8_t core) {
    if (state() != State::kQueued) return;
    workerCore_.store(core, std::memory_order_relaxed);
    state_.store(State::kRunning, std::memory_order_release);
  }
  void setStage(Stage stage) {
    if (!active()) return;
    stage_.store(stage, std::memory_order_release);
    if (stage == Stage::kInstalledVerify)
      state_.store(State::kVerifying, std::memory_order_release);
  }
  void recordStackHighWater(uint32_t bytes) {
    stackHighWater_.store(bytes, std::memory_order_release);
  }
  void finish(bool durable, uint32_t nowMs = 0U,
              Failure failure = Failure::kUnexpectedResult) {
    if (!active()) return;
    elapsedMs_.store(nowMs - startedMs_.load(std::memory_order_relaxed),
                     std::memory_order_relaxed);
    failure_.store(durable ? Failure::kNone : failure,
                   std::memory_order_relaxed);
    if (durable) stage_.store(Stage::kDone, std::memory_order_relaxed);
    state_.store(durable ? State::kSucceeded : State::kFailed,
                 std::memory_order_release);
  }

  void cancelStart(uint32_t nowMs = 0U) {
    finish(false, nowMs, Failure::kWorkerCreate);
  }

  State state() const { return state_.load(std::memory_order_acquire); }
  bool active() const {
    const State current = state();
    return current == State::kQueued || current == State::kRunning ||
           current == State::kVerifying;
  }
  bool running() const { return active(); }
  const char* eventId() const { return eventId_; }
  uint32_t pendingCountBefore() const { return pendingCount_; }
  Stage stage() const { return stage_.load(std::memory_order_acquire); }
  Failure failure() const { return failure_.load(std::memory_order_acquire); }
  uint32_t startedMs() const { return startedMs_.load(std::memory_order_acquire); }
  uint32_t elapsedMs(uint32_t nowMs) const {
    return active() ? nowMs - startedMs() :
      elapsedMs_.load(std::memory_order_acquire);
  }
  uint16_t attempts() const { return attempts_.load(std::memory_order_acquire); }
  uint32_t stackHighWater() const {
    return stackHighWater_.load(std::memory_order_acquire);
  }
  int8_t workerCore() const { return workerCore_.load(std::memory_order_acquire); }

 private:
  std::atomic<State> state_{State::kIdle};
  std::atomic<Stage> stage_{Stage::kNone};
  std::atomic<Failure> failure_{Failure::kNone};
  std::atomic<uint32_t> startedMs_{0U};
  std::atomic<uint32_t> elapsedMs_{0U};
  std::atomic<uint16_t> attempts_{0U};
  std::atomic<uint32_t> stackHighWater_{0U};
  std::atomic<int8_t> workerCore_{-1};
  char eventId_[40] = {};
  uint32_t pendingCount_ = 0U;
};

}} // namespace dental::offline
