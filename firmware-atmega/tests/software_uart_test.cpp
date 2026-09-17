#include "software_uart.h"
#include "hardware_config.h"
#include "ping_client.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
namespace soft = dental_atmega::software_uart;
soft::SampleResult receiveByte(soft::Receiver& rx, uint8_t byte, bool stop = true) {
  rx.begin();
  assert(rx.sample(false) == soft::SampleResult::kMore);
  for (uint8_t bit = 0U; bit < 8U; ++bit)
    assert(rx.sample((byte & (1U << bit)) != 0U) == soft::SampleResult::kMore);
  return rx.sample(stop);
}
void pins() {
  assert(soft::kRxPortBit == 6U && soft::kTxPortBit == 7U);
  const uint8_t linkMask = (1U << soft::kRxPortBit) | (1U << soft::kTxPortBit);
  assert((linkMask & dental_atmega::hardware::kSmallMask) == 0U);
  assert((linkMask & 3U) == 0U); // D0/D1 reserved for hardware-UART GM65.
}
void timing() {
  assert(soft::kBitTicks == 208U && soft::kHalfBitTicks == 104U);
  assert(soft::kBitTicks * 8UL == 1664UL); // 104 us at 16 MHz.
  const uint16_t previous = 65500U;
  const uint16_t next = static_cast<uint16_t>(previous + soft::kBitTicks);
  assert(static_cast<uint16_t>(next - previous) == soft::kBitTicks);
}
void allByteValues() {
  for (unsigned byte = 0U; byte < 256U; ++byte) {
    soft::Receiver rx; soft::Sender tx;
    tx.begin(static_cast<uint8_t>(byte)); rx.begin();
    assert(rx.sample(false) == soft::SampleResult::kMore);
    for (unsigned bit = 0U; bit < 8U; ++bit)
      assert(rx.sample(tx.tick()) == soft::SampleResult::kMore);
    assert(rx.sample(tx.tick()) == soft::SampleResult::kByte);
    assert(rx.byte() == byte && !rx.active() && tx.active());
    assert(tx.tick() && !tx.active()); // Entire stop bit completes.
  }
}
void falseStart() {
  soft::Receiver rx; rx.begin();
  assert(rx.sample(true) == soft::SampleResult::kFalseStart && !rx.active());
  assert(receiveByte(rx, 'P') == soft::SampleResult::kByte && rx.byte() == 'P');
}
void framing() {
  soft::Receiver rx;
  assert(receiveByte(rx, 'X', false) == soft::SampleResult::kFramingError);
  assert(!rx.active());
  assert(receiveByte(rx, '\n') == soft::SampleResult::kByte);
}
void boundedQueue() {
  soft::Ring<uint8_t> queue;
  uint8_t byte = 0U; assert(!queue.pop(byte));
  for (uint8_t i = 0U; i < 15U; ++i) assert(queue.push(i));
  assert(!queue.push(99U));
  for (uint8_t i = 0U; i < 15U; ++i) { assert(queue.pop(byte)); assert(byte == i); }
  assert(!queue.pop(byte));
  for (unsigned i = 0U; i < 4096U; ++i) {
    assert(queue.push(static_cast<uint8_t>(i)) && queue.pop(byte));
    assert(byte == static_cast<uint8_t>(i));
  }
}
void errorQuarantine() {
  soft::Ring<soft::ReceivedByte> queue;
  assert(queue.push({'X', true}));
  soft::ReceivedByte received;
  assert(queue.pop(received) && received.error && received.byte == 'X');
  dental_atmega::PingClient client;
  struct Writer { bool tryWrite(uint8_t) { return true; } } writer;
  for (unsigned i = 0U; i < 5U; ++i) client.service(2000UL, writer);
  client.receiveError();
  for (const char* p = "PONG\n"; *p; ++p) client.receive(2001UL, *p);
  assert(client.verifiedCount() == 0U);
  for (const char* p = "PONG\n"; *p; ++p) client.receive(2002UL, *p);
  assert(client.verifiedCount() == 1U);
}
void pingPongPath() {
  struct Wire {
    char bytes[6] = {}; unsigned size = 0U;
    bool tryWrite(uint8_t byte) {
      soft::Sender tx; soft::Receiver rx;
      tx.begin(byte); rx.begin(); rx.sample(false);
      for (unsigned bit = 0U; bit < 8U; ++bit) rx.sample(tx.tick());
      assert(rx.sample(tx.tick()) == soft::SampleResult::kByte);
      tx.tick(); assert(!tx.active());
      assert(size < 5U); bytes[size++] = static_cast<char>(rx.byte());
      return true;
    }
  } wire;
  dental_atmega::PingClient client;
  for (unsigned i = 0U; i < 5U; ++i) client.service(2000UL, wire);
  assert(strcmp(wire.bytes, "PING\n") == 0);
  soft::Receiver rx;
  for (const char* p = "PONG\n"; *p; ++p) {
    assert(receiveByte(rx, static_cast<uint8_t>(*p)) == soft::SampleResult::kByte);
    client.receive(2001UL, rx.byte());
  }
  assert(client.verifiedCount() == 1U);
}
}
int main() {
  pins(); timing(); allByteValues(); falseStart(); framing(); boundedQueue();
  errorQuarantine(); pingPongPath();
  puts("ATmega D6/D7 software UART: 8 focused scenarios PASSED");
}
