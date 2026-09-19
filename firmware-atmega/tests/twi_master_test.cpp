#include "twi_master.h"
#include "hardware_config.h"
#include <assert.h>
#include <stdio.h>
#include <vector>

namespace {
using dental_atmega::twi::Result;
struct Hardware {
  bool complete = false, stopActive = false;
  uint8_t code = 0U, readValue = 0U;
  unsigned starts = 0U, stops = 0U, resets = 0U, initializes = 0U;
  std::vector<uint8_t> sent;
  std::vector<bool> receiveAcks;
  void initialize() { ++initializes; }
  void start() { ++starts; complete = false; }
  void send(uint8_t byte) { sent.push_back(byte); complete = false; }
  void receive(bool acknowledge) { receiveAcks.push_back(acknowledge); complete = false; }
  uint8_t read() const { return readValue; }
  void stop() { ++stops; stopActive = true; complete = false; }
  void reset() { ++resets; complete = stopActive = false; }
  bool ready() const { return complete; }
  bool stopping() const { return stopActive; }
  uint8_t status() const { return code; }
};
struct Fixture {
  Hardware hardware;
  dental_atmega::twi::Master<Hardware> bus{hardware};
  uint8_t bytes[8] = {1U, 2U, 3U, 4U, 5U, 6U, 7U, 8U};
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
  assert(!f.bus.write(0U, 0x27U, f.bytes, 9U));
  assert(!f.bus.writeRead(0U, 0x68U, f.bytes, 1U, 0U));
  assert(!f.bus.writeRead(0U, 0x68U, f.bytes, 1U, 9U));
  assert(f.bus.result() == Result::kInvalid && f.hardware.starts == 0U);
}
void busy() {
  Fixture f; f.begin(); assert(!f.bus.write(1U, 0x27U, f.bytes, 1U));
  assert(f.hardware.starts == 1U && f.bus.result() == Result::kPending);
}
void addressNackAndRetry() {
  Fixture f; f.begin(); f.status(0x08); f.status(0x20); f.stop();
  assert(f.bus.result() == Result::kAddressNack);
  assert(!f.bus.write(3U, 0x27U, f.bytes, 1U));
  assert(f.bus.takeResult() == Result::kAddressNack);
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
  assert(f.hardware.resets == 1U); assert(f.bus.takeResult() == Result::kTimeout);
  f.begin(21U); assert(f.bus.busy());
}
void stuckStop() {
  Fixture f; f.begin(); f.status(0x08); f.status(0x20);
  f.bus.service(20U); assert(f.bus.result() == Result::kTimeout && f.hardware.resets == 1U);
}
void wrap() {
  Fixture f; f.begin(0xFFFFFFF8UL); f.bus.service(11U); assert(f.bus.busy());
  f.bus.service(12U); assert(f.bus.result() == Result::kTimeout);
}
void combinedReadAndCompletionOwnership() {
  Fixture f; const uint8_t reg = 0x0FU;
  assert(f.bus.writeRead(0U, 0x68U, &reg, 1U, 3U));
  f.status(0x08U); f.status(0x18U); f.status(0x28U);
  f.status(0x10U); f.status(0x40U);
  f.hardware.readValue = 0x11U; f.status(0x50U);
  f.hardware.readValue = 0x22U; f.status(0x50U);
  f.hardware.readValue = 0x33U; f.status(0x58U); f.stop();
  assert(f.bus.completionPending() && f.bus.readCount() == 3U);
  assert(f.bus.readData(0U) == 0x11U && f.bus.readData(1U) == 0x22U &&
         f.bus.readData(2U) == 0x33U);
  assert(f.hardware.receiveAcks.size() == 3U &&
         f.hardware.receiveAcks[0] && f.hardware.receiveAcks[1] &&
         !f.hardware.receiveAcks[2]);
  assert(!f.bus.write(3U, 0x27U, &reg, 1U));
  assert(f.bus.takeResult() == Result::kSuccess && !f.bus.completionPending());
  assert(f.bus.write(3U, 0x27U, &reg, 1U));
}
}
int main() {
  timingAndPins(); successAndCopy(); invalid(); busy(); addressNackAndRetry();
  dataNack(); arbitration(); busError(); unexpectedStatus(); timeoutAndRetry(); stuckStop(); wrap();
  combinedReadAndCompletionOwnership();
  puts("ATmega cooperative TWI: 13 focused scenarios PASSED");
}
