#include "ping_client.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
struct Writer {
  char bytes[64] = {};
  unsigned size = 0U;
  bool ready = true;
  bool tryWrite(uint8_t byte) {
    if (!ready) return false;
    assert(size < sizeof(bytes));
    bytes[size++] = static_cast<char>(byte);
    return true;
  }
};
using dental_atmega::PingClient;
using dental_atmega::LinkOutcome;
using dental_atmega::LinkState;
void send(PingClient& c, Writer& w, uint32_t now) {
  for (unsigned i = 0U; i < 5U; ++i) c.service(now, w);
  assert(c.state() == LinkState::kWaiting);
}
void receive(PingClient& c, const char* text, uint32_t now) {
  for (; *text; ++text) c.receive(now, static_cast<uint8_t>(*text));
}
void encoding() {
  PingClient c; Writer w;
  c.service(1999UL, w); assert(w.size == 0U);
  send(c, w, 2000UL);
  assert(w.size == 5U && memcmp(w.bytes, "PING\n", 5U) == 0);
}
void recognition() {
  PingClient c; Writer w; send(c, w, 2000UL);
  receive(c, "PONG\n", 2001UL);
  assert(c.outcome() == LinkOutcome::kVerified && c.verifiedCount() == 1U);
  receive(c, "PONG\n", 2002UL); assert(c.verifiedCount() == 1U);
}
void malformed() {
  PingClient c; Writer w; send(c, w, 2000UL);
  receive(c, "pong\nPING\nPONG extra\nPONG\rX\n", 2001UL);
  assert(c.verifiedCount() == 0U);
  receive(c, "PONG\r\n", 2002UL); assert(c.verifiedCount() == 1U);
}
void bounded() {
  PingClient c; Writer w; send(c, w, 2000UL);
  for (unsigned i = 0; i < 4096U; ++i) c.receive(2001UL, 'X');
  receive(c, "PONG\n", 2001UL); assert(c.verifiedCount() == 0U);
  c.receive(2001UL, 0U); receive(c, "PONG\n", 2001UL);
  assert(c.verifiedCount() == 0U);
  receive(c, "PONG\n", 2002UL); assert(c.verifiedCount() == 1U);
}
void timeoutRetry() {
  PingClient c; Writer w; send(c, w, 2000UL);
  receive(c, "PO", 2999UL); c.service(3000UL, w);
  assert(c.timeoutCount() == 1U && c.outcome() == LinkOutcome::kTimedOut);
  receive(c, "NG\nPONG\n", 3001UL); assert(c.verifiedCount() == 0U);
  c.service(4999UL, w); assert(w.size == 5U);
  send(c, w, 5000UL); receive(c, "PONG\n", 5001UL);
  assert(c.verifiedCount() == 1U && c.timeoutCount() == 1U);
}
void stuckTx() {
  PingClient c; Writer w; w.ready = false;
  c.service(2000UL, w); c.service(3000UL, w);
  assert(w.size == 0U && c.outcome() == LinkOutcome::kTimedOut);
}
void wrap() {
  const uint32_t start = UINT32_MAX - 999UL;
  PingClient c(start); Writer w;
  send(c, w, static_cast<uint32_t>(start + 2000UL));
  c.service(static_cast<uint32_t>(start + 3000UL), w);
  assert(c.timeoutCount() == 1U && c.state() == LinkState::kIdle);
}
void uartError() {
  PingClient c; Writer w; send(c, w, 2000UL);
  receive(c, "PO", 2001UL); c.receiveError(); receive(c, "NG\n", 2001UL);
  assert(c.verifiedCount() == 0U);
  receive(c, "PONG\n", 2002UL); assert(c.verifiedCount() == 1U);
}
}
int main() {
  encoding(); recognition(); malformed(); bounded(); timeoutRetry();
  stuckTx(); wrap(); uartError();
  puts("ATmega UART link: 8 focused scenarios PASSED");
}
