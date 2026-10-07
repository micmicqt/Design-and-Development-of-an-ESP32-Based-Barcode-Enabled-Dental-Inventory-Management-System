#include "software_uart.h"
#include "hardware_config.h"
#include <assert.h>
#include <stdio.h>
#include <vector>

namespace {
namespace soft = dental_atmega::software_uart;
void controllerOwnership() {
  assert(soft::kRxPortBit == 6U && soft::kTxPortBit == 7U);
  assert(dental_atmega::hardware::kScannerRxBit == 0U);
  assert(dental_atmega::hardware::kScannerTxBit == 1U);
  assert((dental_atmega::hardware::kScannerMask & dental_atmega::hardware::kControllerMask) == 0U);
}
void timingAndWrap() {
  assert(soft::kBitTicks == 208U && soft::kHalfBitTicks == 104U);
  assert(!soft::deadlineDue(99U, 100U) && soft::deadlineDue(100U, 100U));
  assert(soft::deadlineDue(2U, 65530U));
  assert(soft::deadlineBefore(65530U, 2U));
}
std::vector<bool> frame(uint8_t byte, uint16_t start = 0U) {
  soft::TimedSender sender; sender.begin(byte, start);
  std::vector<bool> bits; bits.push_back(false); // externally driven start bit
  uint16_t now = static_cast<uint16_t>(start + soft::kBitTicks);
  while (sender.active()) {
    assert(sender.due(now)); bits.push_back(sender.tick());
    now = static_cast<uint16_t>(now + soft::kBitTicks);
  }
  return bits;
}
void completeFrame() {
  const auto bits = frame(0xA5U);
  assert(bits.size() == 11U && !bits[0]);
  for (unsigned bit = 0U; bit < 8U; ++bit)
    assert(bits[1U + bit] == ((0xA5U & (1U << bit)) != 0U));
  assert(bits[9] && bits[10]); // stop level and full stop-bit completion.
}
void allBytes() {
  for (unsigned byte = 0U; byte < 256U; ++byte) {
    const auto bits = frame(static_cast<uint8_t>(byte), 65500U);
    soft::TimedReceiver rx; rx.begin(0U);
    assert(rx.sample(false) == soft::SampleResult::kMore);
    for (unsigned bit = 0U; bit < 8U; ++bit)
      assert(rx.sample(bits[1U + bit]) == soft::SampleResult::kMore);
    assert(rx.sample(bits[9]) == soft::SampleResult::kByte && rx.byte() == byte);
  }
}
void malformedFrames() {
  soft::TimedReceiver rx; rx.begin(0U);
  assert(rx.sample(true) == soft::SampleResult::kFalseStart);
  rx.begin(0U); assert(rx.sample(false) == soft::SampleResult::kMore);
  for (unsigned i = 0U; i < 8U; ++i) rx.sample(false);
  assert(rx.sample(false) == soft::SampleResult::kFramingError);
}
void boundedQueues() {
  soft::Ring<soft::ReceivedByte, 64U> receive;
  for (unsigned i = 0U; i < 63U; ++i) assert(receive.push({static_cast<uint8_t>(i), false}));
  assert(!receive.push({'X', false})); receive.clear();
  soft::ReceivedByte byte; assert(!receive.pop(byte));
  soft::Ring<uint8_t> transmit; uint8_t value;
  for (unsigned i = 0U; i < 15U; ++i) assert(transmit.push(static_cast<uint8_t>(i)));
  assert(!transmit.push(16U));
  for (unsigned i = 0U; i < 15U; ++i) assert(transmit.pop(value) && value == i);
}
void noDynamicStateGrowth() {
  assert(sizeof(soft::TimedSender) <= 6U);
  assert(sizeof(soft::TimedReceiver) <= 6U);
  assert(sizeof(soft::Ring<soft::ReceivedByte, 64U>) <= 132U);
}
}
int main() {
  controllerOwnership(); timingAndWrap(); completeFrame(); allBytes(); malformedFrames();
  boundedQueues(); noDynamicStateGrowth();
  puts("ATmega D6/D7 controller software UART: 7 focused scenarios PASSED");
}
