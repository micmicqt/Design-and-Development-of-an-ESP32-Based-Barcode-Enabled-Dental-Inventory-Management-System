#include "physical_workflow.h"
#include <assert.h>
#include <initializer_list>
#include <stdio.h>
#include <string.h>
#include <string>

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
  unsigned acknowledgedModes = 0U;
  Fixture() { owner.buttons(0UL, false, false); owner.buttons(50UL, false, false); }
  void press(bool restock, uint32_t now = 100UL) {
    owner.buttons(now, restock, !restock); owner.buttons(now + 50UL, restock, !restock);
  }
  void scan(const char* text, uint32_t now = 200UL) {
    for (; *text; ++text) owner.receive(now, *text);
  }
  void flush(uint32_t now = 201UL) {
    for (unsigned i = 0U; i < 100U; ++i) {
      owner.service(now, ping, wire);
      if (frames(Frame::kRestockMode) + frames(Frame::kCheckoutMode) >
          acknowledgedModes) {
        ++acknowledgedModes;
        owner.modeResponse(now,
            owner.state() == PhysicalState::kWaitingRestockScan ?
                Frame::kRestockAccepted : Frame::kCheckoutAccepted);
      }
    }
  }
  void flushWithoutAck(uint32_t now = 201UL) {
    for (unsigned i = 0U; i < 100U; ++i) owner.service(now, ping, wire);
  }
  unsigned frames(Frame wanted) const {
    dental_link::LineParser parser; unsigned count = 0U;
    for (unsigned i = 0U; i < wire.count; ++i) {
      const Frame frame = parser.receive(wire.bytes[i]);
      if (frame == wanted) ++count;
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
void restockArms() {
  Fixture f; f.press(true); assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
  f.flush();
  assert(f.frames(Frame::kRestockMode) == 1U && f.frames(Frame::kScan) == 0U);
  assert(memcmp(f.wire.bytes, "\nBTN:RESTOCK\n", 13U) == 0);
}
void checkoutArms() {
  Fixture f; f.press(false); assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan);
  f.flush();
  assert(f.frames(Frame::kCheckoutMode) == 1U && f.frames(Frame::kScan) == 0U);
  assert(memcmp(f.wire.bytes, "\nBTN:CHECKOUT\n", 14U) == 0);
}
void debounce() {
  Fixture f; f.owner.buttons(100UL, true, false); f.owner.buttons(120UL, false, false);
  f.owner.buttons(130UL, true, false); f.owner.buttons(179UL, true, false);
  assert(f.owner.state() == PhysicalState::kIdle);
  f.owner.buttons(180UL, true, false); assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
}
void held() {
  Fixture f; f.press(true); f.flush(); f.scan("00123\n"); f.flush();
  for (uint32_t now = 300UL; now < 3000UL; now += 50UL) f.owner.buttons(now, true, false);
  f.scan("00123\n", 3000UL); f.flush(3001UL);
  assert(f.frames(Frame::kRestockMode) == 1U && f.owner.state() == PhysicalState::kIdle);
}
void checkoutHeldAndReleaseAreSilent() {
  Fixture f; f.press(false); f.flush();
  for (uint32_t now = 160UL; now < 500UL; now += 50UL)
    f.owner.buttons(now, false, true);
  f.owner.buttons(500UL, false, false);
  f.owner.buttons(550UL, false, false);
  f.flush(551UL);
  assert(f.frames(Frame::kCheckoutMode) == 1U &&
         f.frames(Frame::kRestockMode) == 0U && f.frames(Frame::kScan) == 0U);
}
void simultaneous() {
  Fixture f; f.owner.buttons(100UL, true, true); f.owner.buttons(150UL, true, true);
  f.scan("123\n"); f.flush(); assert(f.frames(Frame::kRestockMode) == 0U &&
                                      f.frames(Frame::kCheckoutMode) == 0U);
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
  const char expected[] = "\nBTN:RESTOCK\n\nSCAN:123\n";
  assert(f.frames(Frame::kRestockMode) == 1U && f.frames(Frame::kScan) == 1U);
  assert(f.wire.count == sizeof(expected) - 1U &&
         memcmp(f.wire.bytes, expected, f.wire.count) == 0);
}
void idleScan() {
  Fixture f; f.scan("00123\n"); f.flush();
  assert(f.frames(Frame::kRestockMode) == 0U &&
         f.frames(Frame::kCheckoutMode) == 0U);
  assert(memcmp(f.wire.bytes, "\nSCAN:00123\n", 12U) == 0);
}
void restockDispatch() {
  Fixture f; f.press(true); f.scan("4806016001569\r\n"); f.flush();
  const char expected[] = "\nBTN:RESTOCK\n\nSCAN:4806016001569\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  assert(f.frames(Frame::kRestockMode) == 1U && f.frames(Frame::kScan) == 1U &&
         f.owner.state() == PhysicalState::kCooldown);
}
void checkoutDispatch() {
  Fixture f; f.press(false); f.scan("0012345678905\n"); f.flush();
  const char expected[] = "\nBTN:CHECKOUT\n\nSCAN:0012345678905\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  assert(f.frames(Frame::kCheckoutMode) == 1U && f.frames(Frame::kScan) == 1U);
}
void exactText() {
  Fixture f; f.press(true); f.scan(" 001 A \r"); f.flush();
  const char expected[] = "\nBTN:RESTOCK\n\nSCAN: 001 A \n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
}
void malformedAndPartial() {
  Fixture f; f.scan("old"); f.press(true); f.scan("123\n");
  f.scan("12"); f.owner.receive(200UL, 0U); f.scan("34\n");
  for (unsigned i = 0U; i < 4096U; ++i) f.owner.receive(200UL, 'X');
  f.scan("\n"); f.flush(); assert(f.frames(Frame::kScan) == 0U);
  f.scan("00123\n", 300UL); f.flush(301UL); assert(f.frames(Frame::kScan) == 1U);
}
void timeout() {
  Fixture f; f.press(true); f.owner.service(10149UL, f.ping, f.wire);
  assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
  f.owner.service(10150UL, f.ping, f.wire); assert(f.owner.state() == PhysicalState::kIdle);
  f.scan("123\n", 10151UL); f.flush(10152UL);
  assert(f.frames(Frame::kRestockMode) == 0U &&
         f.frames(Frame::kCheckoutMode) == 0U);
}
void wrap() {
  Fixture f; const uint32_t now = UINT32_MAX - 100UL;
  f.press(false, now); f.owner.service(9948UL, f.ping, f.wire);
  assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan);
  f.owner.service(9949UL, f.ping, f.wire); assert(f.owner.state() == PhysicalState::kIdle);
}
void pingAndNoInterleaving() {
  Fixture f; f.ping.service(2000UL, f.wire); f.press(false); f.scan("00123\n"); f.flush(2001UL);
  const char expected[] = "PING\n\nBTN:CHECKOUT\n\nSCAN:00123\n";
  assert(f.wire.count == sizeof(expected) - 1U && memcmp(f.wire.bytes, expected, f.wire.count) == 0);
  for (const char* p = "PONG\n"; *p; ++p) f.ping.receive(2002UL, *p);
  assert(f.ping.verifiedCount() == 1U);
}
void repeatedScans() {
  Fixture f; f.press(true); f.scan("123\n123\n123\r\n"); f.flush();
  assert(f.frames(Frame::kRestockMode) == 1U && f.frames(Frame::kScan) == 1U);
  f.scan("123\n", 300UL); f.flush(301UL); assert(f.frames(Frame::kScan) == 1U);
}
void rearmAfterRelease() {
  Fixture f; f.press(true); f.scan("123\n"); f.flush();
  f.owner.buttons(2201UL, false, false); f.owner.buttons(2251UL, false, false);
  f.press(false, 2300UL); f.scan("123\n", 2400UL); f.flush(2401UL);
  assert(f.frames(Frame::kRestockMode) == 1U &&
         f.frames(Frame::kCheckoutMode) == 1U && f.frames(Frame::kScan) == 2U);
}
void deliveryRequiresAckAndRetriesSafely() {
  Fixture f; f.press(false); f.scan("00123\n");
  f.flushWithoutAck();
  assert(f.frames(Frame::kCheckoutMode) == 1U);
  assert(f.frames(Frame::kScan) == 0U);
  assert(!f.owner.modeAcknowledged());
  f.owner.modeResponse(202UL, Frame::kRestockAccepted);
  assert(!f.owner.modeAcknowledged());
  f.flushWithoutAck(1402UL);
  assert(f.frames(Frame::kCheckoutMode) == 2U);
  assert(f.frames(Frame::kScan) == 0U);
  f.owner.modeResponse(1403UL, Frame::kCheckoutAccepted);
  f.flushWithoutAck(1404UL);
  assert(f.frames(Frame::kScan) == 1U);
  assert(f.owner.state() == PhysicalState::kCooldown);
}
void deliveryExhaustionIsSafe() {
  Fixture f; f.press(true); f.scan("00123\n");
  f.flushWithoutAck(201UL);
  f.flushWithoutAck(1402UL);
  f.flushWithoutAck(2603UL);
  assert(f.owner.modeAttempts() == 3U);
  f.flushWithoutAck(3804UL);
  assert(f.owner.state() == PhysicalState::kDeliveryError);
  assert(f.frames(Frame::kScan) == 0U);
  f.owner.buttons(5805UL, false, false);
  f.owner.buttons(5855UL, false, false);
  assert(f.owner.state() == PhysicalState::kIdle);
  f.press(false, 5900UL);
  assert(f.owner.state() == PhysicalState::kWaitingCheckoutScan);
}
void rejectionDoesNotForwardBarcode() {
  Fixture f; f.press(true); f.scan("123\n"); f.flushWithoutAck();
  f.owner.modeResponse(202UL, Frame::kModeRejected);
  f.flushWithoutAck(203UL);
  assert(f.owner.state() == PhysicalState::kModeRejected);
  assert(f.frames(Frame::kScan) == 0U);
}
void storageRejectionIsNotLinkFailure() {
  for (bool restock : {true, false}) {
    Fixture f; f.press(restock); f.scan("00123\n"); f.flushWithoutAck();
    f.owner.modeResponse(202UL, Frame::kModeStorageUnavailable);
    f.flushWithoutAck(203UL);
    assert(f.owner.state() == PhysicalState::kStorageUnavailable);
    assert(f.frames(Frame::kScan) == 0U);
  }
}
void busyReplyIsNotLinkFailure() {
  Fixture f; f.press(true); f.flushWithoutAck();
  f.owner.modeResponse(202UL, Frame::kModeBusy);
  f.flushWithoutAck(1402UL);
  f.flushWithoutAck(2603UL);
  f.flushWithoutAck(3804UL);
  assert(f.owner.state() == PhysicalState::kModeBusy);
  assert(f.frames(Frame::kScan) == 0U);
}
void unrelatedAndLateRepliesCannotRejectAnAcceptedOrExpiredMode() {
  Fixture f; f.press(true); f.flushWithoutAck();
  for (Frame unrelated : {Frame::kRejected, Frame::kPong, Frame::kRtcStatus,
                          Frame::kRtcTime, Frame::kScan}) {
    f.owner.modeResponse(202UL, unrelated);
    assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
    assert(!f.owner.modeAcknowledged());
  }
  f.owner.modeResponse(203UL, Frame::kRestockAccepted);
  for (Frame late : {Frame::kModeRejected, Frame::kModeStorageUnavailable,
                     Frame::kModeBusy}) {
    f.owner.modeResponse(204UL, late);
    assert(f.owner.modeAcknowledged());
    assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
  }
  f.owner.buttons(10204UL, false, false);
  f.owner.modeResponse(10205UL, Frame::kModeRejected);
  assert(f.owner.state() == PhysicalState::kIdle);
}
void hundredAlternatingModesRecoverAfterTimeoutAndRejection() {
  Fixture f;
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    const uint32_t now = 100UL + cycle * 15000UL;
    f.wire.count = 0U;
    f.press((cycle & 1U) == 0U, now);
    f.flushWithoutAck(now + 51UL);
    assert(f.frames((cycle & 1U) == 0U ? Frame::kRestockMode :
                                           Frame::kCheckoutMode) == 1U);
    if (cycle % 3U == 0U) {
      f.owner.modeResponse(now + 52UL, Frame::kModeStorageUnavailable);
      assert(f.owner.state() == PhysicalState::kStorageUnavailable);
    } else if (cycle % 3U == 1U) {
      f.flushWithoutAck(now + 1500UL);
      f.flushWithoutAck(now + 3000UL);
      f.flushWithoutAck(now + 4500UL);
      assert(f.owner.state() == PhysicalState::kDeliveryError);
    } else {
      f.owner.modeResponse(now + 52UL, (cycle & 1U) == 0U ?
          Frame::kRestockAccepted : Frame::kCheckoutAccepted);
      assert(f.owner.modeAcknowledged());
    }
    f.owner.buttons(now + 12000UL, false, false);
    f.owner.buttons(now + 12050UL, false, false);
    assert(f.owner.state() == PhysicalState::kIdle);
    assert(f.frames(Frame::kScan) == 0U);
  }
}

}

int main() {
  {
    dental_atmega::PingClient link;
    Frame response = Frame::kNone;
    for (char byte : std::string(dental_link::kModeWaiting))
      response = link.receive(100UL, static_cast<uint8_t>(byte));
    assert(response == Frame::kModeWaiting);
  }
  {
    Fixture f; f.press(true); f.flushWithoutAck();
    // A protected FatFs call may legitimately exceed the original scan window.
    for (uint32_t time = 500UL; time < 20000UL; time += 500UL) {
      f.owner.modeResponse(time, Frame::kModeWaiting);
      f.flushWithoutAck(time + 1UL);
      assert(!f.owner.modeAcknowledged());
      assert(f.owner.state() == PhysicalState::kWaitingRestockScan);
    }
    f.owner.modeResponse(20000UL, Frame::kRestockAccepted);
    f.scan("000001\n", 20001UL); f.flushWithoutAck(20002UL);
    assert(f.frames(Frame::kScan) == 1U);
  }
  {
    Fixture f; f.press(false); f.flushWithoutAck();
    f.owner.modeResponse(500UL, Frame::kModeWaiting);
    f.flushWithoutAck(2000UL); f.flushWithoutAck(3500UL); f.flushWithoutAck(5000UL);
    assert(f.owner.state() == PhysicalState::kDeliveryError);
    assert(f.frames(Frame::kScan) == 0U);
  }
  {
    Fixture f; f.press(true); f.flushWithoutAck();
    f.owner.modeResponse(202UL, Frame::kModeInitializing);
    assert(f.owner.state() == PhysicalState::kInitializing && !f.owner.modeAcknowledged());
    f.scan("000001\n", 203UL); f.flushWithoutAck(204UL);
    assert(f.frames(Frame::kScan) == 0U);
    f.owner.buttons(2300UL, false, false);
    assert(f.owner.state() == PhysicalState::kIdle);
  }
  pins(); restockArms(); checkoutArms(); debounce(); held();
  checkoutHeldAndReleaseAreSilent(); simultaneous(); bootHeld();
  busyPress(); idleScan(); restockDispatch(); checkoutDispatch(); exactText();
  malformedAndPartial(); timeout(); wrap(); pingAndNoInterleaving(); repeatedScans(); rearmAfterRelease();
  deliveryRequiresAckAndRetriesSafely(); deliveryExhaustionIsSafe();
  rejectionDoesNotForwardBarcode();
  storageRejectionIsNotLinkFailure(); busyReplyIsNotLinkFailure();
  unrelatedAndLateRepliesCannotRejectAnAcceptedOrExpiredMode();
  hundredAlternatingModesRecoverAfterTimeoutAndRejection();
  puts("ATmega D2/D3 physical workflow: 30 scenarios, 100 recovery cycles PASSED");
}
