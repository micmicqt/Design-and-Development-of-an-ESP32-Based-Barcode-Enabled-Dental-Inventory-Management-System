#include "rtc_link.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
struct Writer {
  char bytes[256] = {}; uint16_t size = 0U; bool ready = true;
  bool tryWrite(uint8_t byte) {
    if (!ready) return false;
    assert(size < sizeof(bytes)); bytes[size++] = static_cast<char>(byte); return true;
  }
  void clear() { memset(bytes, 0, sizeof(bytes)); size = 0U; }
};
struct Rtc {
  dental_link::rtc::State currentState = dental_link::rtc::State::kReady;
  dental_link::rtc::Reason currentReason = dental_link::rtc::Reason::kNone;
  dental_link::rtc::DateTime currentTime = {2026U, 9U, 19U, 12U, 34U, 56U};
  uint16_t reads = 0U, syncs = 0U; bool readOk = true, syncOk = true, idleValue = true;
  dental_link::rtc::State state() const { return currentState; }
  dental_link::rtc::Reason reason() const { return currentReason; }
  const dental_link::rtc::DateTime& time() const { return currentTime; }
  bool idle() const { return idleValue; }
  bool requestRead() { idleValue = false; return currentState == dental_link::rtc::State::kReady; }
  bool requestSync(const dental_link::rtc::DateTime& value) {
    if (currentState == dental_link::rtc::State::kUnavailable) return false;
    currentTime = value; idleValue = false; return true;
  }
  uint16_t readSequence() const { return reads; }
  uint16_t syncSequence() const { return syncs; }
  bool lastReadSucceeded() const { return readOk; }
  bool lastSyncSucceeded() const { return syncOk; }
  void finishRead() { ++reads; idleValue = true; }
  void finishSync() {
    ++syncs; idleValue = true;
    currentState = syncOk ? dental_link::rtc::State::kReady : dental_link::rtc::State::kNeedsSync;
    currentReason = syncOk ? dental_link::rtc::Reason::kNone : dental_link::rtc::Reason::kVerificationFailed;
  }
};
void feed(dental_atmega::RtcLink& link, Rtc& rtc, const char* text) {
  for (; *text; ++text) link.receive(static_cast<uint8_t>(*text), false, rtc);
}
void drain(dental_atmega::RtcLink& link, Rtc& rtc, Writer& writer) {
  for (unsigned i = 0U; i < 200U && link.pending(); ++i) link.service(rtc, writer, true);
}
void status() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  feed(link, rtc, "RTC_STATUS?\n"); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_STATUS:ready:none\n") == 0);
}
void timeRead() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  feed(link, rtc, "RTC_TIME?\n"); assert(writer.size == 0U);
  rtc.finishRead(); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_TIME:2026-09-19 12:34:56\n") == 0);
  assert(rtc.syncs == 0U); // Offline time read never requires desktop sync.
}
void timeReadJoinsPeriodicRefresh() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  rtc.idleValue = false; // One-second LCD refresh already reading DS3231.
  feed(link, rtc, "RTC_TIME?\n"); assert(writer.size == 0U && link.pending());
  rtc.finishRead(); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_TIME:2026-09-19 12:34:56\n") == 0);
}
void sync() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  rtc.currentState = dental_link::rtc::State::kNeedsSync;
  rtc.currentReason = dental_link::rtc::Reason::kLostPower;
  feed(link, rtc, "RTC_SYNC:2027-01-02 03:04:05\n");
  rtc.finishSync(); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_SYNCED:ready:none\n") == 0);
  assert(rtc.currentTime.year == 2027U && rtc.currentTime.second == 5U);
}
void malformedSync() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  rtc.currentState = dental_link::rtc::State::kNeedsSync;
  rtc.currentReason = dental_link::rtc::Reason::kInvalidTime;
  feed(link, rtc, "RTC_SYNC:2025-02-29 00:00:00\n"); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_SYNCED:needs_sync:invalid_time\n") == 0);
  assert(rtc.syncs == 0U);
}
void incompleteAndUnrelated() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  feed(link, rtc, "RTC_SYNC:2026-09"); drain(link, rtc, writer);
  assert(writer.size == 0U);
  feed(link, rtc, "\n"); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_SYNCED:needs_sync:invalid_time\n") == 0);
  writer.clear();
  feed(link, rtc, "PING\nRESTOCK:123\nCHECKOUT:123\nSCAN:123\n");
  drain(link, rtc, writer);
  assert(writer.size == 0U &&
         rtc.currentState == dental_link::rtc::State::kReady &&
         rtc.syncs == 0U);
}
void unavailable() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer;
  rtc.currentState = dental_link::rtc::State::kUnavailable;
  rtc.currentReason = dental_link::rtc::Reason::kCommunicationFailure;
  feed(link, rtc, "RTC_STATUS?\n"); drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_STATUS:unavailable:communication_failure\n") == 0);
}
void reconnectAndStatusQueriesPreserveReady() {
  Rtc rtc;
  const uint32_t retained = dental_link::rtc::secondsSince2000(rtc.currentTime);
  for (uint8_t reconnect = 0U; reconnect < 3U; ++reconnect) {
    dental_atmega::RtcLink link; Writer writer;
    feed(link, rtc, "RTC_STATUS?\n"); drain(link, rtc, writer);
    assert(strcmp(writer.bytes, "RTC_STATUS:ready:none\n") == 0);
    assert(rtc.currentState == dental_link::rtc::State::kReady &&
           rtc.currentReason == dental_link::rtc::Reason::kNone &&
           rtc.syncs == 0U &&
           dental_link::rtc::secondsSince2000(rtc.currentTime) == retained);
  }
}
void boundedTx() {
  dental_atmega::RtcLink link; Rtc rtc; Writer writer; writer.ready = false;
  feed(link, rtc, "RTC_STATUS?\n"); drain(link, rtc, writer);
  assert(writer.size == 0U && link.pending());
  writer.ready = true; drain(link, rtc, writer);
  assert(strcmp(writer.bytes, "RTC_STATUS:ready:none\n") == 0);
}
}
int main() {
  status(); timeRead(); timeReadJoinsPeriodicRefresh(); sync(); malformedSync();
  incompleteAndUnrelated(); unavailable(); reconnectAndStatusQueriesPreserveReady();
  boundedTx();
  puts("ATmega RTC controller link: 9 focused scenarios PASSED");
}
