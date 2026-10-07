#pragma once

#include <stdint.h>
#include <string.h>
#include "immutable_text.h"

namespace dental_link {
namespace rtc {

enum class State : uint8_t { kUnavailable, kNeedsSync, kReady };
enum class Reason : uint8_t {
  kNone,
  kCommunicationFailure,
  kLostPower,
  kInvalidTime,
  kVerificationFailed,
};

struct DateTime {
  uint16_t year;
  uint8_t month;
  uint8_t day;
  uint8_t hour;
  uint8_t minute;
  uint8_t second;
};

inline const char* stateName(State state) {
  return state == State::kReady ? DENTAL_TEXT_LITERAL("ready") :
      state == State::kNeedsSync ? DENTAL_TEXT_LITERAL("needs_sync") : DENTAL_TEXT_LITERAL("unavailable");
}

inline const char* reasonName(Reason reason) {
  switch (reason) {
    case Reason::kNone: return DENTAL_TEXT_LITERAL("none");
    case Reason::kCommunicationFailure: return DENTAL_TEXT_LITERAL("communication_failure");
    case Reason::kLostPower: return DENTAL_TEXT_LITERAL("lost_power");
    case Reason::kInvalidTime: return DENTAL_TEXT_LITERAL("invalid_time");
    case Reason::kVerificationFailed: return DENTAL_TEXT_LITERAL("verification_failed");
  }
  return DENTAL_TEXT_LITERAL("communication_failure");
}

inline bool isLeapYear(uint16_t year) {
  return (year % 4U == 0U && year % 100U != 0U) || year % 400U == 0U;
}

inline uint8_t daysInMonth(uint16_t year, uint8_t month) {
  static const uint8_t days[] DENTAL_FLASH_STORAGE = {31U, 28U, 31U, 30U, 31U, 30U,
                                 31U, 31U, 30U, 31U, 30U, 31U};
  if (month < 1U || month > 12U) return 0U;
  if (month == 2U && isLeapYear(year)) return 29U;
#ifdef __AVR__
  return pgm_read_byte(days + month - 1U);
#else
  return days[month - 1U];
#endif
}

inline bool valid(const DateTime& value) {
  return value.year >= 2000U && value.year <= 2099U &&
      value.month >= 1U && value.month <= 12U && value.day >= 1U &&
      value.day <= daysInMonth(value.year, value.month) &&
      value.hour <= 23U && value.minute <= 59U && value.second <= 59U;
}

inline bool parseDigits(const char* text, uint8_t count, uint16_t& value) {
  value = 0U;
  for (uint8_t i = 0U; i < count; ++i) {
    if (text[i] < '0' || text[i] > '9') return false;
    value = static_cast<uint16_t>(value * 10U + text[i] - '0');
  }
  return true;
}

inline bool parseDateTime(const char* text, DateTime& value) {
  if (!text || strlen(text) != 19U || text[4] != '-' || text[7] != '-' ||
      text[10] != ' ' || text[13] != ':' || text[16] != ':') return false;
  uint16_t year, month, day, hour, minute, second;
  if (!parseDigits(text, 4U, year) || !parseDigits(text + 5U, 2U, month) ||
      !parseDigits(text + 8U, 2U, day) ||
      !parseDigits(text + 11U, 2U, hour) ||
      !parseDigits(text + 14U, 2U, minute) ||
      !parseDigits(text + 17U, 2U, second)) return false;
  value = {year, static_cast<uint8_t>(month), static_cast<uint8_t>(day),
           static_cast<uint8_t>(hour), static_cast<uint8_t>(minute),
           static_cast<uint8_t>(second)};
  return valid(value);
}

inline void twoDigits(uint8_t value, char* output) {
  output[0] = static_cast<char>('0' + value / 10U);
  output[1] = static_cast<char>('0' + value % 10U);
}

inline bool formatDateTime(const DateTime& value, char* output, uint8_t capacity) {
  if (!valid(value) || !output || capacity < 20U) return false;
  // Valid dates are 2000..2099: fixed-width output, no printf varargs/stack.
  output[0] = '2'; output[1] = '0';
  twoDigits(static_cast<uint8_t>(value.year - 2000U), output + 2U);
  output[4] = '-'; twoDigits(value.month, output + 5U);
  output[7] = '-'; twoDigits(value.day, output + 8U);
  output[10] = ' '; twoDigits(value.hour, output + 11U);
  output[13] = ':'; twoDigits(value.minute, output + 14U);
  output[16] = ':'; twoDigits(value.second, output + 17U);
  output[19] = '\0';
  return true;
}

inline uint32_t secondsSince2000(const DateTime& value) {
  uint32_t days = 0UL;
  for (uint16_t year = 2000U; year < value.year; ++year)
    days += isLeapYear(year) ? 366UL : 365UL;
  for (uint8_t month = 1U; month < value.month; ++month)
    days += daysInMonth(value.year, month);
  days += static_cast<uint32_t>(value.day - 1U);
  return days * 86400UL + static_cast<uint32_t>(value.hour) * 3600UL +
      static_cast<uint32_t>(value.minute) * 60UL + value.second;
}

inline bool fromSecondsSince2000(uint32_t seconds, DateTime& value) {
  uint32_t days = seconds / 86400UL;
  uint32_t remainder = seconds % 86400UL;
  uint16_t year = 2000U;
  while (year <= 2099U) {
    const uint16_t yearDays = isLeapYear(year) ? 366U : 365U;
    if (days < yearDays) break;
    days -= yearDays; ++year;
  }
  if (year > 2099U) return false;
  uint8_t month = 1U;
  while (month <= 12U) {
    const uint8_t monthDays = daysInMonth(year, month);
    if (days < monthDays) break;
    days -= monthDays; ++month;
  }
  if (month > 12U) return false;
  value = {year, month, static_cast<uint8_t>(days + 1U),
           static_cast<uint8_t>(remainder / 3600UL),
           static_cast<uint8_t>((remainder % 3600UL) / 60UL),
           static_cast<uint8_t>(remainder % 60UL)};
  return valid(value);
}

inline bool parseState(const char* text, State& state, Reason& reason) {
  if (!text) return false;
  const char* separator = strchr(text, ':');
  if (!separator || strchr(separator + 1, ':')) return false;
  const size_t stateLength = static_cast<size_t>(separator - text);
  if (stateLength == 5U && text::compare(text, DENTAL_TEXT_LITERAL("ready"), 5U) == 0) state = State::kReady;
  else if (stateLength == 10U && text::compare(text, DENTAL_TEXT_LITERAL("needs_sync"), 10U) == 0)
    state = State::kNeedsSync;
  else if (stateLength == 11U && text::compare(text, DENTAL_TEXT_LITERAL("unavailable"), 11U) == 0)
    state = State::kUnavailable;
  else return false;
  const char* reasonText = separator + 1;
  if (text::compare(reasonText, DENTAL_TEXT_LITERAL("none")) == 0) reason = Reason::kNone;
  else if (text::compare(reasonText, DENTAL_TEXT_LITERAL("communication_failure")) == 0)
    reason = Reason::kCommunicationFailure;
  else if (text::compare(reasonText, DENTAL_TEXT_LITERAL("lost_power")) == 0) reason = Reason::kLostPower;
  else if (text::compare(reasonText, DENTAL_TEXT_LITERAL("invalid_time")) == 0) reason = Reason::kInvalidTime;
  else if (text::compare(reasonText, DENTAL_TEXT_LITERAL("verification_failed")) == 0)
    reason = Reason::kVerificationFailed;
  else return false;
  return (state == State::kReady) == (reason == Reason::kNone);
}

inline uint8_t dayOfWeek(const DateTime& value) {
  // DS3231 accepts 1..7; map 2000-01-01 (Saturday) to 7.
  const uint32_t days = secondsSince2000(value) / 86400UL;
  return static_cast<uint8_t>(((days + 6UL) % 7UL) + 1UL);
}

}  // namespace rtc
}  // namespace dental_link
