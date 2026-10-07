#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "immutable_text.h"

namespace dental_link { namespace storage {

constexpr uint8_t kChunkBytes = 24U;
constexpr uint8_t kDiagnosticBytes = 33U;
constexpr uint8_t kMaximumPayloadBytes = kDiagnosticBytes;
constexpr uint8_t kMaximumFrameLength = 74U;
constexpr uint16_t kSectorBytes = 512U;

namespace diagnostic {
constexpr uint8_t kLength = kDiagnosticBytes;
enum Index : uint8_t {
  kVersion = 0U, kStage = 1U, kFlags = 2U, kMoreFlags = 3U,
  kCmd0 = 4U, kCmd8 = 5U, kR7 = 6U, kAcmd41 = 10U,
  kAcmd41AttemptsHigh = 11U, kAcmd41AttemptsLow = 12U, kCmd58 = 13U,
  kOcr = 14U, kCardType = 18U, kCmd16 = 19U, kReadR1 = 20U,
  kReadToken = 21U, kReadFlags = 22U, kCmd0Trace = 23U,
  kDdrb = 24U, kPortb = 25U, kSpcr = 26U, kSpsr = 27U,
  kCmd0AttemptCount = 28U, kCmd0FirstR1 = 29U, kCmd0LastR1 = 30U,
  kCmd0ElapsedHigh = 31U, kCmd0ElapsedLow = 32U
};
constexpr uint8_t kSpiConfigured = 0x01U, kChipSelectHigh = 0x02U,
    kStartupClocksSent = 0x04U, kCmd0TimedOut = 0x08U,
    kCmd8TimedOut = 0x10U, kAcmd41TimedOut = 0x20U,
    kCmd58TimedOut = 0x40U, kCmd16TimedOut = 0x80U;
constexpr uint8_t kSdV2 = 0x10U, kBlockAddressing = 0x20U,
    kCmd16Issued = 0x40U, kInitializationSucceeded = 0x80U;
constexpr uint8_t kRuntimeReadReady = 0x01U, kRuntimeReadRetried = 0x02U,
    kRuntimeReadTransferBusy = 0x04U;
constexpr uint8_t kReadAttempted = 0x01U, kReadSucceeded = 0x02U,
    kReadR1TimedOut = 0x04U, kReadTokenTimedOut = 0x08U,
    kReadWasSectorZero = 0x10U;
enum class ReadFailureReason : uint8_t {
  kNone = 0U,
  kNotReady = 1U,
  kTransferState = 2U,
  kWaitReadyTimeout = 3U,
  kCmd17R1 = 4U,
  kDataTokenTimeout = 5U,
  kDataTokenInvalid = 6U
};
constexpr uint8_t kReadFailureShift = 5U;
constexpr uint8_t kReadFailureMask = 0xE0U;
constexpr uint8_t readFailureBits(ReadFailureReason reason) {
  return static_cast<uint8_t>(static_cast<uint8_t>(reason) <<
                              kReadFailureShift);
}
constexpr ReadFailureReason readFailureReason(uint8_t flags) {
  return static_cast<ReadFailureReason>(
      (flags & kReadFailureMask) >> kReadFailureShift);
}
constexpr bool readFailureIsRetryable(ReadFailureReason reason) {
  return reason == ReadFailureReason::kWaitReadyTimeout ||
      reason == ReadFailureReason::kCmd17R1 ||
      reason == ReadFailureReason::kDataTokenTimeout ||
      reason == ReadFailureReason::kDataTokenInvalid;
}
constexpr uint8_t kCommandPacketSent = 0x01U,
    kCommandReadyTimedOut = 0x02U, kCommandResponseTimedOut = 0x04U,
    kCmd0ReadyWaitSkipped = 0x08U;
}

namespace stream_diagnostic {
constexpr uint8_t kLength = 20U;
enum Index : uint8_t {
  kVersion = 0U, kFramesAttempted = 1U, kFramesAccepted = 2U,
  kDeferredHigh = 3U, kDeferredLow = 4U, kFramesRejected = 5U,
  kFinalGeneratedHigh = 6U, kFinalGeneratedLow = 7U,
  kFinalAcceptedHigh = 8U, kFinalAcceptedLow = 9U,
  kOkAttempted = 10U, kOkAccepted = 11U, kQueueHighWater = 12U,
  kSector = 13U, kFlags = 17U, kQueuedBytes = 18U, kTransferState = 19U
};
}

// SD:TRACE request; SD:DIAG response with this distinct fixed payload length.
namespace read_trace {
constexpr uint8_t kVersion = 1U;
constexpr uint8_t kLength = 25U;
constexpr uint8_t kValid = 0x01U, kBlockAddressed = 0x02U;
constexpr uint8_t kAttempted = 0x01U, kR1Timeout = 0x02U,
    kTokenTimeout = 0x04U, kCsRaised = 0x08U,
    kTrailingClock = 0x10U, kTokenAccepted = 0x20U;
constexpr uint8_t kRetryHighClock = 0x01U, kRetrySelected = 0x02U,
    kRetryReady = 0x04U, kRetryCsRaised = 0x08U,
    kRetryTrailingClock = 0x10U;
}

enum class Operation : uint8_t { kNone, kStatus, kSync, kAbort, kReadSector,
  kWriteSector, kData, kDiagnostic, kStreamDiagnostic, kReadTrace,
  kOk, kIdle, kError, kReady, kReinitializedReady, kUnavailable,
  kRejected };
enum class RejectionReason : uint8_t {
  kNone,
  kMalformed,
  kInvalidByte,
  kLineOverflow,
  kInvalidHex
};
struct Frame { Operation operation = Operation::kNone; uint32_t sector = 0UL;
  uint16_t offset = 0U; uint8_t data[kMaximumPayloadBytes] = {}; uint8_t length = 0U; };

// A waiter owns a completed response until it explicitly consumes it.
// Reentrant controller servicing cannot replace DATA with a later terminal.
struct ResponseMailbox {
  Frame frame;
  bool available = false;
  bool publish(const Frame& incoming) {
    if (available) return false;
    frame = incoming; available = true; return true;
  }
};
inline bool matchesIdleFence(const Frame& frame, uint32_t sequence) {
  return sequence != 0U && frame.operation == Operation::kIdle &&
      frame.sector == sequence;
}

inline uint8_t hexDigit(uint8_t value) {
  return static_cast<uint8_t>(value < 10U ? '0' + value : 'A' + value - 10U);
}
inline bool parseHex(char value, uint8_t& digit) {
  if (value >= '0' && value <= '9') digit = static_cast<uint8_t>(value - '0');
  else if (value >= 'A' && value <= 'F') digit = static_cast<uint8_t>(value - 'A' + 10U);
  else if (value >= 'a' && value <= 'f') digit = static_cast<uint8_t>(value - 'a' + 10U);
  else return false;
  return true;
}
inline bool encodeData(uint16_t offset, const uint8_t* data, uint8_t length,
                       char* output, size_t capacity) {
  if (!data || !output || offset >= kSectorBytes || length == 0U ||
      offset + length > kSectorBytes || length > kChunkBytes ||
      capacity < 14U + length * 2U)
    return false;
  text::copy(output, DENTAL_TEXT_LITERAL("SD:DATA:"), 8U);
  for (uint8_t index = 0U; index < 3U; ++index)
    output[8U + index] = static_cast<char>(hexDigit(static_cast<uint8_t>(
        (offset >> (8U - index * 4U)) & 15U)));
  output[11U] = ':';
  for (uint8_t index = 0U; index < length; ++index) {
    output[12U + index * 2U] = static_cast<char>(hexDigit(data[index] >> 4U));
    output[13U + index * 2U] = static_cast<char>(hexDigit(data[index] & 15U));
  }
  output[12U + length * 2U] = '\n'; output[13U + length * 2U] = '\0';
  return true;
}
inline bool encodeDiagnostic(const uint8_t* data, uint8_t length, char* output,
                             size_t capacity) {
  if (!data || !output || length == 0U || length > kDiagnosticBytes ||
      capacity < 10U + length * 2U) return false;
  text::copy(output, DENTAL_TEXT_LITERAL("SD:DIAG:"), 8U);
  for (uint8_t index = 0U; index < length; ++index) {
    output[8U + index * 2U] = static_cast<char>(hexDigit(data[index] >> 4U));
    output[9U + index * 2U] = static_cast<char>(hexDigit(data[index] & 15U));
  }
  output[8U + length * 2U] = '\n'; output[9U + length * 2U] = '\0';
  return true;
}
inline bool encodeStreamDiagnostic(const uint8_t* data, uint8_t length,
                                   char* output, size_t capacity) {
  if (!data || !output || length != stream_diagnostic::kLength ||
      capacity < 12U + length * 2U) return false;
  text::copy(output, DENTAL_TEXT_LITERAL("SD:STREAM:"), 10U);
  for (uint8_t index = 0U; index < length; ++index) {
    output[10U + index * 2U] = static_cast<char>(hexDigit(data[index] >> 4U));
    output[11U + index * 2U] = static_cast<char>(hexDigit(data[index] & 15U));
  }
  output[10U + length * 2U] = '\n';
  output[11U + length * 2U] = '\0';
  return true;
}
inline bool encodeSector(Operation operation, uint32_t sector, char* output,
                         size_t capacity) {
  if (!output || capacity < 15U || (operation != Operation::kReadSector &&
      operation != Operation::kWriteSector)) return false;
  text::copy(output, operation == Operation::kReadSector ?
      DENTAL_TEXT_LITERAL("SD:R:") : DENTAL_TEXT_LITERAL("SD:W:"), 5U);
  for (uint8_t index = 0U; index < 8U; ++index)
    output[5U + index] = static_cast<char>(hexDigit(static_cast<uint8_t>(
        (sector >> (28U - index * 4U)) & 15U)));
  output[13] = '\n'; output[14] = '\0'; return true;
}

template <uint8_t Capacity>
class BasicParser {
 public:
  static_assert(Capacity >= 60U && Capacity <= kMaximumFrameLength,
                "Storage parser must fit a maximum SD:DATA write frame");
  Frame receive(uint8_t byte) {
    if (byte == '\n') {
      lastLineLength_ = length_;
      lastLineWasStorage_ = length_ >= 3U && buffer_[0] == 'S' &&
                            buffer_[1] == 'D' && buffer_[2] == ':';
      lastRejectionReason_ = pendingRejectionReason_;
      buffer_[length_] = '\0'; Frame result;
      if (rejected_) result.operation = Operation::kRejected;
      else result = parseLine();
      if (result.operation == Operation::kRejected &&
          lastRejectionReason_ == RejectionReason::kNone)
        lastRejectionReason_ = RejectionReason::kMalformed;
      length_ = 0U; rejected_ = false;
      pendingRejectionReason_ = RejectionReason::kNone;
      return result;
    }
    if (rejected_) return {};
    if (length_ >= Capacity) {
      rejected_ = true;
      pendingRejectionReason_ = RejectionReason::kLineOverflow;
      return {};
    }
    if (byte == '\r' || byte < 0x20U || byte > 0x7EU) {
      rejected_ = true;
      pendingRejectionReason_ = RejectionReason::kInvalidByte;
      return {};
    }
    buffer_[length_++] = static_cast<char>(byte); return {};
  }
  RejectionReason lastRejectionReason() const {
    return lastRejectionReason_;
  }
  uint8_t lastLineLength() const { return lastLineLength_; }
  bool lastLineWasStorage() const { return lastLineWasStorage_; }
 private:
  Frame parseLine() {
    Frame frame;
    if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:STATUS")) == 0) frame.operation = Operation::kStatus;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:SYNC")) == 0) frame.operation = Operation::kSync;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:ABORT")) == 0) frame.operation = Operation::kAbort;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:DIAG")) == 0) frame.operation = Operation::kDiagnostic;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:TRACE")) == 0) frame.operation = Operation::kReadTrace;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:STREAM?")) == 0)
      frame.operation = Operation::kStreamDiagnostic;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:OK")) == 0) frame.operation = Operation::kOk;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:IDLE")) == 0) frame.operation = Operation::kIdle;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:ERROR")) == 0) frame.operation = Operation::kError;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:READY")) == 0) frame.operation = Operation::kReady;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:REINIT_READY")) == 0)
      frame.operation = Operation::kReinitializedReady;
    else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:UNAVAILABLE")) == 0) frame.operation = Operation::kUnavailable;
    else if ((text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:ABORT:"), 9U) == 0 && strlen(buffer_) == 17U) ||
             (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:IDLE:"), 8U) == 0 && strlen(buffer_) == 16U)) {
      const uint8_t prefix = buffer_[3] == 'A' ? 9U : 8U;
      frame.operation = prefix == 9U ? Operation::kAbort : Operation::kIdle;
      for (uint8_t index = 0U; index < 8U; ++index) {
        uint8_t digit;
        if (!parseHex(buffer_[prefix + index], digit)) {
          lastRejectionReason_ = RejectionReason::kInvalidHex;
          frame.operation = Operation::kRejected; break;
        }
        frame.sector = (frame.sector << 4U) | digit;
      }
    }
    else if ((text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:R:"), 5U) == 0 ||
              text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:W:"), 5U) == 0) && strlen(buffer_) == 13U) {
      frame.operation = buffer_[3] == 'R' ? Operation::kReadSector : Operation::kWriteSector;
      for (uint8_t index = 0U; index < 8U; ++index) {
        uint8_t digit;
        if (!parseHex(buffer_[5U + index], digit)) {
          lastRejectionReason_ = RejectionReason::kInvalidHex;
          frame.operation = Operation::kRejected; break;
        }
        frame.sector = (frame.sector << 4U) | digit;
      }
    } else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:DIAG:"), 8U) == 0) {
      const size_t hexLength = strlen(buffer_ + 8U);
      if (hexLength == 0U || (hexLength & 1U) != 0U ||
          hexLength / 2U > kDiagnosticBytes) frame.operation = Operation::kRejected;
      else {
        frame.length = static_cast<uint8_t>(hexLength / 2U);
        frame.operation = Operation::kDiagnostic;
        for (uint8_t index = 0U; index < frame.length; ++index) {
          uint8_t high, low;
          if (!parseHex(buffer_[8U + index * 2U], high) ||
              !parseHex(buffer_[9U + index * 2U], low)) {
            lastRejectionReason_ = RejectionReason::kInvalidHex;
            frame.operation = Operation::kRejected; frame.length = 0U; break;
          }
          frame.data[index] = static_cast<uint8_t>((high << 4U) | low);
        }
      }
    } else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:STREAM:"), 10U) == 0) {
      const size_t hexLength = strlen(buffer_ + 10U);
      if (hexLength != stream_diagnostic::kLength * 2U)
        frame.operation = Operation::kRejected;
      else {
        frame.length = stream_diagnostic::kLength;
        frame.operation = Operation::kStreamDiagnostic;
        for (uint8_t index = 0U; index < frame.length; ++index) {
          uint8_t high, low;
          if (!parseHex(buffer_[10U + index * 2U], high) ||
              !parseHex(buffer_[11U + index * 2U], low)) {
            lastRejectionReason_ = RejectionReason::kInvalidHex;
            frame.operation = Operation::kRejected; frame.length = 0U; break;
          }
          frame.data[index] = static_cast<uint8_t>((high << 4U) | low);
        }
      }
    } else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:DATA:"), 8U) == 0 &&
               strlen(buffer_) >= 12U && buffer_[11U] == ':') {
      for (uint8_t index = 0U; index < 3U; ++index) {
        uint8_t digit;
        if (!parseHex(buffer_[8U + index], digit)) {
          lastRejectionReason_ = RejectionReason::kInvalidHex;
          frame.operation = Operation::kRejected; return frame;
        }
        frame.offset = static_cast<uint16_t>((frame.offset << 4U) | digit);
      }
      const size_t hexLength = strlen(buffer_ + 12U);
      if (frame.offset >= kSectorBytes || hexLength == 0U ||
          (hexLength & 1U) != 0U || hexLength / 2U > kChunkBytes ||
          frame.offset + hexLength / 2U > kSectorBytes)
        frame.operation = Operation::kRejected;
      else {
        frame.length = static_cast<uint8_t>(hexLength / 2U); frame.operation = Operation::kData;
        for (uint8_t index = 0U; index < frame.length; ++index) {
          uint8_t high, low;
          if (!parseHex(buffer_[12U + index * 2U], high) ||
              !parseHex(buffer_[13U + index * 2U], low)) {
            lastRejectionReason_ = RejectionReason::kInvalidHex;
            frame.operation = Operation::kRejected; frame.length = 0U; break;
          }
          frame.data[index] = static_cast<uint8_t>((high << 4U) | low);
        }
      }
    } else if (text::compare(buffer_, DENTAL_TEXT_LITERAL("SD:"), 3U) == 0) frame.operation = Operation::kRejected;
    return frame;
  }
  char buffer_[Capacity + 1U] = {};
  uint8_t length_ = 0U;
  uint8_t lastLineLength_ = 0U;
  bool rejected_ = false;
  bool lastLineWasStorage_ = false;
  RejectionReason pendingRejectionReason_ = RejectionReason::kNone;
  RejectionReason lastRejectionReason_ = RejectionReason::kNone;
};

using Parser = BasicParser<kMaximumFrameLength>;

// Fixed-buffer sector reconstruction shared by firmware and host tests.
// Offsets must be contiguous; a short final chunk is valid only at byte 504.
class SectorAssembler {
 public:
  explicit SectorAssembler(uint8_t* destination) : destination_(destination) {}
  bool accept(const Frame& frame) {
    if (!destination_ || frame.operation != Operation::kData ||
        frame.length == 0U || frame.length > kChunkBytes ||
        frame.offset != received_ || received_ + frame.length > kSectorBytes)
      return false;
    memcpy(destination_ + received_, frame.data, frame.length);
    lastOffset_ = frame.offset;
    lastLength_ = frame.length;
    received_ = static_cast<uint16_t>(received_ + frame.length);
    ++chunks_;
    return true;
  }
  uint16_t received() const { return received_; }
  uint16_t expectedOffset() const { return received_; }
  uint16_t lastOffset() const { return lastOffset_; }
  uint8_t lastLength() const { return lastLength_; }
  uint8_t chunks() const { return chunks_; }
  bool complete() const {
    return received_ == kSectorBytes && chunks_ == 22U &&
           lastOffset_ == 504U && lastLength_ == 8U;
  }
 private:
  uint8_t* destination_;
  uint16_t received_ = 0U;
  uint16_t lastOffset_ = 0U;
  uint8_t lastLength_ = 0U;
  uint8_t chunks_ = 0U;
};

} }
