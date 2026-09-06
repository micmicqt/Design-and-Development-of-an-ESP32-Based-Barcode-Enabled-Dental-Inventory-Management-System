#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace dental {
namespace events {

constexpr size_t kQueueCapacity = 8U;
constexpr size_t kEventIdCapacity = 64U;
constexpr size_t kMaximumBarcodeLength = 256U;
constexpr size_t kTimestampCapacity = 20U;
constexpr size_t kAcknowledgementBodyMaximumLength = 128U;
constexpr size_t kTransactionResultBodyMaximumLength = 512U;
constexpr uint32_t kMaximumTransactionQuantity = 10000U;
constexpr uint64_t kMaximumResultingStock = 9007199254740991ULL;

struct PendingTransactionEvent {
  char eventId[kEventIdCapacity];
  char mode[9U];
  char barcode[kMaximumBarcodeLength + 1U];
  char timestamp[kTimestampCapacity];
};

enum class StockStatus : uint8_t {
  kHigh,
  kLow,
  kEmpty,
};

struct TransactionResult {
  char eventId[kEventIdCapacity];
  char mode[9U];
  uint32_t quantity;
  uint64_t resultingStock;
  StockStatus stockStatus;
};

struct StockIndicatorOutputs {
  bool controlA;
  bool controlB;
};

// A separate bounded FIFO retains required LCD/D1 feedback even after the
// associated delivery event is ACKed and removed from PendingEventQueue.
class TransactionResultQueue {
 public:
  size_t size() const { return count_; }
  bool full() const { return count_ == kQueueCapacity; }

  bool enqueue(const TransactionResult& result) {
    if (full()) return false;
    results_[(head_ + count_) % kQueueCapacity] = result;
    ++count_;
    return true;
  }

  bool dequeue(TransactionResult& result) {
    if (count_ == 0U) return false;
    result = results_[head_];
    head_ = (head_ + 1U) % kQueueCapacity;
    --count_;
    return true;
  }

 private:
  TransactionResult results_[kQueueCapacity] = {};
  size_t head_ = 0U;
  size_t count_ = 0U;
};

inline StockIndicatorOutputs stockIndicatorOutputs(StockStatus status) {
  switch (status) {
    case StockStatus::kHigh:
      return {true, false};
    case StockStatus::kLow:
      return {false, true};
    case StockStatus::kEmpty:
      return {true, true};
  }
  return {false, false};
}

inline const char* stockStatusName(StockStatus status) {
  switch (status) {
    case StockStatus::kHigh:
      return "HIGH";
    case StockStatus::kLow:
      return "LOW";
    case StockStatus::kEmpty:
      return "EMPTY";
  }
  return "";
}

inline bool formatEventId(char (&eventId)[kEventIdCapacity],
                          const char* bootSession, uint64_t sequence) {
  // UINT64_MAX is usable once; its successor is rejected rather than reused.
  if (sequence == 0ULL) return false;
  const int length = snprintf(eventId, sizeof(eventId), "evt-%s-%llu",
                              bootSession,
                              static_cast<unsigned long long>(sequence));
  return length > 0 && static_cast<size_t>(length) < sizeof(eventId);
}

enum class AcknowledgementResult : uint8_t {
  kAcknowledged,
  kAlreadyAcknowledged,
  kEmpty,
  kMismatch,
};

enum class ResultApplicationResult : uint8_t {
  kApplied,
  kAlreadyApplied,
  kEmpty,
  kEventIdMismatch,
  kModeMismatch,
  kConflict,
};

// Volatile delivery only: no filesystem, GPIO, network or inventory operations.
class PendingEventQueue {
 public:
  const PendingTransactionEvent* oldest() const {
    return count_ == 0U ? nullptr : &events_[head_];
  }

  size_t size() const { return count_; }
  bool full() const { return count_ == kQueueCapacity; }

  bool enqueue(const PendingTransactionEvent& event) {
    if (full()) return false;
    const size_t tail = (head_ + count_) % kQueueCapacity;
    events_[tail] = event;
    resultApplied_[tail] = false;
    appliedResults_[tail] =
        TransactionResult{{}, {}, 0U, 0ULL, StockStatus::kHigh};
    ++count_;
    return true;
  }

  ResultApplicationResult classifyResult(const TransactionResult& result) const {
    // A result response can be lost after the desktop proceeds to ACK. Retain
    // recent full result receipts so that a delayed identical retry remains
    // safe and can never be associated with the next FIFO head.
    for (size_t index = 0U; index < resultReceiptCount_; ++index) {
      const TransactionResult& receipt = resultReceipts_[index];
      if (strcmp(receipt.eventId, result.eventId) == 0) {
        const bool identical =
            strcmp(receipt.mode, result.mode) == 0 &&
            receipt.quantity == result.quantity &&
            receipt.resultingStock == result.resultingStock &&
            receipt.stockStatus == result.stockStatus;
        return identical ? ResultApplicationResult::kAlreadyApplied
                         : ResultApplicationResult::kConflict;
      }
    }

    if (count_ == 0U) return ResultApplicationResult::kEmpty;
    if (strcmp(events_[head_].eventId, result.eventId) != 0) {
      return ResultApplicationResult::kEventIdMismatch;
    }
    if (strcmp(events_[head_].mode, result.mode) != 0) {
      return ResultApplicationResult::kModeMismatch;
    }
    if (resultApplied_[head_]) {
      const TransactionResult& applied = appliedResults_[head_];
      const bool identical =
          strcmp(applied.eventId, result.eventId) == 0 &&
          strcmp(applied.mode, result.mode) == 0 &&
          applied.quantity == result.quantity &&
          applied.resultingStock == result.resultingStock &&
          applied.stockStatus == result.stockStatus;
      return identical ? ResultApplicationResult::kAlreadyApplied
                       : ResultApplicationResult::kConflict;
    }
    return ResultApplicationResult::kApplied;
  }

  ResultApplicationResult applyResult(const TransactionResult& result) {
    const ResultApplicationResult classification = classifyResult(result);
    if (classification == ResultApplicationResult::kApplied) {
      appliedResults_[head_] = result;
      resultApplied_[head_] = true;
    }
    return classification;
  }

  const TransactionResult* oldestAppliedResult() const {
    return count_ != 0U && resultApplied_[head_]
               ? &appliedResults_[head_]
               : nullptr;
  }

  AcknowledgementResult acknowledge(const char* eventId) {
    // A lost HTTP response must not strand the desktop on an already-dequeued
    // event. A bounded receipt ring makes recent retries safe, without ever
    // removing the next FIFO head on such a retry.
    for (size_t index = 0U; index < receiptCount_; ++index) {
      if (strcmp(receipts_[index], eventId) == 0) {
        return AcknowledgementResult::kAlreadyAcknowledged;
      }
    }
    if (count_ == 0U) return AcknowledgementResult::kEmpty;
    if (strcmp(events_[head_].eventId, eventId) != 0) {
      return AcknowledgementResult::kMismatch;
    }
    snprintf(receipts_[nextReceipt_], kEventIdCapacity, "%s", eventId);
    nextReceipt_ = (nextReceipt_ + 1U) % kQueueCapacity;
    if (receiptCount_ < kQueueCapacity) ++receiptCount_;
    if (resultApplied_[head_]) {
      resultReceipts_[nextResultReceipt_] = appliedResults_[head_];
      nextResultReceipt_ = (nextResultReceipt_ + 1U) % kQueueCapacity;
      if (resultReceiptCount_ < kQueueCapacity) ++resultReceiptCount_;
    }
    resultApplied_[head_] = false;
    appliedResults_[head_] =
        TransactionResult{{}, {}, 0U, 0ULL, StockStatus::kHigh};
    head_ = (head_ + 1U) % kQueueCapacity;
    --count_;
    return AcknowledgementResult::kAcknowledged;
  }

 private:
  PendingTransactionEvent events_[kQueueCapacity] = {};
  TransactionResult appliedResults_[kQueueCapacity] = {};
  bool resultApplied_[kQueueCapacity] = {};
  size_t head_ = 0U;
  size_t count_ = 0U;
  char receipts_[kQueueCapacity][kEventIdCapacity] = {};
  size_t nextReceipt_ = 0U;
  size_t receiptCount_ = 0U;
  TransactionResult resultReceipts_[kQueueCapacity] = {};
  size_t nextResultReceipt_ = 0U;
  size_t resultReceiptCount_ = 0U;
};

inline bool eventIdUsesSafeAlphabet(const char* eventId, size_t length) {
  if (length == 0U || length >= kEventIdCapacity) return false;
  for (size_t index = 0U; index < length; ++index) {
    const char character = eventId[index];
    const bool isDigit = character >= '0' && character <= '9';
    const bool isUppercase = character >= 'A' && character <= 'Z';
    const bool isLowercase = character >= 'a' && character <= 'z';
    if (!isDigit && !isUppercase && !isLowercase && character != '-' &&
        character != '_' && character != '.' && character != ':') return false;
  }
  return true;
}

inline void skipJsonWhitespace(const char* text, size_t length, size_t& index) {
  while (index < length) {
    const char value = text[index];
    if (value != ' ' && value != '\t' && value != '\r' && value != '\n') return;
    ++index;
  }
}

inline bool consumeJsonCharacter(const char* text, size_t length,
                                 size_t& index, char expected) {
  skipJsonWhitespace(text, length, index);
  if (index >= length || text[index] != expected) return false;
  ++index;
  return true;
}

inline bool parseSimpleJsonString(const char* text, size_t length, size_t& index,
                                  char* value, size_t capacity) {
  if (!consumeJsonCharacter(text, length, index, '"')) return false;
  size_t written = 0U;
  while (index < length && text[index] != '"') {
    const char character = text[index++];
    if (character == '\\' || static_cast<uint8_t>(character) < 0x20U ||
        written + 1U >= capacity) return false;
    value[written++] = character;
  }
  if (index >= length || text[index++] != '"') return false;
  value[written] = '\0';
  return true;
}

// The narrow ACK contract deliberately accepts exactly one unescaped eventId
// string. Generated IDs never require escapes; extra keys/duplicates reject.
inline bool parseAcknowledgementBody(const char* body, size_t length,
                                    char (&eventId)[kEventIdCapacity]) {
  if (length == 0U || length > kAcknowledgementBodyMaximumLength) return false;
  size_t index = 0U;
  char key[8U];
  if (!consumeJsonCharacter(body, length, index, '{') ||
      !parseSimpleJsonString(body, length, index, key, sizeof(key)) ||
      strcmp(key, "eventId") != 0 ||
      !consumeJsonCharacter(body, length, index, ':') ||
      !parseSimpleJsonString(body, length, index, eventId, sizeof(eventId)) ||
      !consumeJsonCharacter(body, length, index, '}')) return false;
  skipJsonWhitespace(body, length, index);
  return index == length && eventIdUsesSafeAlphabet(eventId, strlen(eventId));
}

inline bool parseUnsignedJsonInteger(const char* text, size_t length,
                                     size_t& index, uint64_t maximum,
                                     uint64_t& value) {
  skipJsonWhitespace(text, length, index);
  if (index >= length || text[index] < '0' || text[index] > '9') return false;
  if (text[index] == '0' && index + 1U < length &&
      text[index + 1U] >= '0' && text[index + 1U] <= '9') return false;

  uint64_t parsed = 0ULL;
  do {
    const uint64_t digit = static_cast<uint64_t>(text[index] - '0');
    if (parsed > (maximum - digit) / 10ULL) return false;
    parsed = parsed * 10ULL + digit;
    ++index;
  } while (index < length && text[index] >= '0' && text[index] <= '9');
  value = parsed;
  return true;
}

// Parses exactly the six-field transaction-result object. Keys may arrive in
// any order, but unknown/duplicate/missing keys, escaped strings, non-integer
// numbers, and out-of-range values are rejected.
inline bool parseTransactionResultBody(const char* body, size_t length,
                                       TransactionResult& result) {
  if (length == 0U || length > kTransactionResultBodyMaximumLength) return false;
  result = TransactionResult{{}, {}, 0U, 0ULL, StockStatus::kHigh};
  size_t index = 0U;
  bool hasEventId = false;
  bool hasResult = false;
  bool hasMode = false;
  bool hasQuantity = false;
  bool hasResultingStock = false;
  bool hasStockStatus = false;

  if (!consumeJsonCharacter(body, length, index, '{')) return false;
  for (size_t field = 0U; field < 6U; ++field) {
    char key[20U] = {};
    if (!parseSimpleJsonString(body, length, index, key, sizeof(key)) ||
        !consumeJsonCharacter(body, length, index, ':')) return false;

    if (strcmp(key, "eventId") == 0) {
      if (hasEventId || !parseSimpleJsonString(body, length, index,
                                               result.eventId,
                                               sizeof(result.eventId))) {
        return false;
      }
      hasEventId = true;
    } else if (strcmp(key, "result") == 0) {
      char value[8U] = {};
      if (hasResult || !parseSimpleJsonString(body, length, index, value,
                                              sizeof(value)) ||
          strcmp(value, "success") != 0) return false;
      hasResult = true;
    } else if (strcmp(key, "mode") == 0) {
      if (hasMode || !parseSimpleJsonString(body, length, index, result.mode,
                                            sizeof(result.mode)) ||
          (strcmp(result.mode, "restock") != 0 &&
           strcmp(result.mode, "checkout") != 0)) return false;
      hasMode = true;
    } else if (strcmp(key, "quantity") == 0) {
      uint64_t quantity = 0ULL;
      if (hasQuantity ||
          !parseUnsignedJsonInteger(body, length, index,
                                    kMaximumTransactionQuantity, quantity) ||
          quantity == 0ULL) return false;
      result.quantity = static_cast<uint32_t>(quantity);
      hasQuantity = true;
    } else if (strcmp(key, "resultingStock") == 0) {
      if (hasResultingStock ||
          !parseUnsignedJsonInteger(body, length, index,
                                    kMaximumResultingStock,
                                    result.resultingStock)) return false;
      hasResultingStock = true;
    } else if (strcmp(key, "stockStatus") == 0) {
      char value[6U] = {};
      if (hasStockStatus ||
          !parseSimpleJsonString(body, length, index, value, sizeof(value))) {
        return false;
      }
      if (strcmp(value, "HIGH") == 0) {
        result.stockStatus = StockStatus::kHigh;
      } else if (strcmp(value, "LOW") == 0) {
        result.stockStatus = StockStatus::kLow;
      } else if (strcmp(value, "EMPTY") == 0) {
        result.stockStatus = StockStatus::kEmpty;
      } else {
        return false;
      }
      hasStockStatus = true;
    } else {
      return false;
    }

    if (field < 5U) {
      if (!consumeJsonCharacter(body, length, index, ',')) return false;
    }
  }

  if (!consumeJsonCharacter(body, length, index, '}')) return false;
  skipJsonWhitespace(body, length, index);
  return index == length && hasEventId && hasResult && hasMode && hasQuantity &&
         hasResultingStock && hasStockStatus &&
         eventIdUsesSafeAlphabet(result.eventId, strlen(result.eventId));
}

// Works with Arduino String and std::string so the exact production serializer
// can be exercised in host tests without an ESP32 or fake hardware execution.
template <typename Text>
void appendJsonString(Text& destination, const char* value) {
  destination += '"';
  for (size_t index = 0U; value[index] != '\0'; ++index) {
    const uint8_t character = static_cast<uint8_t>(value[index]);
    switch (character) {
      case '"': destination += "\\\""; break;
      case '\\': destination += "\\\\"; break;
      case '\b': destination += "\\b"; break;
      case '\f': destination += "\\f"; break;
      case '\n': destination += "\\n"; break;
      case '\r': destination += "\\r"; break;
      case '\t': destination += "\\t"; break;
      default:
        if (character < 0x20U) {
          char escapedCharacter[7U];
          snprintf(escapedCharacter, sizeof(escapedCharacter), "\\u%04X",
                   static_cast<unsigned>(character));
          destination += escapedCharacter;
        } else {
          destination += static_cast<char>(character);
        }
        break;
    }
  }
  destination += '"';
}

}  // namespace events
}  // namespace dental
