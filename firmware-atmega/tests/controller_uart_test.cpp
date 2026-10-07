#include "controller_uart_config.h"
#include "hardware_config.h"
#include "software_uart.h"
#include "ping_client.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
namespace cfg = dental_atmega::controller_uart;
namespace soft = dental_atmega::software_uart;

void baudAndPins() {
  static_assert(F_CPU == 16000000UL, "host test must model the Uno clock");
  assert(cfg::kCpuHz == F_CPU && cfg::kBaud == 9600UL);
  assert(cfg::kRxPortBit == 6U && cfg::kTxPortBit == 7U);
  assert(dental_atmega::hardware::kControllerMask == 0xC0U);
  assert(cfg::configuredDdr(0x00U) == 0x80U);
  assert(cfg::configuredDdr(0xFFU) == 0xBFU);
  assert(cfg::configuredPort(0x00U) == 0xC0U);
  assert(cfg::configuredPort(0xFFU) == 0xFFU);
}

void boundedBackpressure() {
  soft::Ring<uint8_t, cfg::kQueueStorage> queue;
  for (uint8_t i = 0U; i < cfg::kQueueUsable; ++i) assert(queue.push(i));
  assert(!queue.push(0xFFU));
  for (uint8_t i = 0U; i < cfg::kQueueUsable; ++i) {
    uint8_t byte = 0U;
    assert(queue.pop(byte) && byte == i);
  }
}

void receiveErrorMetadata() {
  soft::Ring<soft::ReceivedByte> queue;
  assert(queue.push({'P', false}));
  assert(queue.push({'X', true}));
  soft::ReceivedByte byte;
  assert(queue.pop(byte) && byte.byte == 'P' && !byte.error);
  assert(queue.pop(byte) && byte.byte == 'X' && byte.error);
}

void unchangedPingPongProtocol() {
  struct Writer {
    char data[6] = {};
    uint8_t length = 0U;
    bool tryWrite(uint8_t byte) {
      if (length == 5U) return false;
      data[length++] = static_cast<char>(byte);
      return true;
    }
  } writer;
  dental_atmega::PingClient client;
  for (uint8_t i = 0U; i < 5U; ++i) client.service(2000UL, writer);
  assert(memcmp(writer.data, "PING\n", 5U) == 0);
  for (const char* p = "PONG\n"; *p; ++p) client.receive(2001UL, *p);
  assert(client.verifiedCount() == 1U);
}

void scannerPinsUnaffected() {
  assert(dental_atmega::hardware::kScannerMask == 0x03U);
  for (unsigned initial = 0U; initial < 256U; ++initial) {
    assert((cfg::configuredDdr(static_cast<uint8_t>(initial)) & 0x03U) ==
           (initial & 0x03U));
    assert((cfg::configuredPort(static_cast<uint8_t>(initial)) & 0x03U) ==
           (initial & 0x03U));
  }
}
}

int main() {
  baudAndPins(); boundedBackpressure(); receiveErrorMetadata();
  unchangedPingPongProtocol(); scannerPinsUnaffected();
  puts("ATmega D6/D7 controller transport: 5 focused scenarios PASSED");
}
