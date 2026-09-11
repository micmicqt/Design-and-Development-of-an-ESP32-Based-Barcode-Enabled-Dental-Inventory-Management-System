#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace dental {
namespace rtc_recovery {

constexpr uint32_t kMinimumTrustedEpochSeconds = 1577836800UL;  // 2020-01-01 UTC
constexpr uint32_t kMaximumTrustedEpochSeconds = 4102444799UL;  // 2099-12-31 UTC
constexpr int16_t kMinimumUtcOffsetMinutes = -840;
constexpr int16_t kMaximumUtcOffsetMinutes = 840;
constexpr uint32_t kMaximumVerificationSkewSeconds = 2UL;

enum class State : uint8_t {
  kUnavailable,
  kNeedsSync,
  kReady,
};

enum class Reason : uint8_t {
  kNone,
  kCommunicationFailure,
  kLostPower,
  kInvalidTime,
  kVerificationFailed,
};

struct Status {
  State state;
  Reason reason;
};

struct SyncRequest {
  uint32_t epochSeconds;
  int16_t utcOffsetMinutes;
  uint32_t localEpochSeconds;
};

inline Status classifyInitialState(bool deviceDetected,
                                   bool statusRegisterReadable,
                                   bool oscillatorStopFlagSet,
                                   bool retainedTimeValid) {
  if (!deviceDetected || !statusRegisterReadable) {
    return {State::kUnavailable, Reason::kCommunicationFailure};
  }
  if (oscillatorStopFlagSet) {
    return {State::kNeedsSync, Reason::kLostPower};
  }
  if (!retainedTimeValid) {
    return {State::kNeedsSync, Reason::kInvalidTime};
  }
  return {State::kReady, Reason::kNone};
}

inline const char* stateName(State state) {
  switch (state) {
    case State::kUnavailable: return "unavailable";
    case State::kNeedsSync: return "needs_sync";
    case State::kReady: return "ready";
  }
  return "unavailable";
}

inline const char* reasonName(Reason reason) {
  switch (reason) {
    case Reason::kNone: return "none";
    case Reason::kCommunicationFailure: return "communication_failure";
    case Reason::kLostPower: return "lost_power";
    case Reason::kInvalidTime: return "invalid_time";
    case Reason::kVerificationFailed: return "verification_failed";
  }
  return "communication_failure";
}

inline bool timeIsTrusted(const Status& status) {
  return status.state == State::kReady && status.reason == Reason::kNone;
}

inline void skipWhitespace(const char*& cursor, const char* end) {
  while (cursor < end &&
         (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' ||
          *cursor == '\n')) {
    ++cursor;
  }
}

inline bool parseKey(const char*& cursor, const char* end, char* output,
                     size_t capacity) {
  if (cursor >= end || *cursor != '"' || capacity == 0U) return false;
  ++cursor;
  size_t written = 0U;
  while (cursor < end && *cursor != '"') {
    const unsigned char value = static_cast<unsigned char>(*cursor);
    if (value < 0x20U || *cursor == '\\' || written + 1U >= capacity) {
      return false;
    }
    output[written++] = *cursor++;
  }
  if (cursor >= end || *cursor != '"') return false;
  ++cursor;
  output[written] = '\0';
  return true;
}

inline bool parseUnsigned(const char*& cursor, const char* end,
                          uint64_t& value) {
  if (cursor >= end || *cursor < '0' || *cursor > '9') return false;
  value = 0ULL;
  do {
    const uint8_t digit = static_cast<uint8_t>(*cursor - '0');
    if (value > (UINT64_MAX - digit) / 10ULL) return false;
    value = value * 10ULL + digit;
    ++cursor;
  } while (cursor < end && *cursor >= '0' && *cursor <= '9');
  return true;
}

inline bool parseSigned(const char*& cursor, const char* end, int64_t& value) {
  bool negative = false;
  if (cursor < end && *cursor == '-') {
    negative = true;
    ++cursor;
  }
  uint64_t magnitude = 0ULL;
  if (!parseUnsigned(cursor, end, magnitude) || magnitude > 9223372036854775807ULL) {
    return false;
  }
  value = negative ? -static_cast<int64_t>(magnitude)
                   : static_cast<int64_t>(magnitude);
  return true;
}

inline bool parseSyncRequest(const char* body, size_t length,
                             SyncRequest& request) {
  if (body == nullptr || length == 0U || length > 160U) return false;
  const char* cursor = body;
  const char* end = body + length;
  skipWhitespace(cursor, end);
  if (cursor >= end || *cursor++ != '{') return false;

  bool sawEpoch = false;
  bool sawOffset = false;
  uint64_t epoch = 0ULL;
  int64_t offset = 0LL;

  for (uint8_t field = 0U; field < 2U; ++field) {
    skipWhitespace(cursor, end);
    char key[24U] = {};
    if (!parseKey(cursor, end, key, sizeof(key))) return false;
    skipWhitespace(cursor, end);
    if (cursor >= end || *cursor++ != ':') return false;
    skipWhitespace(cursor, end);

    if (strcmp(key, "epochSeconds") == 0 && !sawEpoch) {
      if (!parseUnsigned(cursor, end, epoch)) return false;
      sawEpoch = true;
    } else if (strcmp(key, "utcOffsetMinutes") == 0 && !sawOffset) {
      if (!parseSigned(cursor, end, offset)) return false;
      sawOffset = true;
    } else {
      return false;
    }

    skipWhitespace(cursor, end);
    if (field == 0U) {
      if (cursor >= end || *cursor++ != ',') return false;
    } else if (cursor >= end || *cursor++ != '}') {
      return false;
    }
  }

  skipWhitespace(cursor, end);
  if (cursor != end || !sawEpoch || !sawOffset ||
      epoch < kMinimumTrustedEpochSeconds ||
      epoch > kMaximumTrustedEpochSeconds ||
      offset < kMinimumUtcOffsetMinutes ||
      offset > kMaximumUtcOffsetMinutes) {
    return false;
  }

  const int64_t localEpoch =
      static_cast<int64_t>(epoch) + offset * 60LL;
  if (localEpoch < static_cast<int64_t>(kMinimumTrustedEpochSeconds) ||
      localEpoch > static_cast<int64_t>(kMaximumTrustedEpochSeconds)) {
    return false;
  }

  request.epochSeconds = static_cast<uint32_t>(epoch);
  request.utcOffsetMinutes = static_cast<int16_t>(offset);
  request.localEpochSeconds = static_cast<uint32_t>(localEpoch);
  return true;
}

inline bool synchronizationVerified(uint32_t requestedLocalEpochSeconds,
                                    bool statusRegisterReadable,
                                    bool oscillatorStopFlagSet,
                                    bool rereadTimeValid,
                                    uint32_t observedLocalEpochSeconds) {
  return statusRegisterReadable && !oscillatorStopFlagSet && rereadTimeValid &&
         observedLocalEpochSeconds >= requestedLocalEpochSeconds &&
         observedLocalEpochSeconds - requestedLocalEpochSeconds <=
             kMaximumVerificationSkewSeconds;
}

inline bool constantTimeTokenMatches(const char* configuredToken,
                                     const char* suppliedToken) {
  if (configuredToken == nullptr || suppliedToken == nullptr) return false;
  const size_t configuredLength = strlen(configuredToken);
  const size_t suppliedLength = strlen(suppliedToken);
  const size_t comparedLength =
      configuredLength > suppliedLength ? configuredLength : suppliedLength;
  unsigned char difference =
      static_cast<unsigned char>(configuredLength ^ suppliedLength);
  for (size_t index = 0U; index < comparedLength; ++index) {
    const unsigned char configured =
        index < configuredLength
            ? static_cast<unsigned char>(configuredToken[index])
            : 0U;
    const unsigned char supplied =
        index < suppliedLength ? static_cast<unsigned char>(suppliedToken[index])
                               : 0U;
    difference = static_cast<unsigned char>(difference | (configured ^ supplied));
  }
  return difference == 0U && configuredLength > 0U;
}

}  // namespace rtc_recovery
}  // namespace dental
