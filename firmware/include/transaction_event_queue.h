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

struct PendingTransactionEvent {
  char eventId[kEventIdCapacity];
  char mode[9U];
  char barcode[kMaximumBarcodeLength + 1U];
  char timestamp[kTimestampCapacity];
};

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
    events_[(head_ + count_) % kQueueCapacity] = event;
    ++count_;
    return true;
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
    head_ = (head_ + 1U) % kQueueCapacity;
    --count_;
    return AcknowledgementResult::kAcknowledged;
  }

 private:
  PendingTransactionEvent events_[kQueueCapacity] = {};
  size_t head_ = 0U;
  size_t count_ = 0U;
  char receipts_[kQueueCapacity][kEventIdCapacity] = {};
  size_t nextReceipt_ = 0U;
  size_t receiptCount_ = 0U;
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
