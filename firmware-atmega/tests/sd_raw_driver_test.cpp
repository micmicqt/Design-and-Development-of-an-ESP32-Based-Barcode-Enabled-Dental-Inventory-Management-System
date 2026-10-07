// Exercise the production SPDR/SPIF driver, not a replacement card model.
// Only the AVR registers/card wire responses and clock are substituted.
#include <assert.h>
#include <deque>
#include <map>
#include <array>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "../src/sd_card.cpp"

static uint32_t clockMs = 600U;
namespace dental_atmega { namespace uart { uint32_t milliseconds() { return clockMs; } } }
void sdTestDelay(double milliseconds) { clockMs += static_cast<uint32_t>(milliseconds); }
static std::deque<uint8_t> response;
static std::map<uint32_t, std::array<uint8_t, 512>> sectors;
static uint8_t packet[6];
static unsigned packetLength = 0U, writePosition = 0U, busyPolls = 0U;
static uint32_t requestedSector = 0U;
static bool writing = false, tokenSeen = false, rejectRead = false, invalidToken = false;
static bool stuckBusy = false;

uint8_t sdTestExchange(uint8_t byte) {
  if (PORTB & _BV(2)) {
    packetLength = 0U; response.clear(); writing = tokenSeen = false;
    return 0xFFU;
  }
  if (!response.empty()) {
    const uint8_t value = response.front(); response.pop_front();
    if (value == 0U && tokenSeen) ++busyPolls;
    return value;
  }
  if (writing) {
    if (!tokenSeen) {
      if (byte == 0xFEU) { tokenSeen = true; writePosition = 0U; }
      return 0xFFU;
    }
    if (writePosition < 512U) sectors[requestedSector][writePosition] = byte;
    if (++writePosition == 514U) {
      response.push_back(0x05U);
      for (unsigned i = 0; i < (stuckBusy ? 65000U : 5U); ++i) response.push_back(0U);
      response.push_back(0xFFU);
    }
    return 0xFFU;
  }
  if (packetLength == 0U && (byte & 0xC0U) != 0x40U) return 0xFFU;
  packet[packetLength++] = byte;
  if (packetLength != 6U) return 0xFFU;
  packetLength = 0U;
  requestedSector = (uint32_t(packet[1]) << 24U) | (uint32_t(packet[2]) << 16U) |
                    (uint32_t(packet[3]) << 8U) | packet[4];
  const uint8_t command = packet[0] & 0x3FU;
  if (command == 0U) { assert(packet[5] == 0x95U); response = {1U}; }
  else if (command == 8U) response = {1U, 0U, 0U, 1U, 0xAAU};
  else if (command == 55U) response = {1U};
  else if (command == 41U) response = {0U};
  else if (command == 58U) response = {0U, 0x40U, 0U, 0U, 0U};
  else if (command == 17U) {
    response.push_back(rejectRead ? 0x3FU : 0U);
    if (!rejectRead) {
      response.push_back(invalidToken ? 0x0BU : 0xFEU);
      if (!invalidToken) {
        for (uint8_t value : sectors[requestedSector]) response.push_back(value);
        response.push_back(0xFFU); response.push_back(0xFFU);
      }
    }
  } else if (command == 24U) { response = {0U}; writing = true; }
  else assert(false);
  return 0xFFU;
}

static void readAndCheck(dental_atmega::storage::RawCard& card, uint32_t sector) {
  assert(card.beginRead(sector));
  unsigned offset = 0U;
  bool complete = false;
  while (!complete) {
    uint8_t chunk[24], length;
    assert(card.readChunk(chunk, sizeof(chunk), length, complete));
    for (unsigned i = 0U; i < length; ++i) assert(chunk[i] == sectors[sector][offset++]);
  }
  assert(offset == 512U && (PORTB & _BV(2)));
}
int main() {
  using namespace dental_atmega::storage;
  RawCard card;
  DDRB = 3U; PORTB = 3U;
  assert(card.initialize());
  assert((DDRB & 0x3CU) == 0x2CU && (PORTB & 0x14U) == 4U);
  assert((DDRB & 3U) == 3U && (PORTB & 3U) == 3U);
  assert(SPCR == 0x53U && (SPSR & 1U) == 0U);
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    const uint32_t sector = 34816U + cycle % 6U;
    readAndCheck(card, sector);
    assert(card.beginWrite(sector));
    bool complete = false;
    for (unsigned offset = 0U; offset < 512U;) {
      uint8_t chunk[24]; const uint8_t length = 512U - offset < 24U ? 8U : 24U;
      for (unsigned i = 0U; i < length; ++i) chunk[i] = uint8_t(cycle + offset + i);
      assert(card.writeChunk(chunk, length, complete)); offset += length;
    }
    assert(complete && busyPolls >= 5U && response.empty() && (PORTB & _BV(2)));
    assert(card.sync());
    clockMs += 60000U; // Idle periods cannot change driver ownership/state.
    readAndCheck(card, sector);
  }
  rejectRead = true;
  assert(!card.beginRead(34816U));
  assert(card.state() == State::kIoError);
  assert(card.diagnostic().bytes[dental_link::storage::diagnostic::kReadR1] == 0x3FU);
  uint8_t trace[ReadTrace::kLength]; card.readTrace().encode(trace);
  rejectRead = false; assert(card.initialize());
  invalidToken = true; assert(!card.beginRead(34817U)); invalidToken = false;
  assert(card.initialize());
  assert(card.beginRead(34818U)); assert(!card.beginRead(34819U)); card.abort();
  assert(card.initialize());
  stuckBusy = true; assert(card.beginWrite(34820U));
  uint8_t chunk[16] = {}; bool complete = false;
  for (unsigned i = 0U; i < 31U; ++i) assert(card.writeChunk(chunk, 16U, complete));
  assert(!card.writeChunk(chunk, 16U, complete));
  assert(card.state() == State::kIoError && (PORTB & _BV(2)));
  puts("Production RawCard SPI: 5 fault/register scenarios + 100 read/write/idle/read cycles PASSED");
}
