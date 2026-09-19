#include "atmega_link.h"
#include "hardware_config.h"
#include "transaction_event_queue.h"
#include "../../firmware-atmega/include/ping_client.h"
#include "../../firmware-atmega/include/scanner_capture.h"
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
using dental::controller_link::PingResponder;
void feed(PingResponder& r, Writer& w, const char* text) {
  for (; *text; ++text) r.receive(static_cast<uint8_t>(*text), w);
  for (unsigned i = 0; i < 5U; ++i) r.service(w);
}
void pingPong() {
  PingResponder r; Writer w; feed(r, w, "PING\n");
  assert(w.size == 5U && memcmp(w.bytes, "PONG\n", 5U) == 0);
}
void malformed() {
  PingResponder r; Writer w;
  feed(r, w, "RESTOCK\nCHECKOUT\nPONG\nping\nPING X\nPING\rX\n");
  r.receive(0U, w); feed(r, w, "PING\n"); assert(w.size == 0U);
  feed(r, w, "PING\r\n"); assert(w.size == 5U);
}
void oversized() {
  PingResponder r; Writer w;
  for (unsigned i = 0; i < 4096U; ++i) r.receive('X', w);
  feed(r, w, "PING\n"); assert(w.size == 0U);
  feed(r, w, "PING\n"); assert(w.size == 5U);
}
void busyTx() {
  PingResponder r; Writer w; w.ready = false;
  feed(r, w, "PING\nPING\n"); assert(w.size == 0U);
  w.ready = true;
  for (unsigned i = 0; i < 100U; ++i) r.service(w);
  assert(w.size == 5U && memcmp(w.bytes, "PONG\n", 5U) == 0);
}
void fragmentedAndRepeated() {
  PingResponder r; Writer w; feed(r, w, "PI"); assert(w.size == 0U);
  feed(r, w, "NG\n"); feed(r, w, "PING\nPING\n");
  assert(w.size == 15U && memcmp(w.bytes, "PONG\nPONG\nPONG\n", 15U) == 0);
}
void noTransactionSideEffects() {
  dental::events::PendingEventQueue queue;
  PingResponder r; Writer w; feed(r, w, "RESTOCK\nCHECKOUT\nPING\n");
  assert(queue.size() == 0U && queue.oldest() == nullptr && w.size == 5U);
  // Responder only accepts a byte transmitter. No storage, RTC, offline
  // journal, HTTP or inventory callback exists in this transport interface.
}
void exchange() {
  dental_atmega::PingClient c; PingResponder r; Writer request; Writer response;
  for (unsigned i = 0; i < 5U; ++i) c.service(2000UL, request);
  assert(request.size == 5U);
  for (unsigned i = 0; i < request.size; ++i) r.receive(request.bytes[i], response);
  for (unsigned i = 0; i < 5U; ++i) r.service(response);
  for (unsigned i = 0; i < response.size; ++i) c.receive(2001UL, response.bytes[i]);
  assert(c.verifiedCount() == 1U);
}
void confirmedPins() {
  assert(dental::hardware::kAtmegaLinkEnabled);
  assert(dental::hardware::kAtmegaLinkRxGpio == 16);
  assert(dental::hardware::kAtmegaLinkTxGpio == 17);
  assert(dental::hardware::isControllerLinkGpio(16));
  assert(dental::hardware::isControllerLinkGpio(17));
  assert(!dental::hardware::isExistingPeripheralGpio(16));
  assert(!dental::hardware::isExistingPeripheralGpio(17));
  assert(!dental::hardware::kScannerUartEnabled);
  assert(!dental::hardware::kEsp32LcdEnabled);
  assert(dental::hardware::isExistingPeripheralGpio(21));
  assert(dental::hardware::isExistingPeripheralGpio(22));
  assert(!dental::hardware::isControllerLinkGpio(20));
  assert(!dental::hardware::isControllerLinkGpio(24));
  assert(!dental::hardware::isControllerLinkGpio(31));
  assert(!dental::hardware::isControllerLinkGpio(38));
}
}
void scanRecognition() {
  PingResponder r; Writer w; dental_link::Frame result = dental_link::Frame::kNone;
  for (const char* p = "SCAN:4806016001569\n"; *p; ++p) result = r.receive(*p, w);
  assert(result == dental_link::Frame::kScan && strcmp(r.barcode(), "4806016001569") == 0 && w.size == 0U);
}
void scanZeroes() {
  PingResponder r; Writer w; unsigned scans = 0U;
  for (const char* p = "SCAN:0012345678905\r\n"; *p; ++p) if (r.receive(*p, w) == dental_link::Frame::kScan) {
    ++scans; assert(strcmp(r.barcode(), "0012345678905") == 0);
  }
  assert(scans == 1U && w.size == 0U);
}
void badScans() {
  PingResponder r; Writer w; unsigned scans = 0U;
  const char* bad[] = {"SCAN:\n", "SCAN:   \n", "scan:123\n", "SCAN:12\r34\n"};
  for (const char* text : bad) for (; *text; ++text) if (r.receive(*text, w) == dental_link::Frame::kScan) ++scans;
  feed(r, w, "SCAN:123"); r.receive(0U, w); feed(r, w, "456\nSCAN:");
  for (unsigned i = 0U; i < 65U; ++i) r.receive('1', w);
  assert(r.receive('\n', w) == dental_link::Frame::kRejected && scans == 0U);
  feed(r, w, "PING\n"); assert(w.size == 5U);
}
void scanNoSideEffects() {
  dental::events::PendingEventQueue queue; PingResponder r; Writer w;
  for (const char* p = "SCAN:00123\n"; *p; ++p) r.receive(*p, w);
  assert(queue.size() == 0U && queue.oldest() == nullptr && w.size == 0U);
  assert(!dental::hardware::kScannerUartEnabled);
  feed(r, w, "PING\n"); assert(w.size == 5U);
}
void scannerEndToEnd() {
  dental_atmega::ScannerTransport scanner; dental_atmega::PingClient ping;
  Writer wire; Writer response; PingResponder responder;
  for (const char* p = "0012345678905\r\n"; *p; ++p) scanner.receive(1UL, *p);
  for (unsigned i = 0U; i < 30U; ++i) scanner.service(2UL, ping, wire);
  unsigned scans = 0U;
  for (unsigned i = 0U; i < wire.size; ++i) if (responder.receive(wire.bytes[i], response) == dental_link::Frame::kScan) {
    ++scans; assert(strcmp(responder.barcode(), "0012345678905") == 0);
  }
  assert(scans == 1U && response.size == 0U);
}
int main() {
  pingPong(); malformed(); oversized(); busyTx(); fragmentedAndRepeated();
  noTransactionSideEffects(); exchange(); confirmedPins();
  scanRecognition(); scanZeroes(); badScans(); scanNoSideEffects(); scannerEndToEnd();
  puts("ESP32 ATmega responder: 13 focused scenarios PASSED");
}
