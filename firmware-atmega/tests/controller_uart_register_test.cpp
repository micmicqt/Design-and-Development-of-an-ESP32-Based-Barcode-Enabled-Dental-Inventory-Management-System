// Compile the production driver against register fakes; testing only
// TimedSender's ideal bit sequence cannot expose interrupt-flag cancellation.
#include "../src/uart_link.cpp"
#include "controller_tx_scheduler.h"
#include "physical_workflow.h"
#include "rtc_link.h"
#include "sd_card.h"
#include <assert.h>
#include <stdio.h>
#include <string>

namespace {
void reset() {
  controllerSender = soft::TimedSender{};
  controllerTxQueue.clear();
  TIFR1.pending = 0U;
  TIFR1.writes = 0U;
  dental_atmega::uart::initialize();
}

void idleStartArmsTimer() {
  reset();
  TCNT1 = 1000U;
  assert(dental_atmega::uart::tryWrite('S'));
  assert(controllerSender.active());
  assert(OCR1A == 1000U + soft::kBitTicks);
  assert((TIMSK1 & _BV(OCIE1A)) != 0U);
  assert((PORTD & _BV(soft::kTxPortBit)) == 0U);
}

void enqueueMustPreservePendingCompare() {
  reset();
  assert(dental_atmega::uart::tryWrite('S'));
  // The compare becomes pending just before main enqueues the next character.
  TCNT1 = OCR1A;
  TIFR1.pending = _BV(OCF1A);
  const uint16_t deadline = OCR1A;
  const unsigned writes = TIFR1.writes;
  assert(dental_atmega::uart::tryWrite('D'));
  assert(TIFR1.pending == _BV(OCF1A));
  assert(TIFR1.writes == writes && OCR1A == deadline);
  // Once main leaves its atomic section, the pending bit ISR still runs.
  TIFR1.pending = 0U; // Hardware clears the flag upon ISR entry.
  TIMER1_COMPA_vect();
  assert(OCR1A == static_cast<uint16_t>(deadline + soft::kBitTicks));
}

void enqueueMustNotTouchImminentCompare() {
  reset();
  assert(dental_atmega::uart::tryWrite('S'));
  TCNT1 = static_cast<uint16_t>(OCR1A - 1U);
  const uint16_t deadline = OCR1A;
  const unsigned writes = TIFR1.writes;
  assert(dental_atmega::uart::tryWrite('D'));
  assert(TIFR1.writes == writes && OCR1A == deadline);
}

void fullQueuePreservesPendingCompare() {
  reset();
  assert(dental_atmega::uart::tryWrite('S'));
  for (unsigned i = 0U; i < 15U; ++i)
    assert(dental_atmega::uart::tryWrite(static_cast<uint8_t>(i)));
  TCNT1 = OCR1A;
  TIFR1.pending = _BV(OCF1A);
  const unsigned writes = TIFR1.writes;
  assert(!dental_atmega::uart::tryWrite('X'));
  assert(TIFR1.pending == _BV(OCF1A) && TIFR1.writes == writes);
}

struct Card {
  dental_atmega::storage::Diagnostic diag;
  dental_atmega::storage::ReadTrace trace;
  uint16_t offset = 0U;
  bool initialize() { return true; }
  dental_atmega::storage::State state() const { return dental_atmega::storage::State::kReady; }
  bool sync() { return true; }
  bool beginRead(uint32_t) { offset = 0U; return true; }
  bool readChunk(uint8_t* data, uint8_t capacity, uint8_t& count, bool& complete) {
    count = static_cast<uint8_t>(512U - offset < capacity ? 512U - offset : capacity);
    for (uint8_t i = 0U; i < count; ++i) data[i] = static_cast<uint8_t>(offset++);
    complete = offset == 512U;
    return true;
  }
  bool beginWrite(uint32_t) { return false; }
  bool writeChunk(const uint8_t*, uint8_t, bool&) { return false; }
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
  dental_link::rtc::DateTime time() const { return {2026U, 10U, 5U, 12U, 0U, 0U}; }
};

void sectorThroughRealDriverWithRtcAndBackpressure() {
  reset();
  Card card;
  dental_atmega::storage::Link<Card> storage(card);
  dental_atmega::ControllerTxScheduler scheduler;
  dental_atmega::RtcLink rtcLink;
  dental_atmega::PhysicalWorkflow scanner;
  dental_atmega::PingClient ping;
  dental_atmega::uart::Transmitter tx;
  Rtc rtc;
  for (const char* p = "SD:R:00000000\n"; *p; ++p) storage.receive(*p, false);
  std::string wire;
  uint8_t phase = 0U, decoded = 0U;
  bool rtcRequested = false;
  for (unsigned ticks = 0U; ticks < 20000U && wire.find("SD:OK\n") == std::string::npos; ++ticks) {
    if (!rtcRequested && wire.size() >= 5U) {
      for (const char* p = "RTC_STATUS?\n"; *p; ++p) rtcLink.receive(*p, false, rtc);
      rtcRequested = true;
    }
    if (!controllerSender.active()) {
      scheduler.service(ticks / 10U, storage, rtcLink, scanner, ping, rtc, tx);
      continue;
    }
    TCNT1 = OCR1A;
    TIFR1.pending = _BV(OCF1A);
    const uint16_t deadline = OCR1A;
    // Exercise the production scheduler exactly at a pending compare. More
    // calls fill its 15-byte queue and require byte-for-byte retry on full.
    for (unsigned call = 0U; call < 4U; ++call)
      scheduler.service(ticks / 10U, storage, rtcLink, scanner, ping, rtc, tx);
    assert(TIFR1.pending == _BV(OCF1A) && OCR1A == deadline);
    TIFR1.pending = 0U;
    TIMER1_COMPA_vect();
    const bool high = (PORTD & _BV(soft::kTxPortBit)) != 0U;
    if (phase < 8U) {
      if (high) decoded |= static_cast<uint8_t>(1U << phase);
    } else if (phase == 8U) {
      assert(high);
      wire += static_cast<char>(decoded);
    }
    if (++phase == 10U) { phase = 0U; decoded = 0U; }
  }
  assert(wire.find("RTC_STATUS:ready:none\n") != std::string::npos);
  assert(wire.find("SD:OK\n") != std::string::npos);
  assert(storage.streamMetrics().deferred != 0U);
  uint8_t bytes[512] = {};
  dental_link::storage::Parser parser;
  dental_link::storage::SectorAssembler assembler(bytes);
  unsigned ok = 0U;
  for (char byte : wire) {
    const auto frame = parser.receive(static_cast<uint8_t>(byte));
    assert(frame.operation != dental_link::storage::Operation::kRejected);
    if (frame.operation == dental_link::storage::Operation::kData) assert(assembler.accept(frame));
    if (frame.operation == dental_link::storage::Operation::kOk) ++ok;
  }
  assert(assembler.complete() && assembler.chunks() == 22U && ok == 1U);
  for (unsigned i = 0U; i < sizeof(bytes); ++i) assert(bytes[i] == static_cast<uint8_t>(i));
}
}

int main() {
  idleStartArmsTimer();
  enqueueMustPreservePendingCompare();
  enqueueMustNotTouchImminentCompare();
  fullQueuePreservesPendingCompare();
  sectorThroughRealDriverWithRtcAndBackpressure();
  puts("ATmega production UART register regression: 5 scenarios PASSED");
}
