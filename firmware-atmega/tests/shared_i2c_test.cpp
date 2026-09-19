#include "ds3231.h"
#include "lcd_display.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <vector>

namespace {
using dental_atmega::twi::Result;
struct Bus {
  uint8_t registers[0x20] = {};
  uint8_t readBytes[8] = {}, writeBytes[8] = {};
  uint8_t readLength = 0U, writeLength = 0U, address = 0U;
  uint8_t failingAddress = 0U;
  bool active = false, completion = false;
  Result last = Result::kIdle;
  std::vector<uint8_t> addresses;
  bool write(uint32_t, uint8_t target, const uint8_t* data, uint8_t count) {
    if (active || completion || !data || !count || count > 8U) return false;
    address = target; memcpy(writeBytes, data, count); writeLength = count;
    readLength = 0U; active = true; last = Result::kPending;
    addresses.push_back(target); return true;
  }
  bool writeRead(uint32_t, uint8_t target, const uint8_t* data,
                 uint8_t writeCount, uint8_t count) {
    if (active || completion || target != 0x68U || !data || writeCount != 1U ||
        count > 8U) return false;
    address = target; writeLength = 0U; readLength = count;
    for (uint8_t i = 0U; i < count; ++i) readBytes[i] = registers[data[0] + i];
    active = true; last = Result::kPending; addresses.push_back(target); return true;
  }
  void service(uint32_t) {
    if (!active) return;
    active = false; completion = true;
    last = address == failingAddress ? Result::kAddressNack : Result::kSuccess;
    if (last == Result::kSuccess && address == 0x68U && writeLength > 1U) {
      for (uint8_t i = 1U; i < writeLength; ++i)
        registers[writeBytes[0] + i - 1U] = writeBytes[i];
    }
  }
  bool busy() const { return active; }
  bool completionPending() const { return completion; }
  Result takeResult() { completion = false; return last; }
  Result result() const { return last; }
  uint8_t readData(uint8_t index) const { return index < readLength ? readBytes[index] : 0U; }
};
struct Fixture {
  Bus bus;
  dental_atmega::lcd::Display<Bus> lcd{bus};
  dental_atmega::ds3231::Driver<Bus> rtc{bus};
  uint32_t now = 0U;
  Fixture() {
    const dental_link::rtc::DateTime time = {2026U, 9U, 19U, 1U, 2U, 3U};
    uint8_t encoded[8]; dental_atmega::ds3231::encodeTime(time, encoded);
    memcpy(bus.registers, encoded + 1U, 7U); bus.registers[0x0F] = 0U;
  }
  void begin() { lcd.begin(now); rtc.begin(); }
  void run(unsigned count = 1000U) {
    for (unsigned i = 0U; i < count; ++i) {
      // Match the production main-loop order so RTC-first bus ownership cannot
      // be mistaken by the LCD client for an LCD transfer failure.
      rtc.service(now); lcd.service(now); ++now;
    }
  }
};
void coexist() {
  Fixture f; f.begin(); f.run();
  assert(f.lcd.available());
  assert(f.rtc.state() == dental_link::rtc::State::kReady);
  bool sawLcd = false, sawRtc = false;
  for (uint8_t address : f.bus.addresses) {
    if (address == 0x27U) sawLcd = true;
    if (address == 0x68U) sawRtc = true;
  }
  assert(sawLcd && sawRtc);
}
void rtcNackDoesNotBlockLcd() {
  Fixture f; f.bus.failingAddress = 0x68U; f.begin(); f.run();
  assert(f.lcd.available());
  assert(f.rtc.state() == dental_link::rtc::State::kUnavailable);
}
void lcdNackDoesNotBlockRtc() {
  Fixture f; f.bus.failingAddress = 0x27U; f.begin(); f.run();
  assert(f.lcd.state() == dental_atmega::lcd::State::kFailed);
  assert(f.rtc.state() == dental_link::rtc::State::kReady);
}
void rtcClockRefreshSerializesWithLcdUpdate() {
  Fixture f; f.begin(); f.run();
  dental_atmega::lcd::WorkflowScreen screen;
  assert(f.rtc.requestRead());
  for (unsigned i = 0U; i < 600U; ++i) {
    f.rtc.service(f.now);
    screen.service(f.now, dental_atmega::PhysicalState::kIdle,
                   f.rtc.state(), f.rtc.time(), f.lcd);
    ++f.now;
  }
  assert(f.rtc.lastReadSucceeded());
  assert(f.rtc.state() == dental_link::rtc::State::kReady);
  assert(f.lcd.available());
}
}
int main() {
  coexist(); rtcNackDoesNotBlockLcd(); lcdNackDoesNotBlockRtc();
  rtcClockRefreshSerializesWithLcdUpdate();
  puts("ATmega shared LCD/RTC I2C: 4 focused scenarios PASSED");
}
