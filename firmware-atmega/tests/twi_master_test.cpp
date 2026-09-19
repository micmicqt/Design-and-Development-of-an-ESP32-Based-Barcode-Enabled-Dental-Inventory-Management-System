#include "twi_master.h"
#include "hardware_config.h"
#include <assert.h>
#include <stdio.h>
#include <vector>

namespace {
using dental_atmega::twi::Result;
struct Hardware {
  bool complete = false, stopActive = false;
  uint8_t code = 0U;
  unsigned starts = 0U, stops = 0U, resets = 0U, initializes = 0U;
  std::vector<uint8_t> sent;
  void initialize() { ++initializes; }
  void start() { ++starts; complete = false; }
  void send(uint8_t byte) { sent.push_back(byte); complete = false; }
  void stop() { ++stops; stopActive = true; complete = false; }
  void reset() { ++resets; complete = stopActive = false; }
  bool ready() const { return complete; }
  bool stopping() const { return stopActive; }
  uint8_t status() const { return code; }
};
struct Fixture {
  Hardware hardware;
  dental_atmega::twi::Master<Hardware> bus{hardware};
  uint8_t bytes[6] = {1U, 2U, 3U, 4U, 5U, 6U};
  void begin(uint32_t now = 0U, uint8_t count = 6U) {
    assert(bus.write(now, 0x27U, bytes, count));
    assert(bus.busy() && bus.result() == Result::kPending);
  }
  void status(uint8_t code, uint32_t now = 1U) {
    hardware.complete = true; hardware.code = code; bus.service(now);
  }
  void stop(uint32_t now = 2U) { hardware.stopActive = false; bus.service(now); }
};
void timingAndPins() {
  assert(dental_atmega::twi::bitRate(16000000UL) == 72U);
  assert(16000000UL / (16UL + 2UL * 72UL) == 100000UL);
  assert(dental_atmega::hardware::kTwiSdaBit == 4U);
  assert(dental_atmega::hardware::kTwiSclBit == 5U);
  Fixture f; f.bus.initialize(); assert(f.hardware.initializes == 1U);
}
void successAndCopy() {
  Fixture f; f.begin(); f.bytes[0] = 99U;
  f.status(0x08); f.status(0x18);
  for (unsigned i = 0U; i < 6U; ++i) f.status(0x28);
  assert(f.bus.busy()); f.stop();
  assert(f.bus.result() == Result::kSuccess && !f.bus.busy());
  assert(f.hardware.sent.size() == 7U && f.hardware.sent[0] == 0x4EU);
  for (unsigned i = 1U; i < 7U; ++i) assert(f.hardware.sent[i] == i);
}
void invalid() {
  Fixture f;
  assert(!f.bus.write(0U, 0x07U, f.bytes, 1U));
  assert(!f.bus.write(0U, 0x78U, f.bytes, 1U));
  assert(!f.bus.write(0U, 0x27U, nullptr, 1U));
  assert(!f.bus.write(0U, 0x27U, f.bytes, 0U));
  assert(!f.bus.write(0U, 0x27U, f.bytes, 7U));
  assert(f.bus.result() == Result::kInvalid && f.hardware.starts == 0U);
}
void busy() {
  Fixture f; f.begin(); assert(!f.bus.write(1U, 0x27U, f.bytes, 1U));
  assert(f.hardware.starts == 1U && f.bus.result() == Result::kPending);
}
void addressNackAndRetry() {
  Fixture f; f.begin(); f.status(0x08); f.status(0x20); f.stop();
  assert(f.bus.result() == Result::kAddressNack);
  f.begin(3U, 1U); f.status(0x10, 4U); f.status(0x18, 4U); f.status(0x28, 4U); f.stop(5U);
  assert(f.bus.result() == Result::kSuccess);
}
void dataNack() {
  Fixture f; f.begin(); f.status(0x08); f.status(0x18); f.status(0x30); f.stop();
  assert(f.bus.result() == Result::kDataNack && f.hardware.sent.size() == 2U);
}
void arbitration() {
  Fixture f; f.begin(); f.status(0x38);
  assert(f.bus.result() == Result::kArbitrationLost && f.hardware.stops == 0U && f.hardware.resets == 1U);
}
void busError() {
  Fixture f; f.begin(); f.status(0x00); f.stop(); assert(f.bus.result() == Result::kBusError);
}
void unexpectedStatus() {
  Fixture f; f.begin(); f.status(0x28); f.stop(); assert(f.bus.result() == Result::kBusError);
}
void timeoutAndRetry() {
  Fixture f; f.begin(); f.bus.service(19U); assert(f.bus.busy());
  f.bus.service(20U); assert(!f.bus.busy() && f.bus.result() == Result::kTimeout);
  assert(f.hardware.resets == 1U); f.begin(21U); assert(f.bus.busy());
}
void stuckStop() {
  Fixture f; f.begin(); f.status(0x08); f.status(0x20);
  f.bus.service(20U); assert(f.bus.result() == Result::kTimeout && f.hardware.resets == 1U);
}
void wrap() {
  Fixture f; f.begin(0xFFFFFFF8UL); f.bus.service(11U); assert(f.bus.busy());
  f.bus.service(12U); assert(f.bus.result() == Result::kTimeout);
}
}
int main() {
  timingAndPins(); successAndCopy(); invalid(); busy(); addressNackAndRetry();
  dataNack(); arbitration(); busError(); unexpectedStatus(); timeoutAndRetry(); stuckStop(); wrap();
  puts("ATmega cooperative TWI: 12 focused scenarios PASSED");
}
