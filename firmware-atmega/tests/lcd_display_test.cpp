#include "lcd_display.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <vector>

namespace {
using dental_atmega::twi::Result;
namespace lcd = dental_atmega::lcd;
struct Bus {
  bool active = false, stuck = false;
  Result next = Result::kSuccess, last = Result::kIdle;
  uint32_t since = 0UL;
  std::vector<std::vector<uint8_t> > writes;
  std::vector<uint32_t> times;
  bool write(uint32_t now, uint8_t address, const uint8_t* data, uint8_t count) {
    assert(address == 0x27U && count <= 6U && !active);
    writes.push_back(std::vector<uint8_t>(data, data + count)); times.push_back(now);
    active = true; last = Result::kPending; since = now; return true;
  }
  void service(uint32_t now) {
    if (!active) return;
    if (stuck && static_cast<uint32_t>(now - since) < 20UL) return;
    active = false; last = stuck ? Result::kTimeout : next;
  }
  bool busy() const { return active; }
  Result result() const { return last; }
};
struct Fixture {
  Bus bus;
  lcd::Display<Bus> display{bus};
  uint32_t now = 0UL;
  void tick() { display.service(now++); }
  void initialize() {
    display.begin(now);
    for (unsigned i = 0U; i < 500U && !display.available() && display.state() != lcd::State::kFailed; ++i) tick();
  }
  void drain() {
    for (unsigned i = 0U; i < 500U && display.busy(); ++i) tick();
    assert(!display.busy());
  }
};
uint8_t decode(const std::vector<uint8_t>& bytes) {
  assert(bytes.size() == 6U);
  return (bytes[0] & 0xF0U) | (bytes[3] >> 4U);
}
void encoding() {
  uint8_t bytes[6]; lcd::encode(0x41U, true, bytes);
  const uint8_t expected[] = {0x49U, 0x4DU, 0x49U, 0x19U, 0x1DU, 0x19U};
  assert(memcmp(bytes, expected, 6U) == 0);
  lcd::encode(0x28U, false, bytes);
  for (uint8_t byte : bytes) assert((byte & 0x03U) == 0U && (byte & 0x08U) != 0U);
}
void cursors() {
  const uint8_t expected[4] = {0x80U, 0xC0U, 0x94U, 0xD4U}; uint8_t command;
  for (uint8_t row = 0U; row < 4U; ++row) {
    assert(lcd::cursorCommand(0U, row, command) && command == expected[row]);
    assert(lcd::cursorCommand(19U, row, command) && command == expected[row] + 19U);
  }
  assert(!lcd::cursorCommand(20U, 0U, command) && !lcd::cursorCommand(0U, 4U, command));
}
void initialization() {
  Fixture f; f.initialize(); assert(f.display.available() && f.bus.writes.size() == 10U);
  assert(f.bus.times[0] >= 50U && f.bus.writes[0][0] == 0x08U);
  for (unsigned i = 1U; i < 5U; ++i) {
    assert(f.bus.writes[i].size() == 3U);
    assert(f.bus.writes[i][0] == (i == 4U ? 0x28U : 0x38U));
  }
  assert(f.bus.times[2] - f.bus.times[1] >= 5U && f.bus.times[3] - f.bus.times[2] >= 5U);
  const uint8_t commands[5] = {0x28U, 0x08U, 0x01U, 0x06U, 0x0CU};
  for (unsigned i = 0U; i < 5U; ++i) assert(decode(f.bus.writes[5U + i]) == commands[i]);
  assert(f.bus.times[8] - f.bus.times[7] >= 2U);
}
void clearAndCursor() {
  Fixture f; f.initialize(); assert(f.display.clear(f.now)); f.drain();
  assert(decode(f.bus.writes.back()) == 0x01U);
  assert(f.display.setCursor(f.now, 7U, 3U)); f.drain();
  assert(decode(f.bus.writes.back()) == 0xDBU);
  assert(!f.display.setCursor(f.now, 0U, 4U));
}
void textAndCopy() {
  Fixture f; f.initialize(); char text[] = "001234";
  assert(f.display.write(f.now, text, 6U)); text[0] = '9'; f.drain();
  assert(f.bus.writes.size() == 16U);
  for (unsigned i = 0U; i < 6U; ++i) {
    assert(decode(f.bus.writes[10U + i]) == static_cast<uint8_t>("001234"[i]));
    assert((f.bus.writes[10U + i][0] & 0x03U) == 1U);
  }
}
void textBounds() {
  Fixture f; f.initialize(); char text[21]; memset(text, 'X', sizeof(text));
  assert(!f.display.write(f.now, nullptr, 1U)); assert(!f.display.write(f.now, text, 0U));
  assert(!f.display.write(f.now, text, 21U)); assert(!f.display.write(f.now, "X\n", 2U));
  assert(f.display.setCursor(f.now, 19U, 0U)); f.drain();
  assert(!f.display.write(f.now, text, 2U)); assert(f.display.write(f.now, text, 1U)); f.drain();
  assert(!f.display.write(f.now, text, 1U));
}
void busyRejects() {
  Fixture f; assert(!f.display.clear(0U)); f.initialize();
  assert(f.display.clear(f.now)); assert(!f.display.clear(f.now));
  assert(!f.display.setCursor(f.now, 0U, 0U)); assert(!f.display.write(f.now, "A", 1U));
  f.drain(); assert(f.display.available());
}
void nackAndRestart() {
  Fixture f; f.bus.next = Result::kAddressNack; f.initialize();
  assert(!f.display.available() && f.display.error() == Result::kAddressNack);
  for (unsigned i = 0U; i < 100U; ++i) f.tick();
  assert(f.bus.writes.size() == 1U && !f.display.clear(f.now));
  f.bus.next = Result::kSuccess; f.initialize(); assert(f.display.available());
}
void textFailure() {
  Fixture f; f.initialize(); f.bus.next = Result::kDataNack;
  assert(f.display.write(f.now, "abc", 3U)); f.drain();
  assert(f.display.error() == Result::kDataNack && !f.display.available());
  assert(f.bus.writes.size() == 11U);
}
void timeout() {
  Fixture f; f.bus.stuck = true; f.initialize();
  assert(f.display.state() == lcd::State::kFailed && f.display.error() == Result::kTimeout);
}
void wrap() {
  Fixture f; f.now = 0xFFFFFFE0UL; f.initialize(); assert(f.display.available());
}
void screenLines() {
  char line[20];
  lcd::screenLine(lcd::Screen::kReady, 0U, line); assert(memcmp(line, "Dental Inventory    ", 20U) == 0);
  lcd::screenLine(lcd::Screen::kReady, 1U, line); assert(memcmp(line, "ATmega Controller   ", 20U) == 0);
  lcd::screenLine(lcd::Screen::kReady, 2U, line); assert(memcmp(line, "LCD READY           ", 20U) == 0);
  lcd::screenLine(lcd::Screen::kReady, 3U, line); assert(memcmp(line, "                    ", 20U) == 0);
  lcd::screenLine(lcd::Screen::kRestockWait, 2U, line); assert(memcmp(line, "RESTOCK WAIT        ", 20U) == 0);
  lcd::screenLine(lcd::Screen::kCheckoutWait, 2U, line); assert(memcmp(line, "CHECKOUT WAIT       ", 20U) == 0);
}
void workflowScreens() {
  Fixture f; f.initialize(); lcd::WorkflowScreen screen;
  const dental_atmega::PhysicalState states[] = {dental_atmega::PhysicalState::kIdle,
    dental_atmega::PhysicalState::kWaitingRestockScan, dental_atmega::PhysicalState::kWaitingCheckoutScan};
  for (auto state : states) {
    const size_t start = f.bus.writes.size();
    for (unsigned i = 0U; i < 600U; ++i) screen.service(f.now++, state, f.display);
    assert(f.bus.writes.size() == start + 84U); // 4 cursor commands + 80 chars.
    char expected[20]; lcd::screenLine(lcd::screenFor(state), 2U, expected);
    for (unsigned i = 0U; i < 20U; ++i) assert(decode(f.bus.writes[start + 43U + i]) == static_cast<uint8_t>(expected[i]));
    const size_t stable = f.bus.writes.size();
    for (unsigned i = 0U; i < 100U; ++i) screen.service(f.now++, state, f.display);
    assert(f.bus.writes.size() == stable); // No continuous repaint/clear.
  }
}
void latestScreenAndRecovery() {
  Fixture f; f.initialize(); lcd::WorkflowScreen screen;
  for (unsigned i = 0U; i < 25U; ++i)
    screen.service(f.now++, dental_atmega::PhysicalState::kWaitingRestockScan, f.display);
  for (unsigned i = 0U; i < 600U; ++i)
    screen.service(f.now++, dental_atmega::PhysicalState::kWaitingCheckoutScan, f.display);
  const size_t start = f.bus.writes.size() - 84U;
  char expected[20]; lcd::screenLine(lcd::Screen::kCheckoutWait, 2U, expected);
  for (unsigned i = 0U; i < 20U; ++i)
    assert(decode(f.bus.writes[start + 43U + i]) == static_cast<uint8_t>(expected[i]));
  // Reinitialize after a runtime failure; clear resets both software/physical
  // cursor, and the same desired screen must be repainted after recovery.
  f.bus.next = Result::kDataNack; assert(f.display.clear(f.now)); f.drain();
  screen.service(f.now++, dental_atmega::PhysicalState::kWaitingCheckoutScan, f.display);
  f.bus.next = Result::kSuccess; f.initialize();
  const size_t recovered = f.bus.writes.size();
  for (unsigned i = 0U; i < 600U; ++i)
    screen.service(f.now++, dental_atmega::PhysicalState::kWaitingCheckoutScan, f.display);
  assert(f.bus.writes.size() == recovered + 84U);
}
struct Writer {
  std::vector<uint8_t> bytes;
  bool tryWrite(uint8_t byte) { bytes.push_back(byte); return true; }
};
void failureIsolation() {
  for (bool restock : {true, false}) {
    Fixture f; f.bus.stuck = true; f.initialize();
    dental_atmega::PhysicalWorkflow workflow; dental_atmega::PingClient ping;
    Writer wire; lcd::WorkflowScreen screen;
    workflow.buttons(0U, true, true); workflow.buttons(50U, true, true);
    workflow.buttons(100U, !restock, restock); workflow.buttons(150U, !restock, restock);
    assert(workflow.state() == (restock ? dental_atmega::PhysicalState::kWaitingRestockScan : dental_atmega::PhysicalState::kWaitingCheckoutScan));
    for (const char* p = "001234\r\n"; *p; ++p) workflow.receive(200U, *p);
    for (unsigned i = 0U; i < 100U; ++i) {
      workflow.service(201U, ping, wire); screen.service(201U, workflow.state(), f.display);
    }
    dental_link::LineParser parser; unsigned operations = 0U;
    for (uint8_t byte : wire.bytes) {
      const auto frame = parser.receive(byte);
      if (frame == (restock ? dental_link::Frame::kRestock : dental_link::Frame::kCheckout)) {
        ++operations; assert(strcmp(parser.barcode(), "001234") == 0);
      }
    }
    assert(operations == 1U && f.display.error() == Result::kTimeout);
  }
}
}
int main() {
  encoding(); cursors(); initialization(); clearAndCursor(); textAndCopy(); textBounds();
  busyRejects(); nackAndRestart(); textFailure(); timeout(); wrap(); screenLines(); workflowScreens(); latestScreenAndRecovery(); failureIsolation();
  puts("ATmega LCD: 15 focused scenarios PASSED");
}
