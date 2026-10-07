// Host execution of the actual ESP32 read and abort-fence functions. Only UART,
// clock and USB logging are substituted; production request lifecycle is used.
#include "../../firmware-common/include/storage_link_protocol.h"
#include "storage_rx_diagnostics.h"
#include "remote_storage_timing.h"
#include <assert.h>
#include <stdio.h>
#include <deque>
#include <string.h>

using dental_link::storage::Frame;
using dental_link::storage::Operation;
constexpr uint32_t kStorageBridgeTimeoutMs = 5000U;
constexpr bool kVerboseDiagnostics = false;
bool storageRequestActive = false, storageNeedsResynchronization = false;
bool offlineTimingActive = false;
uint32_t offlineWaitMs = 0, offlineRetryRequests = 0;
uint32_t offlineFenceMs = 0;
unsigned offlineFences = 0U;
bool storageSectorRxActive = false, firstMalformedStorageLineCaptured = false;
dental::storage_diagnostics::LineStructure firstMalformedStorageLine;
dental_link::storage::ResponseMailbox mailbox;
Frame& atmegaStorageResponse = mailbox.frame;
bool& atmegaStorageResponseAvailable = mailbox.available;
enum class StorageRequestFailure { kNone, kTimedOut };
StorageRequestFailure lastStorageRequestFailure = StorageRequestFailure::kNone;
void recordStorageRequestFailure(StorageRequestFailure reason) { lastStorageRequestFailure = reason; }
const char* storageRequestFailureName(StorageRequestFailure) { return "test"; }
struct Metrics {
  unsigned bytes = 0, lines = 0, storageLines = 0, malformedStorageLines = 0,
           lineOverflows = 0, hexFailures = 0;
} atmegaRxMetrics;
using AtmegaRxMetrics = Metrics;
unsigned atmegaUartFifoOverflows = 0, atmegaUartBufferOverflows = 0,
         atmegaUartBreakErrors = 0, atmegaUartFrameErrors = 0,
         atmegaUartParityErrors = 0, atmegaUartUnknownErrors = 0;
int cacheRemoteReads = 0;
struct CacheRemoteTimingScope { explicit CacheRemoteTimingScope(int&, uint32_t = 0U) {} };
struct DebugSerial {
  template <typename... T> void print(T...) {}
  template <typename... T> void println(T...) {}
} Serial;
uint32_t now = 0U;
uint32_t millis() { return now; }
uint32_t esp_random() { return 0x1000U; }
void delay(unsigned) { ++now; }
void pumpHttpDuringCachePublication() {}
void printRawReadFailure(uint32_t) {}
void printCmd17ReadTrace() {}
void printStorageStreamDiagnostic() {}
std::deque<Frame> incoming;
unsigned limitChunks = 22U;
bool omitTerminal = false, nestedAttempt = false;
bool nestedRejected = false;
unsigned fenceRequests = 0U;
uint32_t readStarted = 0U, initialDelay = 0U, frameWireMs = 0U;
bool remoteSdReadSectorImpl(uint32_t, uint8_t*);
struct Requester {
  bool busy() { return false; }
  bool queueLine(const char* command) {
    if (strncmp(command, "SD:ABORT:", 9U) == 0) {
      ++fenceRequests;
      // A delayed previous OK and IDLE must not satisfy this new fence.
      Frame old; old.operation = Operation::kOk; incoming.push_back(old);
      old.operation = Operation::kIdle; old.sector = 0x999U; incoming.push_back(old);
      Frame current; current.operation = Operation::kIdle;
      sscanf(command + 9U, "%x", &current.sector); incoming.push_back(current);
      return true;
    }
    assert(strncmp(command, "SD:R:", 5U) == 0);
    readStarted = now;
    uint32_t sector = 0U; sscanf(command + 5U, "%x", &sector);
    for (unsigned index = 0U; index < limitChunks; ++index) {
      Frame data; data.operation = Operation::kData;
      data.offset = static_cast<uint16_t>(index * 24U);
      data.length = index == 21U ? 8U : 24U;
      for (unsigned byte = 0U; byte < data.length; ++byte)
        data.data[byte] = static_cast<uint8_t>(sector + data.offset + byte);
      incoming.push_back(data);
    }
    if (!omitTerminal) { Frame ok; ok.operation = Operation::kOk; incoming.push_back(ok); }
    return true;
  }
} atmegaResponder;
void serviceAtmegaLink() {
  // Substitute the UART pump with the same mailbox ownership policy used by
  // production serviceAtmegaLink. Every completed line remains FIFO ordered.
  if (storageRequestActive && mailbox.available) return;
  if (incoming.empty()) return;
  if (now - readStarted < initialDelay && incoming.front().operation != Operation::kIdle) return;
  now += frameWireMs;
  assert(mailbox.publish(incoming.front())); incoming.pop_front();
  if (nestedAttempt) {
    nestedAttempt = false;
    uint8_t nested[512] = {};
    nestedRejected = !remoteSdReadSectorImpl(999U, nested);
  }
}

#include "../../.runtime/critical-remote-production.inc"

int main() {
  uint8_t bytes[512] = {};
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    nestedAttempt = true; nestedRejected = false;
    assert(remoteSdReadSectorImpl(34816U + cycle / 2U, bytes));
    assert(nestedRejected && !storageRequestActive && !storageNeedsResynchronization);
    for (unsigned index = 0U; index < 512U; ++index)
      assert(bytes[index] == static_cast<uint8_t>(34816U + cycle / 2U + index));
  }
  for (unsigned stop : {1U, 8U, 21U, 22U}) {
    limitChunks = stop; omitTerminal = true;
    const unsigned faultFence = fenceRequests;
    assert(!remoteSdReadSectorImpl(34816U, bytes));
    assert(!storageNeedsResynchronization && !storageRequestActive);
    assert(fenceRequests == faultFence + 1U);
    // The automatic failure fence already drained the old stream. Requester
    // injects delayed old OK/IDLE *before* its matching ordered fence reply.
    limitChunks = 22U; omitTerminal = false;
    const unsigned before = fenceRequests;
    assert(remoteSdReadSectorImpl(34817U, bytes));
    assert(fenceRequests == before && incoming.empty());
  }
  for (unsigned offset : {216U, 240U, 0U}) {
    Frame stale; stale.operation = Operation::kData;
    stale.offset = static_cast<uint16_t>(offset); stale.length = 24U;
    incoming.push_back(stale); // wrong first offset or duplicate chunk 0
    assert(!remoteSdReadSectorImpl(34816U, bytes));
    assert(!storageNeedsResynchronization && !storageRequestActive);
    assert(remoteSdReadSectorImpl(34817U, bytes));
    assert(incoming.empty());
  }
  initialDelay = 4160U; frameWireMs = 65U;
  const uint32_t slowStarted = now;
  assert(remoteSdReadSectorImpl(34821U, bytes));
  assert(now - slowStarted > 5000U);
  initialDelay = frameWireMs = 0U;
  puts("Actual ESP32 remote read/fence: 8 fault/timing scenarios + 100 sequential/nested-request cycles PASSED");
}
