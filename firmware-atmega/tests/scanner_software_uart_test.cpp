#include "software_uart.h"
#include "hardware_config.h"
#include <assert.h>
#include <stdio.h>
#include <vector>

namespace {
namespace soft = dental_atmega::software_uart;
void ownership() {
  assert(soft::kScannerRxPortBit == 0U && soft::kScannerTxPortBit == 1U);
  assert(dental_atmega::hardware::kScannerRxBit == 0U);
  assert(dental_atmega::hardware::kScannerTxBit == 1U);
  assert((dental_atmega::hardware::kScannerMask & dental_atmega::hardware::kTwiMask) == 0U);
  assert(soft::kRxPortBit == 6U && soft::kTxPortBit == 7U);
  assert(dental_atmega::hardware::scannerDdr(0xFFU) == 0xFEU);
  assert(dental_atmega::hardware::scannerDdr(0x00U) == 0x02U);
  assert(dental_atmega::hardware::scannerPort(0x00U) == 0x03U);
  assert((dental_atmega::hardware::scannerDdr(0xF0U) & 0xF0U) == 0xF0U);
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
bool lineFor(uint8_t byte, unsigned phase) {
  if (phase == 0U) return false;
  if (phase <= 8U) return (byte & (1U << (phase - 1U))) != 0U;
  return true;
}
void concurrentReceive() {
  // Independent phases share an earliest-deadline schedule. Both bytes must
  // complete even while their 8N1 windows overlap.
  soft::TimedReceiver controller, scanner;
  controller.begin(0U); scanner.begin(50U);
  unsigned controllerPhase = 0U, scannerPhase = 0U;
  for (uint16_t now = 0U; now < 2500U && (controller.active() || scanner.active()); ++now) {
    if (controller.due(now)) {
      const auto result = controller.sample(lineFor('P', controllerPhase++));
      if (result == soft::SampleResult::kByte) assert(controller.byte() == 'P');
    }
    if (scanner.due(now)) {
      const auto result = scanner.sample(lineFor('0', scannerPhase++));
      if (result == soft::SampleResult::kByte) assert(scanner.byte() == '0');
    }
  }
  assert(!controller.active() && !scanner.active());
}
void concurrentTransmit() {
  soft::TimedSender controller, scanner;
  controller.begin('G', 0U); scanner.begin('S', 73U);
  unsigned controllerTicks = 0U, scannerTicks = 0U;
  for (uint16_t now = 0U; now < 2600U && (controller.active() || scanner.active()); ++now) {
    if (controller.due(now)) { controller.tick(); ++controllerTicks; }
    if (scanner.due(now)) { scanner.tick(); ++scannerTicks; }
  }
  assert(controllerTicks == 10U && scannerTicks == 10U);
}
void rxWhileOtherTx() {
  soft::TimedSender scannerTx; soft::TimedReceiver controllerRx;
  scannerTx.begin(0x55U, 0U); controllerRx.begin(41U);
  unsigned rxPhase = 0U, txTicks = 0U;
  for (uint16_t now = 0U; now < 2500U && (scannerTx.active() || controllerRx.active()); ++now) {
    if (scannerTx.due(now)) { scannerTx.tick(); ++txTicks; }
    if (controllerRx.due(now)) {
      const auto result = controllerRx.sample(lineFor('\n', rxPhase++));
      if (result == soft::SampleResult::kByte) assert(controllerRx.byte() == '\n');
    }
  }
  assert(txTicks == 10U && !controllerRx.active());
}
void noDynamicStateGrowth() {
  assert(sizeof(soft::TimedSender) <= 6U);
  assert(sizeof(soft::TimedReceiver) <= 6U);
  assert(sizeof(soft::Ring<soft::ReceivedByte, 64U>) <= 132U);
}
}
int main() {
  ownership(); timingAndWrap(); completeFrame(); allBytes(); malformedFrames();
  boundedQueues(); concurrentReceive(); concurrentTransmit(); rxWhileOtherTx(); noDynamicStateGrowth();
  puts("ATmega A0/A1 scanner software UART: 10 focused scenarios PASSED");
}
