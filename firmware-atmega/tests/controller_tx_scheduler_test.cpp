#include "controller_tx_scheduler.h"
#include "physical_workflow.h"
#include "rtc_link.h"
#include "sd_card.h"

#include <assert.h>
#include <stdio.h>
#include <string>
#include <string.h>

namespace {
struct Card {
  dental_atmega::storage::State current = dental_atmega::storage::State::kUnavailable;
  dental_atmega::storage::Diagnostic diag;
  dental_atmega::storage::ReadTrace trace;
  uint16_t offset = 0U;
  unsigned initializeCount = 0U;
  bool initialize() { ++initializeCount; current = dental_atmega::storage::State::kReady; return true; }
  dental_atmega::storage::State state() const { return current; }
  bool sync() { return true; }
  bool beginRead(uint32_t sector) { offset = 0U; return sector == 0x1234ABCDUL; }
  bool readChunk(uint8_t* data, uint8_t capacity, uint8_t& length, bool& complete) {
    length = static_cast<uint8_t>((512U - offset) < capacity ? 512U - offset : capacity);
    memset(data, 0xA5, length);
    offset = static_cast<uint16_t>(offset + length);
    complete = offset == 512U;
    return true;
  }
  bool beginWrite(uint32_t) { return true; }
  bool writeChunk(const uint8_t*, uint8_t, bool& complete) { complete = true; return true; }
  void abort() {}
  const dental_atmega::storage::Diagnostic& diagnostic() const { return diag; }
  const dental_atmega::storage::ReadTrace& readTrace() const { return trace; }
};

struct Rtc {
  dental_link::rtc::State state() const { return dental_link::rtc::State::kReady; }
  dental_link::rtc::Reason reason() const { return dental_link::rtc::Reason::kNone; }
  bool idle() const { return true; }
  uint16_t readSequence() const { return 0U; }
  uint16_t syncSequence() const { return 0U; }
  bool lastReadSucceeded() const { return true; }
  bool requestRead() { return true; }
  bool requestSync(const dental_link::rtc::DateTime&) { return true; }
  dental_link::rtc::DateTime time() const { return {2026U, 9U, 24U, 12U, 0U, 0U}; }
};

struct Tx {
  std::string output;
  unsigned deferred = 0U;
  bool tryWrite(uint8_t byte) {
    if (deferred != 0U) { --deferred; return false; }
    output += static_cast<char>(byte);
    return true;
  }
  void resetQueueMetrics() {}
  uint8_t queueHighWater() const { return 1U; }
};

struct Harness {
  Card card;
  dental_atmega::storage::Link<Card> storage{card};
  Rtc rtc;
  dental_atmega::RtcLink rtcLink;
  dental_atmega::PhysicalWorkflow scanner;
  dental_atmega::PingClient ping;
  dental_atmega::ControllerTxScheduler scheduler;
  Tx tx;
  uint32_t now = 0U;

  void receive(const char* line) {
    for (; *line; ++line) {
      const uint8_t byte = static_cast<uint8_t>(*line);
      scanner.modeResponse(now, ping.receive(now, byte));
      rtcLink.receive(byte, false, rtc);
      storage.receive(byte, false);
    }
  }
  void step() {
    scheduler.service(now, storage, rtcLink, scanner, ping, rtc, tx);
    ++now;
  }
  void until(const char* suffix, unsigned maximum = 4000U) {
    for (unsigned i = 0U; i < maximum && tx.output.find(suffix) == std::string::npos; ++i)
      step();
    assert(tx.output.find(suffix) != std::string::npos);
  }
};

void bootRtcThenStorage() {
  Harness h;
  assert(h.scheduler.owner() == dental_atmega::ControllerTxScheduler::Owner::kNone);
  h.receive("RTC_STATUS?\n");
  h.until("RTC_STATUS:ready:none\n");
  assert(h.card.initializeCount == 0U);
  h.receive("SD:STATUS\n");
  h.until("SD:REINIT_READY\n");
  assert(h.card.initializeCount == 1U);
  assert(h.tx.output.find("RTC_STATUS:ready:none\n") <
         h.tx.output.find("SD:REINIT_READY\n"));
}

void sectorDoesNotOwnIdleGapsOrBlockRx() {
  Harness h;
  h.card.initialize();
  h.receive("SD:R:1234ABCD\n");
  // First SD:DATA line begins; the RTC request arrives while that frame drains.
  for (unsigned i = 0U; i < 8U; ++i) h.step();
  assert(h.storage.transmitting() && h.storage.outputFrameActive());
  h.receive("RTC_STATUS?\n");
  h.until("RTC_STATUS:ready:none\n");
  h.until("SD:OK\n", 10000U);
  const std::string& out = h.tx.output;
  const size_t rtc = out.find("RTC_STATUS:ready:none\n");
  const size_t firstDataEnd = out.find("\n", out.find("SD:DATA:"));
  const size_t sdOk = out.find("SD:OK\n");
  assert(firstDataEnd < rtc && rtc < sdOk);
  assert(out.find("SD:DATA:") != std::string::npos);
  assert(h.scheduler.owner() == dental_atmega::ControllerTxScheduler::Owner::kNone ||
         !h.storage.outputFrameActive());
}

void buttonAckAfterStorage() {
  Harness h;
  h.card.initialize();
  h.receive("SD:STATUS\n"); h.until("SD:READY\n");
  h.scanner.buttons(h.now, false, false);
  h.step();
  h.scanner.buttons(h.now, false, false);
  h.scanner.buttons(h.now, true, false);
  h.now += 51U;
  h.scanner.buttons(h.now, true, false);
  assert(h.scanner.state() == dental_atmega::PhysicalState::kWaitingRestockScan);
  h.until("BTN:RESTOCK\n");
  assert(!h.scanner.modeAcknowledged());
  h.receive("BTN:OK:RESTOCK\n");
  assert(h.scanner.modeAcknowledged());
  const char* barcode = "000123\n";
  for (; *barcode; ++barcode) h.scanner.receive(h.now, *barcode);
  h.until("SCAN:000123\n");
  assert(h.tx.output.find("SD:READY\n") < h.tx.output.find("BTN:RESTOCK\n"));
}
}  // namespace

int main() {
  bootRtcThenStorage();
  sectorDoesNotOwnIdleGapsOrBlockRx();
  buttonAckAfterStorage();
  puts("ATmega controller TX boot/sector/button integration: 3 scenarios PASSED");
}
