#pragma once

#include "hardware_config.h"
#include "sd_spi_config.h"
#include "../../firmware-common/include/storage_link_protocol.h"
#include <stdint.h>
#include <string.h>

namespace dental_atmega { namespace storage {

enum class State : uint8_t { kUnavailable, kReady, kIoError };

struct ReadAttempt {
  ReadAttempt(bool succeeded = false,
              dental_link::storage::diagnostic::ReadFailureReason why =
                  dental_link::storage::diagnostic::ReadFailureReason::kNone,
              uint8_t response = 0xFFU, uint8_t dataToken = 0xFFU)
      : success(succeeded), reason(why), r1(response), token(dataToken) {}
  bool success;
  dental_link::storage::diagnostic::ReadFailureReason reason;
  uint8_t r1;
  uint8_t token;
};

inline ReadAttempt classifyReadAttempt(uint8_t response, uint8_t token) {
  using dental_link::storage::diagnostic::ReadFailureReason;
  if (response != 0U)
    return ReadAttempt(false, ReadFailureReason::kCmd17R1, response, token);
  if (token == 0xFEU)
    return ReadAttempt(true, ReadFailureReason::kNone, response, token);
  return ReadAttempt(
      false,
      token == 0xFFU ? ReadFailureReason::kDataTokenTimeout
                     : ReadFailureReason::kDataTokenInvalid,
      response, token);
}

struct ReadOperation {
  bool success = false;
  uint8_t attempts = 0U;
  ReadAttempt diagnostic;
};

// One retry belongs only to the low-level CMD17/token bootstrap. No sector
// bytes are exposed until an attempt has returned a valid data token.
template <typename Attempt, typename Recover>
ReadOperation readWithOneRetry(uint32_t sector, Attempt attempt,
                               Recover recover) {
  ReadOperation result;
  const ReadAttempt first = attempt(sector);
  result.attempts = 1U;
  result.diagnostic = first;
  if (first.success) {
    result.success = true;
    return result;
  }
  if (!dental_link::storage::diagnostic::readFailureIsRetryable(first.reason))
    return result;

  result.attempts = 2U;
  if (!recover()) {
    result.diagnostic = ReadAttempt(
        false,
        dental_link::storage::diagnostic::ReadFailureReason::kWaitReadyTimeout);
    return result;
  }
  const ReadAttempt second = attempt(sector);
  if (second.success) {
    result.success = true;
    result.diagnostic = first; // Retain the transient reason for diagnostics.
  } else {
    result.diagnostic = second;
  }
  return result;
}

inline bool readFailureInvalidatesCard(const ReadOperation& operation) {
  return !operation.success &&
      dental_link::storage::diagnostic::readFailureIsRetryable(
          operation.diagnostic.reason);
}

// Temporary Step 5 bring-up snapshot. Values are recorded after command timing
// completes, then exported only when the ESP32 explicitly requests SD:DIAG.
struct Diagnostic {
  static constexpr uint8_t kLength = dental_link::storage::diagnostic::kLength;
  uint8_t bytes[kLength] = {};
};

// A separate, explicitly requested snapshot. No sector data or poll stream is
// retained, and normal SD:DIAG version 3 remains unchanged.
struct ReadTrace {
  static constexpr uint8_t kLength = dental_link::storage::read_trace::kLength;
  static constexpr uint8_t kVersion = dental_link::storage::read_trace::kVersion;
  enum : uint8_t {
    kValid = dental_link::storage::read_trace::kValid,
    kBlockAddressed = dental_link::storage::read_trace::kBlockAddressed,
    kAttempted = dental_link::storage::read_trace::kAttempted,
    kR1Timeout = dental_link::storage::read_trace::kR1Timeout,
    kTokenTimeout = dental_link::storage::read_trace::kTokenTimeout,
    kCsRaised = dental_link::storage::read_trace::kCsRaised,
    kTrailingClock = dental_link::storage::read_trace::kTrailingClock,
    kTokenAccepted = dental_link::storage::read_trace::kTokenAccepted,
    kRetryHighClock = dental_link::storage::read_trace::kRetryHighClock,
    kRetrySelected = dental_link::storage::read_trace::kRetrySelected,
    kRetryReady = dental_link::storage::read_trace::kRetryReady,
    kRetryCsRaised = dental_link::storage::read_trace::kRetryCsRaised,
    kRetryTrailingClock = dental_link::storage::read_trace::kRetryTrailingClock
  };
  struct Attempt {
    spi_config::CommandObservation command;
    uint8_t token = 0xFFU;
    uint8_t flags = 0U;
  };
  uint32_t sector = 0U;
  uint32_t argument = 0U;
  uint8_t flags = 0U;
  uint8_t finalReason = 0U;
  uint8_t retryReadyByte = 0xFFU;
  uint8_t retryFlags = 0U;
  Attempt attempts[2];

  void start(uint32_t parsedSector, bool blockAddressing) {
    *this = ReadTrace{};
    sector = parsedSector;
    if (blockAddressing) flags |= kBlockAddressed;
  }
  void finish(bool failed, dental_link::storage::diagnostic::ReadFailureReason reason) {
    finalReason = static_cast<uint8_t>(reason);
    if (failed) flags |= kValid;
  }
  void encode(uint8_t (&bytes)[kLength]) const {
    bytes[0] = kVersion;
    bytes[1] = flags;
    bytes[2] = finalReason;
    for (uint8_t index = 0U; index < 4U; ++index) {
      const uint8_t shift = static_cast<uint8_t>(24U - index * 8U);
      bytes[3U + index] = static_cast<uint8_t>(sector >> shift);
      bytes[7U + index] = static_cast<uint8_t>(argument >> shift);
    }
    bytes[11] = retryReadyByte;
    bytes[12] = retryFlags;
    for (uint8_t index = 0U; index < 2U; ++index) {
      const uint8_t base = static_cast<uint8_t>(13U + index * 6U);
      bytes[base] = attempts[index].command.selectedByte;
      bytes[base + 1U] = attempts[index].command.pollIndex;
      bytes[base + 2U] = attempts[index].command.precedingByte;
      bytes[base + 3U] = attempts[index].command.candidate;
      bytes[base + 4U] = attempts[index].token;
      bytes[base + 5U] = attempts[index].flags;
    }
  }
};

struct StreamMetrics {
  uint8_t framesAttempted = 0U;
  uint8_t framesAccepted = 0U;
  uint16_t deferred = 0U;
  uint8_t framesRejected = 0U;
  uint16_t finalGeneratedOffset = 0xFFFFU;
  uint16_t finalAcceptedOffset = 0xFFFFU;
  uint8_t okAttempted = 0U;
  uint8_t okAccepted = 0U;
  uint8_t queueHighWater = 0U;
};

inline bool plausibleStreamMetrics(const StreamMetrics& metrics) {
  const bool generatedKnown = metrics.finalGeneratedOffset != 0xFFFFU;
  const bool acceptedKnown = metrics.finalAcceptedOffset != 0xFFFFU;
  return metrics.framesAttempted <= 22U &&
      metrics.framesAccepted <= metrics.framesAttempted &&
      metrics.framesRejected <= 1U &&
      metrics.okAccepted <= metrics.okAttempted &&
      (metrics.framesAttempted != 0U || !generatedKnown) &&
      (metrics.framesAccepted != 0U || !acceptedKnown) &&
      (!generatedKnown || (metrics.finalGeneratedOffset <= 504U &&
                           metrics.finalGeneratedOffset % 24U == 0U)) &&
      (!acceptedKnown || (metrics.finalAcceptedOffset <= 504U &&
                          metrics.finalAcceptedOffset % 24U == 0U)) &&
      (!acceptedKnown || (generatedKnown &&
                          metrics.finalAcceptedOffset <= metrics.finalGeneratedOffset));
}

class RawCard {
 public:
  bool initialize();
  State state() const { return state_; }
  bool sync();
  bool beginRead(uint32_t sector);
  bool readChunk(uint8_t* data, uint8_t capacity, uint8_t& length, bool& complete);
  bool beginWrite(uint32_t sector);
  bool writeChunk(const uint8_t* data, uint8_t length, bool& complete);
  void abort();
  const Diagnostic& diagnostic() const { return diagnostic_; }
  const ReadTrace& readTrace() const { return readTrace_; }
 private:
  enum class Transfer : uint8_t { kIdle, kRead, kWrite };
  void select(bool enabled);
  uint8_t transfer(uint8_t value);
  void deselect();
  bool waitReady(uint8_t* lastByte = nullptr);
  uint8_t command(uint8_t command, uint32_t argument);
  ReadAttempt beginReadAttempt(uint32_t sector);
  bool recoverRead();
  void recordRead(uint32_t sector, const ReadOperation& operation);
  void fail();
  State state_ = State::kUnavailable;
  spi_config::PowerUpSettle powerUpSettle_;
  Transfer transfer_ = Transfer::kIdle;
  uint16_t position_ = 0U;
  uint8_t cardType_ = 0U;
  Diagnostic diagnostic_;
  ReadTrace readTrace_;
  uint8_t traceStage_ = 0U; // 0=none, 1/3=CMD17 attempts, 2=retry readiness.
  uint8_t lastCommandTrace_ = 0U;
};

template <typename Card>
class Link {
 public:
  explicit Link(Card& card) : card_(card) {}
  void receive(uint8_t byte, bool error) {
    if (error) { parser_ = dental_link::storage::BasicParser<60U>{}; return; }
    const dental_link::storage::Frame frame = parser_.receive(byte);
    if (frame.operation != dental_link::storage::Operation::kNone) handle(frame);
  }
  template <typename Transmitter>
  void service(Transmitter& transmitter) {
    if (reading_ && !streamMetricsStarted_) {
      transmitter.resetQueueMetrics();
      streamMetricsStarted_ = true;
    }
    const uint8_t highWater = transmitter.queueHighWater();
    if (highWater > streamMetrics_.queueHighWater)
      streamMetrics_.queueHighWater = highWater;
    if (length_ != 0U) {
      if (!transmitter.tryWrite(static_cast<uint8_t>(output_[position_]))) {
        if (streamMetrics_.deferred != 0xFFFFU) ++streamMetrics_.deferred;
        return;
      }
      if (++position_ == length_) {
        if (outputKind_ == OutputKind::kReadData) {
          if (streamMetrics_.framesAccepted != 0xFFU)
            ++streamMetrics_.framesAccepted;
          streamMetrics_.finalAcceptedOffset = pendingChunkOffset_;
          readOffset_ = static_cast<uint16_t>(readOffset_ + pendingChunkLength_);
          if (pendingChunkCompletes_) {
            readCompletionPending_ = true;
          }
        } else if (outputKind_ == OutputKind::kReadCompletion) {
          streamMetrics_.okAccepted = 1U;
        } else if (outputKind_ == OutputKind::kReadError) {
          streamFlags_ |= 4U;
        }
        length_ = position_ = 0U;
        outputKind_ = OutputKind::kControl;
      }
      return;
    }
    if (abortPending_) {
      abortPending_ = false; resetTransfer(); queueIdle(); return;
    }
    if (readCompletionPending_) {
      readCompletionPending_ = false; reading_ = false;
      streamMetrics_.okAttempted = 1U;
      queue(DENTAL_TEXT_LITERAL("SD:OK\n")); outputKind_ = OutputKind::kReadCompletion; return;
    }
    if (!reading_) return;
    uint8_t data[dental_link::storage::kChunkBytes] = {};
    uint8_t count = 0U; bool complete = false;
    if (!card_.readChunk(data, sizeof(data), count, complete) || count == 0U) {
      if (streamMetrics_.framesRejected != 0xFFU) ++streamMetrics_.framesRejected;
      resetTransfer(); queueReadError(); return;
    }
    pendingChunkOffset_ = readOffset_;
    pendingChunkLength_ = count;
    pendingChunkCompletes_ = complete;
    if (streamMetrics_.framesAttempted != 0xFFU) ++streamMetrics_.framesAttempted;
    streamMetrics_.finalGeneratedOffset = pendingChunkOffset_;
    if (!dental_link::storage::encodeData(pendingChunkOffset_, data, count, output_,
                                          sizeof(output_))) {
      if (streamMetrics_.framesRejected != 0xFFU) ++streamMetrics_.framesRejected;
      resetTransfer(); queueReadError(); return;
    }
    length_ = static_cast<uint8_t>(strlen(output_)); position_ = 0U;
    outputKind_ = OutputKind::kReadData;
  }
  bool transmitting() const {
    return length_ != 0U || reading_ || readCompletionPending_;
  }
  // A sector read can remain open between complete SD:DATA lines. Only the
  // currently queued line owns USART TX; other replies may use those gaps.
  bool outputFrameActive() const { return length_ != 0U; }
  const StreamMetrics& streamMetrics() const { return streamMetrics_; }
 private:
  enum class OutputKind : uint8_t { kControl, kReadData, kReadCompletion, kReadError };
  void handle(const dental_link::storage::Frame& frame) {
    using dental_link::storage::Operation;
    if (length_ != 0U) {
      // Finish the current text frame so a queued UART prefix cannot be joined
      // to SD:OK. Abort takes effect at that frame boundary before another SD
      // chunk is read; other commands remain serialized behind the transfer.
      if (frame.operation == Operation::kAbort) {
        captureAbortState();
        abortPending_ = true;
        abortSequence_ = frame.sector;
      }
      return;
    }
    // Logical stream ownership survives gaps between complete text frames.
    // Only ABORT may retire a read; DATA is the only write continuation.
    // Do not replace a queued response or splice a second sector into it.
    if ((reading_ || readCompletionPending_ || writing_) &&
        frame.operation != Operation::kAbort &&
        !(writing_ && frame.operation == Operation::kData)) return;
    switch (frame.operation) {
      case Operation::kStatus:
        resetTransfer();
        {
          const bool reinitialize = card_.state() != State::kReady;
          if (reinitialize) card_.initialize();
          queue(card_.state() != State::kReady ? DENTAL_TEXT_LITERAL("SD:UNAVAILABLE\n") :
                reinitialize ? DENTAL_TEXT_LITERAL("SD:REINIT_READY\n") :
                DENTAL_TEXT_LITERAL("SD:READY\n"));
        }
        break;
      case Operation::kAbort:
        captureAbortState();
        abortSequence_ = frame.sector;
        resetTransfer(); queueIdle(); break;
      case Operation::kDiagnostic:
        if (frame.length == 0U) queueDiagnostic();
        else queue(DENTAL_TEXT_LITERAL("SD:ERROR\n"));
        break;
      case Operation::kReadTrace:
        if (frame.length == 0U && !reading_ && !writing_ &&
            !readCompletionPending_) queueReadTrace();
        else queue(DENTAL_TEXT_LITERAL("SD:ERROR\n"));
        break;
      case Operation::kStreamDiagnostic:
        if (frame.length == 0U && !reading_ && !readCompletionPending_)
          queueStreamDiagnostic();
        else queue(DENTAL_TEXT_LITERAL("SD:ERROR\n"));
        break;
      case Operation::kSync: queue(card_.sync() ? DENTAL_TEXT_LITERAL("SD:OK\n") : DENTAL_TEXT_LITERAL("SD:ERROR\n")); break;
      case Operation::kReadSector:
        resetTransfer();
        reading_ = card_.beginRead(frame.sector);
        readOffset_ = 0U;
        streamMetrics_ = StreamMetrics{};
        streamFlags_ = 0U;
        streamMetricsStarted_ = false;
        if (!reading_) queueReadError();
        break;
      case Operation::kWriteSector:
        resetTransfer();
        writing_ = card_.beginWrite(frame.sector);
        writeOffset_ = 0U;
        queue(writing_ ? DENTAL_TEXT_LITERAL("SD:OK\n") : DENTAL_TEXT_LITERAL("SD:ERROR\n"));
        break;
      case Operation::kData: {
        if (!writing_ || frame.offset != writeOffset_) {
          resetTransfer(); queue(DENTAL_TEXT_LITERAL("SD:ERROR\n")); break;
        }
        bool complete = false;
        const bool ok = card_.writeChunk(frame.data, frame.length, complete);
        if (ok) writeOffset_ = static_cast<uint16_t>(writeOffset_ + frame.length);
        if (!ok || complete) writing_ = false;
        queue(ok ? DENTAL_TEXT_LITERAL("SD:OK\n") : DENTAL_TEXT_LITERAL("SD:ERROR\n"));
        break;
      }
      case Operation::kRejected: resetTransfer(); queue(DENTAL_TEXT_LITERAL("SD:ERROR\n")); break;
      default: break; // Other controller-link protocols are ignored.
    }
  }
  void queue(const char* line) {
    if (length_ != 0U) return;
    const size_t size = dental_link::text::length(line);
    if (size == 0U || size >= sizeof(output_)) return;
    dental_link::text::copy(output_, line, size); length_ = static_cast<uint8_t>(size); position_ = 0U;
  }
  void queueReadError() {
    streamFlags_ |= 2U;
    queue(DENTAL_TEXT_LITERAL("SD:ERROR\n")); outputKind_ = OutputKind::kReadError;
  }
  uint8_t transferState() const {
    return readCompletionPending_ ? 3U : reading_ ? 1U : writing_ ? 2U : 0U;
  }
  void captureAbortState() {
    if ((streamFlags_ & 1U) == 0U) {
      abortQueuedBytes_ = static_cast<uint8_t>(length_ - position_);
      abortTransferState_ = transferState();
    }
    streamFlags_ |= 1U;
  }
  void queueIdle() {
    if (abortSequence_ == 0U) { queue(DENTAL_TEXT_LITERAL("SD:IDLE\n")); return; }
    dental_link::text::copy(output_, DENTAL_TEXT_LITERAL("SD:IDLE:"), 8U);
    for (uint8_t index = 0U; index < 8U; ++index)
      output_[8U + index] = static_cast<char>(dental_link::storage::hexDigit(
          static_cast<uint8_t>((abortSequence_ >> (28U - index * 4U)) & 15U)));
    output_[16] = '\n';
    length_ = 17U; position_ = 0U;
  }
  void resetTransfer() {
    if (reading_ || writing_) card_.abort();
    reading_ = readCompletionPending_ = writing_ = false;
    readOffset_ = writeOffset_ = 0U;
    pendingChunkOffset_ = 0U; pendingChunkLength_ = 0U;
    pendingChunkCompletes_ = false; streamMetricsStarted_ = false;
  }
  void queueDiagnostic() {
    if (!dental_link::storage::encodeDiagnostic(card_.diagnostic().bytes,
                                                Diagnostic::kLength, output_,
                                                sizeof(output_))) return;
    length_ = static_cast<uint8_t>(strlen(output_)); position_ = 0U;
  }
  void queueReadTrace() {
    const ReadTrace& trace = card_.readTrace();
    if ((trace.flags & ReadTrace::kValid) == 0U) {
      queue(DENTAL_TEXT_LITERAL("SD:ERROR\n")); return;
    }
    uint8_t bytes[ReadTrace::kLength];
    trace.encode(bytes);
    if (!dental_link::storage::encodeDiagnostic(bytes, sizeof(bytes), output_,
                                                sizeof(output_))) return;
    length_ = static_cast<uint8_t>(strlen(output_)); position_ = 0U;
  }
  void queueStreamDiagnostic() {
    using namespace dental_link::storage::stream_diagnostic;
    if (!plausibleStreamMetrics(streamMetrics_)) {
      queue(DENTAL_TEXT_LITERAL("SD:ERROR\n"));
      return;
    }
    uint8_t bytes[kLength] = {};
    bytes[kVersion] = 2U;
    bytes[kFramesAttempted] = streamMetrics_.framesAttempted;
    bytes[kFramesAccepted] = streamMetrics_.framesAccepted;
    bytes[kDeferredHigh] = static_cast<uint8_t>(streamMetrics_.deferred >> 8U);
    bytes[kDeferredLow] = static_cast<uint8_t>(streamMetrics_.deferred);
    bytes[kFramesRejected] = streamMetrics_.framesRejected;
    bytes[kFinalGeneratedHigh] = static_cast<uint8_t>(
        streamMetrics_.finalGeneratedOffset >> 8U);
    bytes[kFinalGeneratedLow] = static_cast<uint8_t>(
        streamMetrics_.finalGeneratedOffset);
    bytes[kFinalAcceptedHigh] = static_cast<uint8_t>(
        streamMetrics_.finalAcceptedOffset >> 8U);
    bytes[kFinalAcceptedLow] = static_cast<uint8_t>(
        streamMetrics_.finalAcceptedOffset);
    bytes[kOkAttempted] = streamMetrics_.okAttempted;
    bytes[kOkAccepted] = streamMetrics_.okAccepted;
    bytes[kQueueHighWater] = streamMetrics_.queueHighWater;
    const uint32_t sector = card_.readTrace().sector;
    for (uint8_t index = 0U; index < 4U; ++index)
      bytes[kSector + index] = static_cast<uint8_t>(sector >> (24U - index * 8U));
    bytes[kFlags] = streamFlags_;
    bytes[kQueuedBytes] = (streamFlags_ & 1U) ? abortQueuedBytes_ : static_cast<uint8_t>(length_ - position_);
    bytes[kTransferState] = (streamFlags_ & 1U) ? abortTransferState_ : transferState();
    if (!dental_link::storage::encodeStreamDiagnostic(
            bytes, kLength, output_, sizeof(output_))) return;
    length_ = static_cast<uint8_t>(strlen(output_)); position_ = 0U;
  }
  Card& card_;
  // Incoming commands top out at a 24-byte SD:DATA write (60 text bytes).
  // Larger diagnostic replies are transmitted, never parsed on the ATmega.
  dental_link::storage::BasicParser<60U> parser_;
  char output_[dental_link::storage::kMaximumFrameLength + 2U] = {};
  uint8_t length_ = 0U, position_ = 0U;
  OutputKind outputKind_ = OutputKind::kControl;
  bool reading_ = false, readCompletionPending_ = false, writing_ = false;
  uint16_t readOffset_ = 0U, writeOffset_ = 0U;
  uint16_t pendingChunkOffset_ = 0U;
  uint8_t pendingChunkLength_ = 0U;
  bool pendingChunkCompletes_ = false;
  bool streamMetricsStarted_ = false;
  bool abortPending_ = false;
  uint32_t abortSequence_ = 0U;
  uint8_t streamFlags_ = 0U;
  uint8_t abortQueuedBytes_ = 0U, abortTransferState_ = 0U;
  StreamMetrics streamMetrics_;
};

} }
