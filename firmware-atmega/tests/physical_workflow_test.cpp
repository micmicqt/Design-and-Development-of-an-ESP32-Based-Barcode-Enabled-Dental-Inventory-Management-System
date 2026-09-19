#include "physical_workflow.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
using dental_atmega::PhysicalState;
using dental_link::Frame;
struct Writer {
  uint8_t bytes[512] = {}; unsigned count = 0U; bool ready = true;
  bool tryWrite(uint8_t byte) {
    if (!ready) return false;
    assert(count < sizeof(bytes)); bytes[count++] = byte; return true;
  }
};
struct Fixture {
  dental_atmega::PhysicalWorkflow owner;
  dental_atmega::PingClient ping;
  Writer wire;
  Fixture() { owner.buttons(0UL, false, false); owner.buttons(50UL, false, false); }
  void press(bool restock, uint32_t now = 100UL) {
    owner.buttons(now, restock, !restock); owner.buttons(now + 50UL, restock, !restock);
  }
  void scan(const char* text, uint32_t now = 200UL) {
    for (; *text; ++text) owner.receive(now, *text);
  }
  void flush(uint32_t now = 201UL) {
    for (unsigned i = 0U; i < 100U; ++i) owner.service(now, ping, wire);
  }
  unsigned operations() const {
    dental_link::LineParser parser; unsigned count = 0U;
    for (unsigned i = 0U; i < wire.count; ++i) {
      const Frame frame = parser.receive(wire.bytes[i]);
      if (frame == Frame::kRestock || frame == Frame::kCheckout) ++count;
    }
    return count;
  }
};
void pins() {
  assert(dental_atmega::hardware::kRestockButtonBit == 2U);
  assert(dental_atmega::hardware::kCheckoutButtonBit == 3U);
  assert((dental_atmega::hardware::kButtonMask & 0xF3U) == 0U);
  assert(dental_atmega::hardware::buttonDdr(0xFFU) == 0xF3U);
  assert(dental_atmega::hardware::buttonPort(0xFFU) == 0xF3U);
  assert(dental_atmega::hardware::buttonDdr(0xF0U) == 0xF0U);
  assert(dental_atmega::hardware::buttonPort(0xF0U) == 0xF0U);
  assert(dental_atmega::hardware::buttonPressed(0x04U, 2U));
  assert(!dental_atmega::hardware::buttonPressed(0x00U, 2U));
}
void restockArms() { Fixture f; f.press(true); assert(f.owner.state() == PhysicalState::kWaitingRestockScan); }
void checkoutArms() { Fixture f; f.press(false); assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan); }
void debounce() {
  Fixture f; f.owner.buttons(100UL, true, false); f.owner.buttons(120UL, false, false);
  f.owner.buttons(130UL, true, false); f.owner.buttons(179UL, true, false);
  assert(f.owner.state() == PhysicalState::kIdle);
  f.owner.buttons(180UL, true, false); assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
}
void held() {
  Fixture f; f.press(true); f.scan("00123\n"); f.flush();
  for (uint32_t now = 300UL; now < 3000UL; now += 50UL) f.owner.buttons(now, true, false);
  f.scan("00123\n", 3000UL); f.flush(3001UL);
  assert(f.operations() == 1U && f.owner.state() == PhysicalState::kIdle);
}
void simultaneous() {
  Fixture f; f.owner.buttons(100UL, true, true); f.owner.buttons(150UL, true, true);
  f.scan("123\n"); f.flush(); assert(f.operations() == 0U);
  f.owner.buttons(200UL, false, false); f.owner.buttons(250UL, false, false);
  f.owner.buttons(300UL, false, false); f.press(false, 350UL);
  assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan);
}
void bootHeld() {
  dental_atmega::PhysicalWorkflow owner;
  owner.buttons(0UL, true, false); owner.buttons(100UL, true, false);
  assert(owner.state() == PhysicalState::kIdle);
  owner.buttons(150UL, false, false); owner.buttons(200UL, false, false);
  owner.buttons(250UL, true, false); owner.buttons(300UL, true, false);
  assert(owner.state() == PhysicalState::kWaitingRestockScan);
}
void busyPress() {
  Fixture f; f.press(true); f.owner.buttons(160UL, false, false); f.owner.buttons(210UL, false, false);
  f.owner.buttons(220UL, false, true); f.owner.buttons(270UL, false, true);
  assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
  f.scan("123\n", 300UL); f.flush(301UL);
  assert(f.operations() == 1U && memcmp(f.wire.bytes, "\nRESTOCK:123\n", 13U) == 0);
}
void idleScan() {
  Fixture f; f.scan("00123\n"); f.flush(); assert(f.operations() == 0U);
  assert(memcmp(f.wire.bytes, "\nSCAN:00123\n", 12U) == 0);
}
void restockDispatch() {
  Fixture f; f.press(true); f.scan("4806016001569\r\n"); f.flush();
  const char expected[] = "\nRESTOCK:4806016001569\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  assert(f.operations() == 1U && f.owner.state() == PhysicalState::kCooldown);
}
void checkoutDispatch() {
  Fixture f; f.press(false); f.scan("0012345678905\n"); f.flush();
  const char expected[] = "\nCHECKOUT:0012345678905\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  assert(f.operations() == 1U);
}
void exactText() {
  Fixture f; f.press(true); f.scan(" 001 A \r"); f.flush();
  const char expected[] = "\nRESTOCK: 001 A \n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
}
void malformedAndPartial() {
  Fixture f; f.scan("old"); f.press(true); f.scan("123\n");
  f.scan("12"); f.owner.receive(200UL, 0U); f.scan("34\n");
  for (unsigned i = 0U; i < 4096U; ++i) f.owner.receive(200UL, 'X');
  f.scan("\n"); f.flush(); assert(f.operations() == 0U);
  f.scan("00123\n", 300UL); f.flush(301UL); assert(f.operations() == 1U);
}
void timeout() {
  Fixture f; f.press(true); f.owner.service(10149UL, f.ping, f.wire);
  assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
  f.owner.service(10150UL, f.ping, f.wire); assert(f.owner.state() == PhysicalState::kIdle);
  f.scan("123\n", 10151UL); f.flush(10152UL); assert(f.operations() == 0U);
}
void wrap() {
  Fixture f; const uint32_t now = UINT32_MAX - 100UL;
  f.press(false, now); f.owner.service(9948UL, f.ping, f.wire);
  assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan);
  f.owner.service(9949UL, f.ping, f.wire); assert(f.owner.state() == PhysicalState::kIdle);
}
void pingAndNoInterleaving() {
  Fixture f; f.ping.service(2000UL, f.wire); f.press(false); f.scan("00123\n"); f.flush(2001UL);
  const char expected[] = "PING\n\nCHECKOUT:00123\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  for (const char* p = "PONG\n"; *p; ++p) f.ping.receive(2002UL, *p);
  assert(f.ping.verifiedCount() == 1U);
}
void repeatedScans() {
  Fixture f; f.press(true); f.scan("123\n123\n123\r\n"); f.flush(); assert(f.operations() == 1U);
  f.scan("123\n", 300UL); f.flush(301UL); assert(f.operations() == 1U);
}
void rearmAfterRelease() {
  Fixture f; f.press(true); f.scan("123\n"); f.flush();
  f.owner.buttons(2201UL, false, false); f.owner.buttons(2251UL, false, false);
  f.press(false, 2300UL); f.scan("123\n", 2400UL); f.flush(2401UL);
  assert(f.operations() == 2U);
}

}
int main() {
  pins(); restockArms(); checkoutArms(); debounce(); held(); simultaneous(); bootHeld();
  busyPress(); idleScan(); restockDispatch(); checkoutDispatch(); exactText();
  malformedAndPartial(); timeout(); wrap(); pingAndNoInterleaving(); repeatedScans(); rearmAfterRelease();
  puts("ATmega D2/D3 physical workflow: 18 focused scenarios PASSED");
}
