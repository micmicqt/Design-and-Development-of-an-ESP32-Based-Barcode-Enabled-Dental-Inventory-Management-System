#include "lcd_display.h"
#include "rtc_link.h"
#include "../../firmware-common/include/storage_link_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

namespace {
struct GuardedRow { uint8_t before = 0xA5U; char text[20]; uint8_t after = 0x5AU; };
void lcdEquivalent(const dental_link::rtc::DateTime& time, uint8_t row) {
  GuardedRow actual;
  char reference[21] = {}, expected[20];
  if (row == 1U) snprintf(reference, sizeof(reference), "%04u-%02u-%02u",
      unsigned(time.year), unsigned(time.month), unsigned(time.day));
  else snprintf(reference, sizeof(reference), "%02u:%02u:%02u",
      unsigned(time.hour), unsigned(time.minute), unsigned(time.second));
  memset(expected, ' ', sizeof(expected));
  memcpy(expected, reference, strlen(reference));
  dental_atmega::lcd::screenLine(dental_atmega::lcd::Screen::kClock, row, time, actual.text);
  assert(memcmp(actual.text, expected, 20U) == 0);
  assert(actual.before == 0xA5U && actual.after == 0x5AU);
}
void rtcEquivalent(const dental_link::rtc::DateTime& value) {
  GuardedRow actual;
  char reference[20];
  snprintf(reference, sizeof(reference), "%04u-%02u-%02u %02u:%02u:%02u",
      unsigned(value.year), unsigned(value.month), unsigned(value.day),
      unsigned(value.hour), unsigned(value.minute), unsigned(value.second));
  assert(dental_link::rtc::formatDateTime(value, actual.text, sizeof(actual.text)));
  assert(memcmp(actual.text, reference, 20U) == 0);
  assert(actual.before == 0xA5U && actual.after == 0x5AU);
  char tooSmall[19]; memset(tooSmall, '?', sizeof(tooSmall));
  assert(!dental_link::rtc::formatDateTime(value, tooSmall, sizeof(tooSmall)));
  for (char byte : tooSmall) assert(byte == '?');
}
void datesAndTimes() {
  dental_link::rtc::DateTime value = {2000U, 1U, 1U, 0U, 0U, 0U};
  for (uint16_t year = 2000U; year <= 2099U; ++year)
    for (uint8_t month = 1U; month <= 12U; ++month)
      for (uint8_t day = 1U; day <= dental_link::rtc::daysInMonth(year, month); ++day) {
        value.year = year; value.month = month; value.day = day;
        rtcEquivalent(value); lcdEquivalent(value, 1U);
      }
  for (uint32_t seconds = 0U; seconds < 86400UL; ++seconds) {
    value.hour = seconds / 3600UL; value.minute = (seconds / 60UL) % 60UL;
    value.second = seconds % 60UL;
    rtcEquivalent(value); lcdEquivalent(value, 2U);
  }
  // Preserve printf minimum-width semantics even beyond valid RTC values.
  value.month = value.day = 255U;
  for (uint32_t year = 0U; year <= UINT16_MAX; ++year) {
    value.year = year; lcdEquivalent(value, 1U);
  }
  value.hour = value.minute = value.second = 255U; lcdEquivalent(value, 2U);
  assert(!dental_link::rtc::formatDateTime(value, nullptr, 20U));
  GuardedRow invalid; memset(invalid.text, '?', 20U);
  assert(!dental_link::rtc::formatDateTime(value, invalid.text, 20U));
  for (char byte : invalid.text) assert(byte == '?');
}
void immutableHelpers() {
  const char* value = DENTAL_TEXT_LITERAL("BTN:WAIT\n");
  assert(dental_link::text::length(value) == 9U);
  char output[10]; dental_link::text::copy(output, value, 10U);
  assert(strcmp(output, "BTN:WAIT\n") == 0);
  assert(dental_link::text::at(value, 8U) == '\n');
  assert(dental_link::text::compare("BTN:WAIT\n", value) == 0);
  assert(dental_link::text::compare("BTN:WAIT-extra", value, 8U) == 0);
  assert(dental_link::text::compare("BTN:WAIX", value, 8U) != 0);
  assert(dental_link::text::compare("ready", dental_link::rtc::stateName(
      dental_link::rtc::State::kReady)) == 0);
  assert(dental_link::text::compare("communication_failure", dental_link::rtc::reasonName(
      dental_link::rtc::Reason::kCommunicationFailure)) == 0);
  assert(dental_link::text::at(dental_link::modeLine(dental_link::Frame::kCheckoutMode), 4U) == 'C');
  char sector[15];
  assert(dental_link::storage::encodeSector(dental_link::storage::Operation::kReadSector,
      UINT32_MAX, sector, sizeof(sector)));
  assert(strcmp(sector, "SD:R:FFFFFFFF\n") == 0);
}
}
int main() {
  immutableHelpers(); datesAndTimes();
#ifdef __AVR__
  assert(dental_test_flash_reads > 0U && dental_test_flash_copies > 0U &&
         dental_test_flash_compares > 0U);
#endif
  puts("ATmega memory text: helpers, 36525 dates, 86400 times, 65536 LCD years, bounds PASS");
}
