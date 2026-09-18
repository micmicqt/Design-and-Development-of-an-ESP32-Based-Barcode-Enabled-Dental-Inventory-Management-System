#include "scanner_capture.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
namespace {
using dental_atmega::ScannerCapture;
using dental_atmega::ScannerTransport;
using dental_atmega::ScanOutcome;
struct Writer {
  uint8_t bytes[512] = {}; unsigned size = 0U; bool ready = true;
  bool tryWrite(uint8_t b) {
    if (!ready) return false;
    assert(size < sizeof(bytes)); bytes[size++] = b; return true;
  }
};
ScanOutcome feed(ScannerCapture& c, const char* text, uint32_t now = 1UL) {
  ScanOutcome result = ScanOutcome::kNone;
  for (; *text; ++text) result = c.receive(now, *text);
  return result;
}
void numeric() { ScannerCapture c; assert(feed(c, "4806016001569\n") == ScanOutcome::kBarcode); assert(strcmp(c.barcode(), "4806016001569") == 0); }
void zeroes() { ScannerCapture c; assert(feed(c, "0012345678905\n") == ScanOutcome::kBarcode); assert(strcmp(c.barcode(), "0012345678905") == 0); }
void cr() { ScannerCapture c; assert(feed(c, "123\r") == ScanOutcome::kBarcode); }
void lf() { ScannerCapture c; assert(feed(c, "123\n") == ScanOutcome::kBarcode); }
void crlf() {
  ScannerCapture c; unsigned scans = 0U;
  for (const char* p = "123\r\n"; *p; ++p) if (c.receive(1UL, *p) == ScanOutcome::kBarcode) ++scans;
  assert(scans == 1U);
}
void bounds() {
  ScannerCapture c;
  for (unsigned i = 0U; i < 64U; ++i) c.receive(1UL, '0');
  assert(c.receive(1UL, '\n') == ScanOutcome::kBarcode && strlen(c.barcode()) == 64U);
  for (unsigned i = 0U; i < 4096U; ++i) c.receive(2UL, '9');
  assert(c.receive(2UL, '\r') == ScanOutcome::kRejected);
  assert(feed(c, "12\n", 3UL) == ScanOutcome::kBarcode);
}
void malformed() {
  ScannerCapture c; feed(c, "12"); c.receive(1UL, 0U);
  assert(feed(c, "34\n") == ScanOutcome::kRejected);
  assert(feed(c, "   \n") == ScanOutcome::kRejected);
  assert(feed(c, " 001 A \n") == ScanOutcome::kBarcode);
  assert(strcmp(c.barcode(), " 001 A ") == 0);
}
void repeated() {
  ScannerCapture c; for (unsigned i = 0U; i < 100U; ++i) {
    assert(feed(c, "00123\n") == ScanOutcome::kBarcode); assert(strcmp(c.barcode(), "00123") == 0);
  }
}
void errors() {
  ScannerCapture c; feed(c, "12"); c.receiveError();
  assert(feed(c, "34\n") == ScanOutcome::kRejected);
  const uint32_t now = UINT32_MAX - 10UL;
  feed(c, "12", now); c.service(static_cast<uint32_t>(now + 1000UL));
  assert(c.receive(static_cast<uint32_t>(now + 1001UL), '\n') == ScanOutcome::kRejected);
  assert(feed(c, "00123\n") == ScanOutcome::kBarcode);
}
void submit(ScannerTransport& t, const char* text) { for (; *text; ++text) t.receive(1UL, *text); }
void flush(ScannerTransport& t, dental_atmega::PingClient& ping, Writer& w, uint32_t now = 2UL) {
  for (unsigned i = 0U; i < 100U; ++i) t.service(now, ping, w);
}
void encoding() {
  ScannerTransport t; dental_atmega::PingClient ping; Writer w;
  submit(t, "0012345678905\r\n"); flush(t, ping, w);
  const char expected[] = "\nSCAN:0012345678905\n";
  assert(w.size == sizeof(expected) - 1U && memcmp(w.bytes, expected, w.size) == 0 && !t.active());
}
void backpressure() {
  ScannerTransport t; dental_atmega::PingClient ping; Writer w; w.ready = false;
  submit(t, "123\n"); submit(t, "456\n"); flush(t, ping, w);
  assert(t.active() && t.droppedCount() == 1U && w.size == 0U);
  w.ready = true; flush(t, ping, w);
  assert(w.size == 10U && memcmp(w.bytes, "\nSCAN:123\n", 10U) == 0);
}
void arbitration() {
  ScannerTransport t; dental_atmega::PingClient ping; Writer w;
  ping.service(2000UL, w); submit(t, "00123\n"); flush(t, ping, w, 2001UL);
  const char expected[] = "PING\n\nSCAN:00123\n";
  assert(w.size == sizeof(expected) - 1U && memcmp(w.bytes, expected, w.size) == 0);
  for (const char* p = "PONG\n"; *p; ++p) ping.receive(2002UL, *p);
  assert(ping.verifiedCount() == 1U);
}
void incompleteTx() {
  ScannerTransport t; dental_atmega::PingClient ping; Writer w;
  submit(t, "123456\n"); for (unsigned i = 0U; i < 8U; ++i) t.service(2UL, ping, w);
  w.ready = false; t.service(1002UL, ping, w); assert(t.active());
  w.ready = true; t.service(1003UL, ping, w); t.service(1003UL, ping, w);
  assert(!t.active() && t.droppedCount() == 1U);
  dental_link::LineParser parser; unsigned scans = 0U;
  for (unsigned i = 0U; i < w.size; ++i) if (parser.receive(w.bytes[i]) == dental_link::Frame::kScan) ++scans;
  assert(scans == 0U); // A truncated barcode must never be accepted.
  submit(t, "00123\n"); unsigned prior = w.size; flush(t, ping, w);
  for (unsigned i = prior; i < w.size; ++i) if (parser.receive(w.bytes[i]) == dental_link::Frame::kScan) ++scans;
  assert(scans == 1U);
}
}
int main() {
  numeric(); zeroes(); cr(); lf(); crlf(); bounds(); malformed(); repeated(); errors();
  encoding(); backpressure(); arbitration(); incompleteTx();
  puts("ATmega scanner capture/transport: 13 focused scenarios PASSED");
}
