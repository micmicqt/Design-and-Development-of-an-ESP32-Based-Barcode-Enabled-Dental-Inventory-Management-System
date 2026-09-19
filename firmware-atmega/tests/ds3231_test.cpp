#include "ds3231.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
using dental_atmega::ds3231::Driver;
using dental_link::rtc::DateTime;
using dental_link::rtc::Reason;
using dental_link::rtc::State;
using dental_atmega::twi::Result;

struct Bus {
  uint8_t registers[0x20] = {};
  uint8_t readBytes[8] = {};
  uint8_t writeBytes[8] = {};
  uint8_t readLength = 0U, writeLength = 0U;
  bool active = false, completion = false;
  Result next = Result::kSuccess, last = Result::kIdle;
  bool writeRead(uint32_t, uint8_t address, const uint8_t* data,
                 uint8_t writeCount, uint8_t count) {
    if (active || completion || address != 0x68U || !data || writeCount != 1U ||
        count > sizeof(readBytes)) return false;
    for (uint8_t i = 0U; i < count; ++i) readBytes[i] = registers[data[0] + i];
    readLength = count; writeLength = 0U; active = true; last = Result::kPending;
    return true;
  }
  bool write(uint32_t, uint8_t address, const uint8_t* data, uint8_t count) {
    if (active || completion || address != 0x68U || !data || count < 2U ||
        count > sizeof(writeBytes)) return false;
    memcpy(writeBytes, data, count); writeLength = count; readLength = 0U;
    active = true; last = Result::kPending; return true;
  }
  void service(uint32_t) {
    if (!active) return;
    active = false; completion = true; last = next;
    if (last == Result::kSuccess && writeLength != 0U) {
      for (uint8_t i = 1U; i < writeLength; ++i)
        registers[writeBytes[0] + i - 1U] = writeBytes[i];
    }
  }
  bool busy() const { return active; }
  bool completionPending() const { return completion; }
  Result takeResult() { completion = false; return last; }
  uint8_t readData(uint8_t index) const {
    return index < readLength ? readBytes[index] : 0U;
  }
};

struct Fixture {
  Bus bus;
  Driver<Bus> rtc{bus};
  uint32_t now = 0U;
  Fixture() { setTime({2026U, 9U, 19U, 13U, 14U, 15U}); }
  void setTime(const DateTime& value) {
    uint8_t encoded[8]; dental_atmega::ds3231::encodeTime(value, encoded);
    memcpy(bus.registers, encoded + 1U, 7U);
  }
  void drain(unsigned limit = 40U) {
    for (unsigned i = 0U; i < limit && !rtc.idle(); ++i) rtc.service(now++);
    assert(rtc.idle());
  }
  void begin() { rtc.begin(); drain(); }
};

void bcd() {
  uint8_t value = 0U;
  assert(dental_atmega::ds3231::encodeBcd(59U) == 0x59U);
  assert(dental_atmega::ds3231::decodeBcd(0x59U, 59U, value) && value == 59U);
  assert(!dental_atmega::ds3231::decodeBcd(0x6AU, 59U, value));
  assert(!dental_atmega::ds3231::decodeBcd(0x60U, 59U, value));
}
void dateValidation() {
  assert(dental_link::rtc::valid({2024U, 2U, 29U, 23U, 59U, 59U}));
  assert(!dental_link::rtc::valid({2025U, 2U, 29U, 0U, 0U, 0U}));
  assert(!dental_link::rtc::valid({1999U, 12U, 31U, 0U, 0U, 0U}));
  assert(!dental_link::rtc::valid({2100U, 1U, 1U, 0U, 0U, 0U}));
}
void decode24And12Hour() {
  uint8_t data[7] = {0x59U, 0x58U, 0x23U, 0x07U, 0x29U, 0x02U, 0x24U};
  DateTime value;
  assert(dental_atmega::ds3231::decodeTime(data, value));
  assert(value.year == 2024U && value.month == 2U && value.day == 29U &&
         value.hour == 23U && value.minute == 58U && value.second == 59U);
  data[2] = 0x72U; // 12-hour mode, PM 12 -> 12.
  assert(dental_atmega::ds3231::decodeTime(data, value) && value.hour == 12U);
  data[2] = 0x41U; // 12-hour mode, AM 1 -> 1.
  assert(dental_atmega::ds3231::decodeTime(data, value) && value.hour == 1U);
}
void invalidRegisters() {
  DateTime value; uint8_t data[7] = {0x00U, 0x00U, 0x00U, 0x01U, 0x01U, 0x01U, 0x26U};
  data[0] = 0x60U; assert(!dental_atmega::ds3231::decodeTime(data, value)); data[0] = 0U;
  data[1] = 0x60U; assert(!dental_atmega::ds3231::decodeTime(data, value)); data[1] = 0U;
  data[2] = 0x24U; assert(!dental_atmega::ds3231::decodeTime(data, value)); data[2] = 0U;
  data[4] = 0x32U; assert(!dental_atmega::ds3231::decodeTime(data, value)); data[4] = 1U;
  data[5] = 0x13U; assert(!dental_atmega::ds3231::decodeTime(data, value)); data[5] = 1U;
  data[6] = 0xAAU; assert(!dental_atmega::ds3231::decodeTime(data, value));
}
void ready() { Fixture f; f.begin(); assert(f.rtc.state() == State::kReady && f.rtc.reason() == Reason::kNone); }
void retainedReadySurvivesControllerReboot() {
  Fixture f; f.begin();
  Driver<Bus> rebooted(f.bus); rebooted.begin();
  for (unsigned i = 0U; i < 40U && !rebooted.idle(); ++i)
    rebooted.service(f.now++);
  assert(rebooted.idle() && rebooted.state() == State::kReady &&
         rebooted.reason() == Reason::kNone);
}
void lostPower() { Fixture f; f.bus.registers[0x0F] = 0x80U; f.begin(); assert(f.rtc.state() == State::kNeedsSync && f.rtc.reason() == Reason::kLostPower); }
void invalidTime() { Fixture f; f.bus.registers[1] = 0x60U; f.begin(); assert(f.rtc.state() == State::kNeedsSync && f.rtc.reason() == Reason::kInvalidTime); }
void unavailable() { Fixture f; f.bus.next = Result::kAddressNack; f.begin(); assert(f.rtc.state() == State::kUnavailable && f.rtc.reason() == Reason::kCommunicationFailure); }
void validRead() {
  Fixture f; f.begin(); const uint16_t sequence = f.rtc.readSequence();
  assert(f.rtc.requestRead()); f.drain();
  assert(f.rtc.readSequence() == sequence + 1U && f.rtc.lastReadSucceeded());
  assert(f.rtc.time().year == 2026U && f.rtc.time().second == 15U);
}
void invalidWriteRejected() {
  Fixture f; f.bus.registers[0x0F] = 0x80U; f.begin();
  assert(!f.rtc.requestSync({2025U, 2U, 29U, 0U, 0U, 0U}));
  assert(f.bus.registers[0x0F] == 0x80U);
}
void validWriteAndVerification() {
  Fixture f; f.bus.registers[0x0F] = 0x80U; f.begin();
  const DateTime target = {2027U, 1U, 2U, 3U, 4U, 5U};
  assert(f.rtc.requestSync(target)); f.drain();
  assert(f.rtc.lastSyncSucceeded() && f.rtc.state() == State::kReady);
  assert((f.bus.registers[0x0F] & 0x80U) == 0U);
  assert(f.rtc.time().year == 2027U && f.rtc.time().second == 5U);
}
void synchronizedTimeSurvivesControllerReboot() {
  Fixture f; f.bus.registers[0x0F] = 0x80U; f.begin();
  const DateTime target = {2027U, 1U, 2U, 3U, 4U, 5U};
  assert(f.rtc.requestSync(target)); f.drain();
  assert(f.rtc.lastSyncSucceeded() &&
         (f.bus.registers[0x0F] & 0x80U) == 0U);
  Driver<Bus> rebooted(f.bus); rebooted.begin();
  for (unsigned i = 0U; i < 40U && !rebooted.idle(); ++i)
    rebooted.service(f.now++);
  assert(rebooted.idle() && rebooted.state() == State::kReady &&
         rebooted.reason() == Reason::kNone);
  assert(rebooted.time().year == target.year &&
         rebooted.time().second == target.second);
}
void writeFailureIsUnavailable() {
  Fixture f; f.bus.registers[0x0F] = 0x80U; f.begin();
  f.bus.next = Result::kDataNack;
  assert(f.rtc.requestSync({2027U, 1U, 2U, 3U, 4U, 5U})); f.drain();
  assert(!f.rtc.lastSyncSucceeded() && f.rtc.state() == State::kUnavailable);
}
void formatParseRoundTrip() {
  const DateTime source = {2028U, 2U, 29U, 9U, 8U, 7U}; char text[20]; DateTime parsed;
  assert(dental_link::rtc::formatDateTime(source, text, sizeof(text)));
  assert(strcmp(text, "2028-02-29 09:08:07") == 0);
  assert(dental_link::rtc::parseDateTime(text, parsed));
  assert(dental_link::rtc::secondsSince2000(source) == dental_link::rtc::secondsSince2000(parsed));
}
void epochRoundTrip() {
  DateTime value = {2099U, 12U, 31U, 23U, 59U, 59U}, observed;
  assert(dental_link::rtc::fromSecondsSince2000(
      dental_link::rtc::secondsSince2000(value), observed));
  assert(observed.year == value.year && observed.month == value.month &&
         observed.day == value.day && observed.second == value.second);
}
}

int main() {
  bcd(); dateValidation(); decode24And12Hour(); invalidRegisters(); ready();
  retainedReadySurvivesControllerReboot(); lostPower(); invalidTime();
  unavailable(); validRead(); invalidWriteRejected(); validWriteAndVerification();
  synchronizedTimeSurvivesControllerReboot(); writeFailureIsUnavailable();
  formatParseRoundTrip(); epochRoundTrip();
  puts("ATmega DS3231: 16 focused scenarios PASSED");
}
