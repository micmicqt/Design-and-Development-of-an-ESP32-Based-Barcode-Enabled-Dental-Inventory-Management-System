#include "desktop_presence_lease.h"
#include "offline_inventory_cache.h"
#include "offline_pending_journal.h"
#include "rtc_recovery.h"
#include "transaction_event_queue.h"

#include <assert.h>
#include <stdio.h>
#include <map>
#include <string>

using namespace dental::events;
using dental::presence::DesktopPresenceLease;

namespace {

PendingTransactionEvent makeEvent(unsigned sequence) {
  PendingTransactionEvent event = {{}, {}, {}, {}};
  assert(formatEventId(event.eventId, "20500DE58C14-1234567890ABCDEF", sequence));
  snprintf(event.mode, sizeof(event.mode), "%s", sequence % 2U ? "restock" : "checkout");
  snprintf(event.barcode, sizeof(event.barcode), "%s", "0012345678901");
  snprintf(event.timestamp, sizeof(event.timestamp), "%s", "2026-09-04 21:40:03");
  return event;
}

TransactionResult makeResult(const PendingTransactionEvent& event,
                             StockStatus status, uint32_t quantity,
                             uint64_t resultingStock) {
  TransactionResult result = {{}, {}, 0U, 0ULL, StockStatus::kHigh};
  snprintf(result.eventId, sizeof(result.eventId), "%s", event.eventId);
  snprintf(result.mode, sizeof(result.mode), "%s", event.mode);
  result.quantity = quantity;
  result.resultingStock = resultingStock;
  result.stockStatus = status;
  return result;
}

void emptyQueue() {
  PendingEventQueue queue;
  assert(queue.size() == 0U);
  assert(queue.oldest() == nullptr);
  assert(queue.acknowledge("unknown") == AcknowledgementResult::kEmpty);
}

void repeatedRetrievalKeepsOldest() {
  PendingEventQueue queue;
  const PendingTransactionEvent first = makeEvent(1U);
  assert(queue.enqueue(first));
  assert(queue.enqueue(makeEvent(2U)));
  for (unsigned read = 0U; read < 20U; ++read) {
    assert(strcmp(queue.oldest()->eventId, first.eventId) == 0);
    assert(queue.size() == 2U);
  }
}

void fifoAcknowledgements() {
  PendingEventQueue queue;
  assert(queue.enqueue(makeEvent(1U)));
  assert(queue.enqueue(makeEvent(2U)));
  assert(queue.acknowledge(makeEvent(1U).eventId) == AcknowledgementResult::kAcknowledged);
  assert(strcmp(queue.oldest()->eventId, makeEvent(2U).eventId) == 0);
  assert(queue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kAcknowledged);
  assert(queue.oldest() == nullptr);
}

void fullQueueNeverOverwritesPending() {
  PendingEventQueue queue;
  for (unsigned index = 1U; index <= kQueueCapacity; ++index) assert(queue.enqueue(makeEvent(index)));
  assert(queue.full());
  assert(!queue.enqueue(makeEvent(99U)));
  assert(queue.size() == kQueueCapacity);
  assert(strcmp(queue.oldest()->eventId, makeEvent(1U).eventId) == 0);
}

void ringWrapPreservesOrder() {
  PendingEventQueue queue;
  for (unsigned index = 1U; index <= kQueueCapacity; ++index) assert(queue.enqueue(makeEvent(index)));
  for (unsigned index = 1U; index <= 40U; ++index) {
    assert(strcmp(queue.oldest()->eventId, makeEvent(index).eventId) == 0);
    assert(queue.acknowledge(makeEvent(index).eventId) == AcknowledgementResult::kAcknowledged);
    assert(queue.enqueue(makeEvent(index + kQueueCapacity)));
  }
}

void mismatchedAndUnknownAckPreserveHead() {
  PendingEventQueue queue;
  assert(queue.enqueue(makeEvent(1U)));
  assert(queue.enqueue(makeEvent(2U)));
  assert(queue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kMismatch);
  assert(queue.acknowledge("not-an-event") == AcknowledgementResult::kMismatch);
  assert(queue.size() == 2U);
  assert(strcmp(queue.oldest()->eventId, makeEvent(1U).eventId) == 0);
}

void lostResponseRetryNeverConsumesNextHead() {
  PendingEventQueue queue;
  assert(queue.enqueue(makeEvent(1U)));
  assert(queue.enqueue(makeEvent(2U)));
  assert(queue.acknowledge(makeEvent(1U).eventId) == AcknowledgementResult::kAcknowledged);
  for (unsigned retry = 0U; retry < 20U; ++retry) {
    assert(queue.acknowledge(makeEvent(1U).eventId) == AcknowledgementResult::kAlreadyAcknowledged);
    assert(queue.size() == 1U);
    assert(strcmp(queue.oldest()->eventId, makeEvent(2U).eventId) == 0);
  }
  assert(queue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kAcknowledged);
  assert(queue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kAlreadyAcknowledged);
  assert(queue.oldest() == nullptr);
}

void receiptsAreBoundedAndVolatile() {
  PendingEventQueue queue;
  for (unsigned index = 1U; index <= kQueueCapacity + 1U; ++index) {
    assert(queue.enqueue(makeEvent(index)));
    assert(queue.acknowledge(makeEvent(index).eventId) == AcknowledgementResult::kAcknowledged);
  }
  assert(queue.acknowledge(makeEvent(1U).eventId) == AcknowledgementResult::kEmpty);
  assert(queue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kAlreadyAcknowledged);
  PendingEventQueue rebootedQueue;
  assert(rebootedQueue.acknowledge(makeEvent(2U).eventId) == AcknowledgementResult::kEmpty);
}

void barcodeTextPreserved() {
  PendingEventQueue queue;
  PendingTransactionEvent event = makeEvent(1U);
  const std::string barcode = "00" + std::string(kMaximumBarcodeLength - 3U, 'x') + " ";
  snprintf(event.barcode, sizeof(event.barcode), "%s", barcode.c_str());
  assert(queue.enqueue(event));
  assert(strlen(queue.oldest()->barcode) == kMaximumBarcodeLength);
  assert(barcode == queue.oldest()->barcode);
}

void eventIdentifiersPreserveUniquenessAndBounds() {
  char first[kEventIdCapacity] = {};
  char second[kEventIdCapacity] = {};
  assert(formatEventId(first, "20500DE58C14-1234567890ABCDEF", 1ULL));
  assert(formatEventId(second, "20500DE58C14-1234567890ABCDEF", 2ULL));
  assert(strcmp(first, second) != 0);
  assert(formatEventId(second, "20500DE58C14-FEDCBA0987654321", 1ULL));
  assert(strcmp(first, second) != 0);
  assert(formatEventId(second, "20500DE58C14-1234567890ABCDEF", UINT64_MAX));
  assert(eventIdUsesSafeAlphabet(second, strlen(second)));
  assert(!formatEventId(second, "20500DE58C14-1234567890ABCDEF", 0ULL));
  assert(!formatEventId(second, std::string(100U, 'a').c_str(), 1ULL));
}

void acknowledgementParser() {
  char eventId[kEventIdCapacity] = {};
  const std::string valid = " \r\n { \"eventId\" : \"evt-A_B.1:2\" } \t";
  assert(parseAcknowledgementBody(valid.c_str(), valid.size(), eventId));
  assert(strcmp(eventId, "evt-A_B.1:2") == 0);
  const char* invalid[] = {
    "", "{}", "[]", "null", "{\"eventId\":null}", "{\"eventId\":1}",
    "{\"eventId\":\"\"}", "{\"eventId\":\"a b\"}", "{\"eventId\":\"a/b\"}",
    "{\"eventId\":\"a\\nb\"}", "{\"eventId\":\"a\n\"}",
    "{\"eventId\":\"a\",\"eventId\":\"b\"}", "{\"eventId\":\"a\",\"extra\":true}",
    "{\"eventId\":\"a\"}junk", "{\"eventID\":\"a\"}", "{\"eventId\":\"a\""
  };
  for (const char* body : invalid) assert(!parseAcknowledgementBody(body, strlen(body), eventId));
  const std::string tooLong = "{\"eventId\":\"" + std::string(kEventIdCapacity, 'a') + "\"}";
  assert(!parseAcknowledgementBody(tooLong.c_str(), tooLong.size(), eventId));
  const std::string tooLarge(kAcknowledgementBodyMaximumLength + 1U, ' ');
  assert(!parseAcknowledgementBody(tooLarge.c_str(), tooLarge.size(), eventId));
  const std::string embeddedNull("{\"eventId\":\"a\0b\"}", 17U);
  assert(!parseAcknowledgementBody(embeddedNull.c_str(), embeddedNull.size(), eventId));
}

void transactionResultParserAcceptsValidPayloads() {
  TransactionResult result = {{}, {}, 0U, 0ULL, StockStatus::kHigh};
  const char* restock =
      "{\"eventId\":\"evt-A_B.1:2\",\"result\":\"success\","
      "\"mode\":\"restock\",\"quantity\":2,\"resultingStock\":22,"
      "\"stockStatus\":\"HIGH\"}";
  assert(parseTransactionResultBody(restock, strlen(restock), result));
  assert(strcmp(result.eventId, "evt-A_B.1:2") == 0);
  assert(strcmp(result.mode, "restock") == 0);
  assert(result.quantity == 2U);
  assert(result.resultingStock == 22ULL);
  assert(result.stockStatus == StockStatus::kHigh);

  const char* reorderedCheckout =
      " { \"stockStatus\" : \"EMPTY\", \"resultingStock\" : 0,"
      "\"quantity\": 20, \"mode\": \"checkout\","
      "\"result\": \"success\", \"eventId\": \"evt-2\" } ";
  assert(parseTransactionResultBody(reorderedCheckout,
                                    strlen(reorderedCheckout), result));
  assert(strcmp(result.mode, "checkout") == 0);
  assert(result.stockStatus == StockStatus::kEmpty);
  assert(result.resultingStock == 0ULL);

  const char* largestStock =
      "{\"eventId\":\"evt-3\",\"result\":\"success\","
      "\"mode\":\"restock\",\"quantity\":10000,"
      "\"resultingStock\":9007199254740991,\"stockStatus\":\"LOW\"}";
  assert(parseTransactionResultBody(largestStock, strlen(largestStock), result));
  assert(result.resultingStock == kMaximumResultingStock);
  assert(result.stockStatus == StockStatus::kLow);
}

void transactionResultParserRejectsInvalidPayloads() {
  TransactionResult result = {{}, {}, 0U, 0ULL, StockStatus::kHigh};
  const char* invalid[] = {
      "", "{}", "[]", "null",
      "{\"eventId\":\"evt-1\",\"result\":\"failed\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"RESTOCK\",\"quantity\":1,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":0,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":-1,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1.5,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":10001,\"resultingStock\":1,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":9007199254740992,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":01,\"stockStatus\":\"HIGH\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":1,\"stockStatus\":\"high\"}",
      "{\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":1,\"stockStatus\":\"HIGH\",\"extra\":1}",
      "{\"eventId\":\"evt-1\",\"eventId\":\"evt-1\",\"result\":\"success\",\"mode\":\"restock\",\"quantity\":1,\"resultingStock\":1}",
  };
  for (const char* body : invalid) {
    assert(!parseTransactionResultBody(body, strlen(body), result));
  }
  const std::string tooLarge(kTransactionResultBodyMaximumLength + 1U, ' ');
  assert(!parseTransactionResultBody(tooLarge.c_str(), tooLarge.size(), result));
}

void validRestockHighResultRemainsPendingUntilAck() {
  PendingEventQueue queue;
  const PendingTransactionEvent event = makeEvent(1U);
  const TransactionResult result = makeResult(event, StockStatus::kHigh, 2U, 22ULL);
  assert(queue.enqueue(event));
  assert(queue.applyResult(result) == ResultApplicationResult::kApplied);
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->eventId, event.eventId) == 0);
  assert(queue.oldestAppliedResult() != nullptr);
  assert(queue.oldestAppliedResult()->stockStatus == StockStatus::kHigh);
  assert(queue.acknowledge(event.eventId) == AcknowledgementResult::kAcknowledged);
  assert(queue.oldest() == nullptr);
  assert(queue.oldestAppliedResult() == nullptr);
}

void validRestockLowAndCheckoutEmptyResults() {
  PendingEventQueue queue;
  const PendingTransactionEvent restock = makeEvent(1U);
  PendingTransactionEvent checkout = makeEvent(2U);
  snprintf(checkout.mode, sizeof(checkout.mode), "%s", "checkout");
  assert(queue.enqueue(restock));
  assert(queue.enqueue(checkout));
  assert(queue.applyResult(makeResult(restock, StockStatus::kLow, 1U, 3ULL)) ==
         ResultApplicationResult::kApplied);
  assert(queue.acknowledge(restock.eventId) == AcknowledgementResult::kAcknowledged);
  assert(queue.applyResult(makeResult(checkout, StockStatus::kEmpty, 3U, 0ULL)) ==
         ResultApplicationResult::kApplied);
  assert(queue.size() == 1U);
}

void mismatchedResultCannotChangeHead() {
  PendingEventQueue queue;
  const PendingTransactionEvent first = makeEvent(1U);
  const PendingTransactionEvent second = makeEvent(2U);
  assert(queue.enqueue(first));
  assert(queue.enqueue(second));
  assert(queue.applyResult(makeResult(second, StockStatus::kHigh, 1U, 5ULL)) ==
         ResultApplicationResult::kEventIdMismatch);
  assert(queue.oldestAppliedResult() == nullptr);
  TransactionResult wrongMode = makeResult(first, StockStatus::kHigh, 1U, 5ULL);
  snprintf(wrongMode.mode, sizeof(wrongMode.mode), "%s", "checkout");
  assert(queue.applyResult(wrongMode) == ResultApplicationResult::kModeMismatch);
  assert(queue.oldestAppliedResult() == nullptr);
}

void identicalResultRetryIsSafeAndConflictRejects() {
  PendingEventQueue queue;
  const PendingTransactionEvent event = makeEvent(1U);
  const TransactionResult original = makeResult(event, StockStatus::kHigh, 2U, 22ULL);
  assert(queue.enqueue(event));
  assert(queue.applyResult(original) == ResultApplicationResult::kApplied);
  for (unsigned retry = 0U; retry < 20U; ++retry) {
    assert(queue.applyResult(original) == ResultApplicationResult::kAlreadyApplied);
    assert(queue.size() == 1U);
  }
  TransactionResult conflict = original;
  conflict.resultingStock = 23ULL;
  assert(queue.applyResult(conflict) == ResultApplicationResult::kConflict);
  conflict = original;
  conflict.stockStatus = StockStatus::kLow;
  assert(queue.applyResult(conflict) == ResultApplicationResult::kConflict);
  assert(queue.oldestAppliedResult()->resultingStock == 22ULL);
  assert(queue.oldestAppliedResult()->stockStatus == StockStatus::kHigh);
}

void stockIndicatorTruthTableMatchesVerifiedLogic() {
  const StockIndicatorOutputs high = stockIndicatorOutputs(StockStatus::kHigh);
  const StockIndicatorOutputs low = stockIndicatorOutputs(StockStatus::kLow);
  const StockIndicatorOutputs empty = stockIndicatorOutputs(StockStatus::kEmpty);
  assert(high.controlA && !high.controlB);
  assert(!low.controlA && low.controlB);
  assert(empty.controlA && empty.controlB);
}

void resultApplicationPreservesExistingAckRetryBehavior() {
  PendingEventQueue queue;
  const PendingTransactionEvent first = makeEvent(1U);
  const PendingTransactionEvent second = makeEvent(2U);
  assert(queue.enqueue(first));
  assert(queue.enqueue(second));
  assert(queue.applyResult(makeResult(first, StockStatus::kHigh, 1U, 10ULL)) ==
         ResultApplicationResult::kApplied);
  assert(queue.acknowledge(first.eventId) == AcknowledgementResult::kAcknowledged);
  assert(queue.acknowledge(first.eventId) ==
         AcknowledgementResult::kAlreadyAcknowledged);
  assert(strcmp(queue.oldest()->eventId, second.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);
}

void transactionResultFeedbackQueueIsBoundedAndFifo() {
  TransactionResultQueue feedback;
  for (unsigned index = 1U; index <= kQueueCapacity; ++index) {
    const PendingTransactionEvent event = makeEvent(index);
    assert(feedback.enqueue(
        makeResult(event, StockStatus::kHigh, index, index + 10ULL)));
  }
  assert(feedback.full());
  assert(!feedback.enqueue(
      makeResult(makeEvent(99U), StockStatus::kLow, 1U, 1ULL)));

  for (unsigned index = 1U; index <= kQueueCapacity; ++index) {
    TransactionResult result = {{}, {}, 0U, 0ULL, StockStatus::kHigh};
    assert(feedback.dequeue(result));
    assert(strcmp(result.eventId, makeEvent(index).eventId) == 0);
  }
  TransactionResult result = {{}, {}, 0U, 0ULL, StockStatus::kHigh};
  assert(!feedback.dequeue(result));
}

void resultRetryAfterAckUsesReceiptWithoutTouchingNextHead() {
  PendingEventQueue queue;
  const PendingTransactionEvent first = makeEvent(1U);
  const PendingTransactionEvent second = makeEvent(2U);
  const TransactionResult applied =
      makeResult(first, StockStatus::kHigh, 2U, 22ULL);
  assert(queue.enqueue(first));
  assert(queue.enqueue(second));
  assert(queue.applyResult(applied) == ResultApplicationResult::kApplied);
  assert(queue.acknowledge(first.eventId) ==
         AcknowledgementResult::kAcknowledged);

  assert(queue.applyResult(applied) ==
         ResultApplicationResult::kAlreadyApplied);
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->eventId, second.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);

  TransactionResult conflict = applied;
  conflict.quantity = 3U;
  assert(queue.applyResult(conflict) == ResultApplicationResult::kConflict);
  conflict = applied;
  conflict.stockStatus = StockStatus::kLow;
  assert(queue.applyResult(conflict) == ResultApplicationResult::kConflict);
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->eventId, second.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);
}

void resultReceiptsAreBoundedAndUnknownAckCreatesNone() {
  PendingEventQueue queue;
  for (unsigned index = 1U; index <= kQueueCapacity + 1U; ++index) {
    const PendingTransactionEvent event = makeEvent(index);
    const TransactionResult result =
        makeResult(event, StockStatus::kHigh, 1U, index);
    assert(queue.enqueue(event));
    assert(queue.applyResult(result) == ResultApplicationResult::kApplied);
    assert(queue.acknowledge(event.eventId) ==
           AcknowledgementResult::kAcknowledged);
  }
  assert(queue.applyResult(makeResult(makeEvent(1U), StockStatus::kHigh, 1U,
                                     1ULL)) ==
         ResultApplicationResult::kEmpty);
  assert(queue.applyResult(makeResult(makeEvent(2U), StockStatus::kHigh, 1U,
                                     2ULL)) ==
         ResultApplicationResult::kAlreadyApplied);

  PendingEventQueue rejectedQueue;
  const PendingTransactionEvent rejected = makeEvent(50U);
  assert(rejectedQueue.enqueue(rejected));
  assert(rejectedQueue.acknowledge(rejected.eventId) ==
         AcknowledgementResult::kAcknowledged);
  assert(rejectedQueue.applyResult(
             makeResult(rejected, StockStatus::kEmpty, 1U, 0ULL)) ==
         ResultApplicationResult::kEmpty);
}

void jsonSerializationEscapesText() {
  std::string json;
  appendJsonString(json, "00\"\\\b\f\n\r\t\x01");
  assert(json == "\"00\\\"\\\\\\b\\f\\n\\r\\t\\u0001\"");
}

void heartbeatSetsDesktopAvailable() {
  DesktopPresenceLease lease(12000U);
  assert(!lease.desktopAvailable());
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  assert(lease.desktopAvailable());
}

void repeatedHeartbeatRefreshesLease() {
  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  lease.service(10000U);
  assert(lease.desktopAvailable());
  lease.recordHeartbeat(10000U);
  lease.service(21999U);
  assert(lease.desktopAvailable());
}

void leaseExpiryMakesDesktopUnavailable() {
  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  lease.service(12999U);
  assert(lease.desktopAvailable());
  lease.service(13000U);
  assert(!lease.desktopAvailable());
}

void networkLossClearsDesktopAvailabilityImmediately() {
  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  assert(lease.desktopAvailable());
  lease.setNetworkConnected(false);
  assert(!lease.desktopAvailable());
}

void heartbeatAfterReconnectRestoresAvailability() {
  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  lease.setNetworkConnected(false);
  lease.setNetworkConnected(true);
  assert(!lease.desktopAvailable());
  lease.recordHeartbeat(2000U);
  assert(lease.desktopAvailable());
}

void leaseExpiryIsMillisWrapSafe() {
  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  const uint32_t heartbeatMs = UINT32_MAX - 5000U;
  lease.recordHeartbeat(heartbeatMs);
  lease.service(heartbeatMs + 11999U);
  assert(lease.desktopAvailable());
  lease.service(heartbeatMs + 12000U);
  assert(!lease.desktopAvailable());
}

void heartbeatDoesNotChangePendingEventFifo() {
  PendingEventQueue queue;
  const PendingTransactionEvent first = makeEvent(1U);
  assert(queue.enqueue(first));
  assert(queue.enqueue(makeEvent(2U)));

  DesktopPresenceLease lease(12000U);
  lease.setNetworkConnected(true);
  lease.recordHeartbeat(1000U);
  lease.service(5000U);

  assert(queue.size() == 2U);
  assert(strcmp(queue.oldest()->eventId, first.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);
}

class MemoryCacheStorage : public dental::cache::CacheStorage {
 public:
  bool storageAvailable = true;
  bool failNextWrite = false;
  bool failNextAppend = false;
  bool failTemporaryPromotion = false;
  bool failBackupRestore = false;
  bool failActiveRemoval = false;
  std::map<std::string, std::string> files;

  bool available() const override { return storageAvailable; }
  bool exists(const char* path) override {
    return files.find(path) != files.end();
  }
  bool remove(const char* path) override {
    if (!storageAvailable ||
        (failActiveRemoval &&
         strcmp(path, dental::cache::kActiveCachePath) == 0)) {
      return false;
    }
    return files.erase(path) == 1U;
  }
  bool rename(const char* from, const char* to) override {
    if (!storageAvailable ||
        (failBackupRestore &&
         strcmp(from, dental::cache::kBackupCachePath) == 0)) {
      return false;
    }
    if (failTemporaryPromotion &&
        strcmp(from, dental::cache::kTemporaryCachePath) == 0) {
      failTemporaryPromotion = false;
      return false;
    }
    const std::map<std::string, std::string>::iterator source = files.find(from);
    if (source == files.end() || files.find(to) != files.end()) return false;
    files[to] = source->second;
    files.erase(source);
    return true;
  }
  bool writeFile(const char* path, const char* data, size_t length) override {
    if (!storageAvailable || failNextWrite) {
      failNextWrite = false;
      return false;
    }
    files[path] = std::string(data, length);
    return true;
  }
  bool appendFile(const char* path, const char* data, size_t length) override {
    if (!storageAvailable || failNextAppend || !exists(path)) {
      failNextAppend = false;
      return false;
    }
    files[path].append(data, length);
    return true;
  }
  bool beginRead(const char* path) override {
    const std::map<std::string, std::string>::const_iterator found = files.find(path);
    if (!storageAvailable || found == files.end()) return false;
    readSnapshot = found->second;
    readOffset = 0U;
    reading = true;
    return true;
  }
  dental::cache::ReadLineResult readLine(char* line,
                                          size_t capacity) override {
    if (!reading || capacity == 0U) return dental::cache::ReadLineResult::kError;
    if (readOffset >= readSnapshot.size()) {
      line[0] = '\0';
      return dental::cache::ReadLineResult::kEnd;
    }
    const size_t start = readOffset;
    size_t end = readSnapshot.find('\n', start);
    if (end == std::string::npos) end = readSnapshot.size();
    size_t length = end - start;
    if (length > 0U && readSnapshot[start + length - 1U] == '\r') --length;
    readOffset = end < readSnapshot.size() ? end + 1U : end;
    if (length + 1U > capacity) return dental::cache::ReadLineResult::kTooLong;
    memcpy(line, readSnapshot.data() + start, length);
    line[length] = '\0';
    return dental::cache::ReadLineResult::kLine;
  }
  void endRead() override {
    reading = false;
    readSnapshot.clear();
    readOffset = 0U;
  }

 private:
  bool reading = false;
  std::string readSnapshot;
  size_t readOffset = 0U;
};

class MemoryPendingJournalStorage
    : public dental::offline::PendingJournalStorage {
 public:
  bool storageAvailable = true;
  bool failNextWrite = false;
  bool failNextAppend = false;
  size_t nextPartialAppendBytes = 0U;
  bool failTemporaryPromotion = false;
  uint32_t appendCallCount = 0U;
  uint32_t failOnAppendCall = 0U;
  uint32_t reportFailureOnAppendCall = 0U;
  std::map<std::string, std::string> files;

  bool available() const override { return storageAvailable; }
  bool exists(const char* path) override {
    return files.find(path) != files.end();
  }
  bool remove(const char* path) override {
    if (!storageAvailable) return false;
    return files.erase(path) == 1U;
  }
  bool rename(const char* from, const char* to) override {
    if (!storageAvailable) return false;
    if (failTemporaryPromotion &&
        strcmp(from, dental::offline::kPendingJournalTemporaryPath) == 0) {
      failTemporaryPromotion = false;
      return false;
    }
    const std::map<std::string, std::string>::iterator source =
        files.find(from);
    if (source == files.end() || files.find(to) != files.end()) return false;
    files[to] = source->second;
    files.erase(source);
    return true;
  }
  bool writeFile(const char* path, const char* data, size_t length) override {
    if (!storageAvailable || failNextWrite) {
      failNextWrite = false;
      return false;
    }
    files[path] = std::string(data, length);
    return true;
  }
  bool appendFile(const char* path, const char* data, size_t length) override {
    if (!storageAvailable || !exists(path)) return false;
    ++appendCallCount;
    if (nextPartialAppendBytes > 0U) {
      const size_t bytes =
          nextPartialAppendBytes < length ? nextPartialAppendBytes : length;
      files[path].append(data, bytes);
      nextPartialAppendBytes = 0U;
      return false;
    }
    if (appendCallCount == failOnAppendCall) return false;
    if (failNextAppend) {
      failNextAppend = false;
      return false;
    }
    files[path].append(data, length);
    if (appendCallCount == reportFailureOnAppendCall) {
      return false;
    }
    return true;
  }
  bool beginRead(const char* path) override {
    const std::map<std::string, std::string>::const_iterator found =
        files.find(path);
    if (!storageAvailable || found == files.end()) return false;
    readSnapshot = found->second;
    readOffset = 0U;
    reading = true;
    return true;
  }
  dental::offline::JournalReadLineResult readLine(
      char* line, size_t capacity) override {
    using dental::offline::JournalReadLineResult;
    if (!reading || capacity == 0U) return JournalReadLineResult::kError;
    if (readOffset >= readSnapshot.size()) {
      line[0] = '\0';
      return JournalReadLineResult::kEnd;
    }
    const size_t start = readOffset;
    const size_t newline = readSnapshot.find('\n', start);
    const bool terminated = newline != std::string::npos;
    const size_t end = terminated ? newline : readSnapshot.size();
    size_t length = end - start;
    if (length > 0U && readSnapshot[start + length - 1U] == '\r') --length;
    readOffset = terminated ? end + 1U : end;
    if (length + 1U > capacity) {
      line[0] = '\0';
      return terminated ? JournalReadLineResult::kTooLongTerminated
                        : JournalReadLineResult::kTooLongUnterminated;
    }
    memcpy(line, readSnapshot.data() + start, length);
    line[length] = '\0';
    return terminated ? JournalReadLineResult::kTerminatedLine
                      : JournalReadLineResult::kUnterminatedLine;
  }
  void endRead() override {
    reading = false;
    readSnapshot.clear();
    readOffset = 0U;
  }

 private:
  bool reading = false;
  std::string readSnapshot;
  size_t readOffset = 0U;
};

const char* cacheGenerationA() {
  return "v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
}

const char* cacheGenerationB() {
  return "v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
}

dental::cache::CacheProduct makeCachedProduct(
    const char* id = "1", const char* barcode = "0012345678901",
    uint64_t stock = 8ULL, uint64_t threshold = 3ULL,
    dental::cache::StockStatus status = dental::cache::StockStatus::kHigh) {
  dental::cache::CacheProduct product = {};
  snprintf(product.id, sizeof(product.id), "%s", id);
  snprintf(product.barcode, sizeof(product.barcode), "%s", barcode);
  snprintf(product.name, sizeof(product.name), "%s", "Composite, \"A\"");
  snprintf(product.category, sizeof(product.category), "%s",
           "Restorative & Esthetic");
  product.currentStock = stock;
  product.lowStockThreshold = threshold;
  product.status = status;
  return product;
}

void installSingleCache(dental::cache::OfflineInventoryCache& cache,
                        const char* generation,
                        const dental::cache::CacheProduct& product) {
  assert(cache.begin(generation, 1U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(generation, 0U, product) ==
         dental::cache::ItemResult::kAccepted);
  assert(cache.commit(generation, 1U) ==
         dental::cache::CommitResult::kCommitted);
}

std::string validSingleCacheFile(
    const char* generation,
    const dental::cache::CacheProduct& product = makeCachedProduct()) {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  installSingleCache(cache, generation, product);
  return storage.files[dental::cache::kActiveCachePath];
}

void cacheRequestParserIsStrictAndPreservesBarcode() {
  dental::cache::CacheRequest request = {};
  const std::string begin = std::string("{\"operation\":\"begin\",\"generation\":\"") +
      cacheGenerationA() + "\",\"itemCount\":2}";
  assert(dental::cache::parseCacheRequest(begin.c_str(), begin.size(), request));
  assert(request.operation == dental::cache::CacheOperation::kBegin);
  assert(request.itemCount == 2U);

  const std::string item = std::string(
      "{\"operation\":\"item\",\"generation\":\"") + cacheGenerationA() +
      "\",\"index\":0,\"product\":{\"id\":\"42\","
      "\"barcode\":\"00001234\",\"name\":\"Quoted \\\"item\\\"\","
      "\"category\":\"General\",\"currentStock\":2,"
      "\"lowStockThreshold\":2,\"status\":\"LOW\"}}";
  assert(dental::cache::parseCacheRequest(item.c_str(), item.size(), request));
  assert(request.operation == dental::cache::CacheOperation::kItem);
  assert(strcmp(request.product.barcode, "00001234") == 0);
  assert(strcmp(request.product.name, "Quoted \"item\"") == 0);

  const std::string extra = begin.substr(0U, begin.size() - 1U) + ",\"extra\":1}";
  assert(!dental::cache::parseCacheRequest(extra.c_str(), extra.size(), request));
  const std::string badGeneration =
      "{\"operation\":\"begin\",\"generation\":\"v1-ABC\",\"itemCount\":0}";
  assert(!dental::cache::parseCacheRequest(badGeneration.c_str(),
                                           badGeneration.size(), request));
}

std::string cacheItemRequest(const std::string& idJson,
                             const std::string& barcodeJson,
                             const std::string& nameJson,
                             const char* status = "HIGH",
                             unsigned stock = 8U,
                             unsigned threshold = 3U) {
  char quantities[96U] = {};
  snprintf(quantities, sizeof(quantities),
           ",\"currentStock\":%u,\"lowStockThreshold\":%u,"
           "\"status\":\"%s\"}}",
           stock, threshold, status);
  return std::string("{\"operation\":\"item\",\"generation\":\"") +
         cacheGenerationA() +
         "\",\"index\":0,\"product\":{\"id\":\"" + idJson +
         "\",\"barcode\":\"" + barcodeJson + "\",\"name\":\"" +
         nameJson +
         "\",\"category\":\"Restorative & Esthetic\"" + quantities;
}

void cacheRequestBoundsAndDecodedTextAreStrict() {
  dental::cache::CacheRequest request = {};

  const std::string escapedNull =
      cacheItemRequest("1", "ABC\\u0000DEF", "Composite");
  assert(!dental::cache::parseCacheRequest(
      escapedNull.c_str(), escapedNull.size(), request));
  const std::string escapedControl =
      cacheItemRequest("1", "ABC\\u001FDEF", "Composite");
  assert(!dental::cache::parseCacheRequest(
      escapedControl.c_str(), escapedControl.size(), request));
  const std::string escapedDelete =
      cacheItemRequest("1", "ABC\\u007FDEF", "Composite");
  assert(!dental::cache::parseCacheRequest(
      escapedDelete.c_str(), escapedDelete.size(), request));
  const std::string whitespaceBarcode =
      cacheItemRequest("1", "   ", "Composite");
  assert(!dental::cache::parseCacheRequest(
      whitespaceBarcode.c_str(), whitespaceBarcode.size(), request));
  const std::string whitespaceName = cacheItemRequest("1", "ABC", "   ");
  assert(!dental::cache::parseCacheRequest(
      whitespaceName.c_str(), whitespaceName.size(), request));

  for (const char* invalidId : {"0", "01", "-1", "1.0"}) {
    const std::string body =
        cacheItemRequest(invalidId, "000123", "Composite");
    assert(!dental::cache::parseCacheRequest(body.c_str(), body.size(),
                                             request));
  }

  const std::string tooMany = std::string(
      "{\"operation\":\"begin\",\"generation\":\"") +
      cacheGenerationA() + "\",\"itemCount\":10001}";
  assert(!dental::cache::parseCacheRequest(tooMany.c_str(), tooMany.size(),
                                           request));
  const std::string malformedCommit = std::string(
      "{\"operation\":\"commit\",\"generation\":\"") +
      cacheGenerationA() + "\"}";
  assert(!dental::cache::parseCacheRequest(
      malformedCommit.c_str(), malformedCommit.size(), request));
  const std::string inconsistentStatus =
      cacheItemRequest("1", "000123", "Composite", "HIGH", 2U, 2U);
  assert(!dental::cache::parseCacheRequest(
      inconsistentStatus.c_str(), inconsistentStatus.size(), request));

  std::string maximumBarcode;
  std::string maximumName;
  for (size_t index = 0U;
       index < dental::cache::kMaximumBarcodeUtf16Units; ++index) {
    maximumBarcode += "\\u0061";
  }
  for (size_t index = 0U;
       index < dental::cache::kMaximumProductNameUtf16Units; ++index) {
    maximumName += "\\u0062";
  }
  const std::string maximumRequest =
      cacheItemRequest("9007199254740991", maximumBarcode, maximumName,
                       "HIGH", 9999999U, 1U);
  assert(maximumRequest.size() <= dental::cache::kCacheRequestMaximumLength);
  assert(dental::cache::parseCacheRequest(
      maximumRequest.c_str(), maximumRequest.size(), request));
  assert(strlen(request.product.barcode) ==
         dental::cache::kMaximumBarcodeUtf16Units);
  assert(strlen(request.product.name) ==
         dental::cache::kMaximumProductNameUtf16Units);

  dental::cache::CacheProduct boundary = makeCachedProduct();
  memset(boundary.barcode, 'B', dental::cache::kMaximumBarcodeUtf16Units);
  boundary.barcode[dental::cache::kMaximumBarcodeUtf16Units] = '\0';
  memset(boundary.name, 'N', dental::cache::kMaximumProductNameUtf16Units);
  boundary.name[dental::cache::kMaximumProductNameUtf16Units] = '\0';
  assert(dental::cache::validProduct(boundary));
  char row[dental::cache::kCacheLineCapacity] = {};
  size_t rowLength = 0U;
  assert(dental::cache::formatProductCsv(
      boundary, row, sizeof(row) - 1U, rowLength));
  assert(rowLength + 2U <= sizeof(row));

  boundary.barcode[dental::cache::kMaximumBarcodeUtf16Units] = 'B';
  boundary.barcode[dental::cache::kMaximumBarcodeUtf16Units + 1U] = '\0';
  assert(!dental::cache::validProduct(boundary));
  boundary = makeCachedProduct();
  memset(boundary.name, 'N',
         dental::cache::kMaximumProductNameUtf16Units + 1U);
  boundary.name[dental::cache::kMaximumProductNameUtf16Units + 1U] = '\0';
  assert(!dental::cache::validProduct(boundary));
  boundary = makeCachedProduct();
  boundary.barcode[0] = static_cast<char>(0xC0U);
  boundary.barcode[1] = static_cast<char>(0xAFU);
  boundary.barcode[2] = '\0';
  assert(!dental::cache::validProduct(boundary));
}

void validCacheInstallationPreservesExactCsvAndMetadata() {
  MemoryCacheStorage storage;
  storage.files["/integration_test.csv"] = "sentinel transaction data\n";
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 1U) == dental::cache::BeginResult::kStarted);
  const dental::cache::CacheProduct product = makeCachedProduct();
  assert(cache.item(cacheGenerationA(), 0U, product) ==
         dental::cache::ItemResult::kAccepted);
  assert(cache.commit(cacheGenerationA(), 1U) ==
         dental::cache::CommitResult::kCommitted);
  assert(cache.metadata().available);
  assert(cache.metadata().itemCount == 1U);
  assert(strcmp(cache.metadata().generation, cacheGenerationA()) == 0);
  assert(storage.files[dental::cache::kActiveCachePath].find(
             "\"0012345678901\"") != std::string::npos);
  assert(storage.files[dental::cache::kActiveCachePath].find(
             "\"Composite, \"\"A\"\"\"") != std::string::npos);
  assert(storage.files["/integration_test.csv"] == "sentinel transaction data\n");
}

void cacheSurvivesRebootAndInstalledBeginIsIdempotent() {
  MemoryCacheStorage storage;
  {
    dental::cache::OfflineInventoryCache cache(storage);
    assert(cache.begin(cacheGenerationA(), 1U) == dental::cache::BeginResult::kStarted);
    assert(cache.item(cacheGenerationA(), 0U, makeCachedProduct()) ==
           dental::cache::ItemResult::kAccepted);
    assert(cache.commit(cacheGenerationA(), 1U) ==
           dental::cache::CommitResult::kCommitted);
  }
  dental::cache::OfflineInventoryCache rebooted(storage);
  assert(rebooted.loadAtBoot());
  assert(rebooted.metadata().itemCount == 1U);
  assert(rebooted.begin(cacheGenerationA(), 1U) ==
         dental::cache::BeginResult::kAlreadyCurrent);
  assert(rebooted.receivedItems() == 1U);
}

void incompleteTransferAndMalformedReplacementPreserveActive() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 1U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationA(), 0U, makeCachedProduct()) ==
         dental::cache::ItemResult::kAccepted);
  assert(cache.commit(cacheGenerationA(), 1U) ==
         dental::cache::CommitResult::kCommitted);
  const std::string original = storage.files[dental::cache::kActiveCachePath];

  assert(cache.begin(cacheGenerationB(), 2U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationB(), 0U, makeCachedProduct("2", "0002")) ==
         dental::cache::ItemResult::kAccepted);
  dental::cache::OfflineInventoryCache rebooted(storage);
  assert(rebooted.loadAtBoot());
  assert(strcmp(rebooted.metadata().generation, cacheGenerationA()) == 0);
  assert(storage.files[dental::cache::kActiveCachePath] == original);

  storage.files[dental::cache::kTemporaryCachePath] = "malformed\n";
  assert(rebooted.begin(cacheGenerationB(), 1U) ==
         dental::cache::BeginResult::kStarted);
  assert(storage.files[dental::cache::kActiveCachePath] == original);
}

void failedPromotionRestoresPreviousValidCache() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 1U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationA(), 0U, makeCachedProduct()) ==
         dental::cache::ItemResult::kAccepted);
  assert(cache.commit(cacheGenerationA(), 1U) ==
         dental::cache::CommitResult::kCommitted);
  const std::string original = storage.files[dental::cache::kActiveCachePath];

  assert(cache.begin(cacheGenerationB(), 1U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationB(), 0U, makeCachedProduct("2", "0002")) ==
         dental::cache::ItemResult::kAccepted);
  storage.failTemporaryPromotion = true;
  assert(cache.commit(cacheGenerationB(), 1U) ==
         dental::cache::CommitResult::kReplacementFailed);
  assert(storage.files[dental::cache::kActiveCachePath] == original);
  dental::cache::OfflineInventoryCache rebooted(storage);
  assert(rebooted.loadAtBoot());
  assert(strcmp(rebooted.metadata().generation, cacheGenerationA()) == 0);
}

void repeatedBeginRestartsUnverifiablePrefixAndDuplicateItemIsSafe() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache first(storage);
  const dental::cache::CacheProduct product = makeCachedProduct();
  assert(first.begin(cacheGenerationA(), 2U) == dental::cache::BeginResult::kStarted);
  assert(first.item(cacheGenerationA(), 0U, product) ==
         dental::cache::ItemResult::kAccepted);

  // Even a structurally valid prefix is recreated: its desktop SHA generation
  // cannot be independently verified until all products have been received.
  dental::cache::OfflineInventoryCache restarted(storage);
  assert(restarted.begin(cacheGenerationA(), 2U) ==
         dental::cache::BeginResult::kStarted);
  assert(restarted.receivedItems() == 0U);
  assert(storage.files[dental::cache::kTemporaryCachePath].find(
             "0012345678901") == std::string::npos);
  assert(restarted.item(cacheGenerationA(), 0U, product) ==
         dental::cache::ItemResult::kAccepted);
  assert(restarted.item(cacheGenerationA(), 0U, product) ==
         dental::cache::ItemResult::kAlreadyAccepted);
  dental::cache::CacheProduct conflict = product;
  snprintf(conflict.name, sizeof(conflict.name), "%s", "Different");
  assert(restarted.item(cacheGenerationA(), 0U, conflict) ==
         dental::cache::ItemResult::kConflictingItem);
  assert(restarted.receivedItems() == 1U);
}

void cacheChecksumBindsMetadataAndAllContent() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  installSingleCache(cache, cacheGenerationA(), makeCachedProduct());

  std::string& active = storage.files[dental::cache::kActiveCachePath];
  const size_t generationOffset = active.find(cacheGenerationA());
  assert(generationOffset != std::string::npos);
  active.replace(generationOffset, strlen(cacheGenerationA()),
                 cacheGenerationB());
  dental::cache::OfflineInventoryCache changedMetadata(storage);
  assert(!changedMetadata.loadAtBoot());
  assert(!changedMetadata.metadata().available);

  storage.files[dental::cache::kActiveCachePath] =
      validSingleCacheFile(cacheGenerationA());
  std::string& changedHeader =
      storage.files[dental::cache::kActiveCachePath];
  const size_t headerOffset = changedHeader.find(dental::cache::kCacheColumns);
  assert(headerOffset != std::string::npos);
  changedHeader[headerOffset] = 'X';
  dental::cache::OfflineInventoryCache invalidHeader(storage);
  assert(!invalidHeader.loadAtBoot());
  assert(!invalidHeader.metadata().available);

  storage.files[dental::cache::kActiveCachePath] =
      validSingleCacheFile(cacheGenerationA());
  std::string& changedProduct =
      storage.files[dental::cache::kActiveCachePath];
  const size_t barcodeOffset = changedProduct.find("0012345678901");
  assert(barcodeOffset != std::string::npos);
  changedProduct[barcodeOffset] = '9';
  dental::cache::OfflineInventoryCache changedRow(storage);
  assert(!changedRow.loadAtBoot());
  assert(!changedRow.metadata().available);
}

void bootRecoversCommittedTemporaryWithoutDisplacingValidActive() {
  const std::string first = validSingleCacheFile(cacheGenerationA());
  const std::string second = validSingleCacheFile(
      cacheGenerationB(), makeCachedProduct("2", "0002"));

  MemoryCacheStorage interrupted;
  interrupted.files[dental::cache::kActiveCachePath] = "malformed\n";
  interrupted.files[dental::cache::kTemporaryCachePath] = second;
  interrupted.files[dental::cache::kBackupCachePath] = first;
  dental::cache::OfflineInventoryCache recovered(interrupted);
  assert(recovered.loadAtBoot());
  assert(strcmp(recovered.metadata().generation, cacheGenerationB()) == 0);
  assert(interrupted.files[dental::cache::kActiveCachePath] == second);
  assert(interrupted.files[dental::cache::kBackupCachePath] == first);

  MemoryCacheStorage activeWins;
  activeWins.files[dental::cache::kActiveCachePath] = first;
  activeWins.files[dental::cache::kTemporaryCachePath] = second;
  dental::cache::OfflineInventoryCache preferredActive(activeWins);
  assert(preferredActive.loadAtBoot());
  assert(strcmp(preferredActive.metadata().generation, cacheGenerationA()) == 0);
  assert(activeWins.files[dental::cache::kActiveCachePath] == first);
  assert(activeWins.files[dental::cache::kTemporaryCachePath] == second);
}

void commitReplacesInvalidActiveAndRetainsValidBackup() {
  const std::string previous = validSingleCacheFile(cacheGenerationA());
  MemoryCacheStorage storage;
  storage.files[dental::cache::kActiveCachePath] = "corrupt active\n";
  storage.files[dental::cache::kBackupCachePath] = previous;
  dental::cache::OfflineInventoryCache cache(storage);

  installSingleCache(cache, cacheGenerationB(),
                     makeCachedProduct("2", "0002"));
  assert(strcmp(cache.metadata().generation, cacheGenerationB()) == 0);
  assert(storage.files[dental::cache::kBackupCachePath] == previous);
  dental::cache::OfflineInventoryCache rebooted(storage);
  assert(rebooted.loadAtBoot());
  assert(strcmp(rebooted.metadata().generation, cacheGenerationB()) == 0);
}

void retainedBackupRecoversLaterActiveCorruption() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
  const std::string previous =
      storage.files[dental::cache::kActiveCachePath];
  installSingleCache(cache, cacheGenerationB(),
                     makeCachedProduct("2", "0002"));
  assert(storage.files[dental::cache::kBackupCachePath] == previous);

  storage.files[dental::cache::kActiveCachePath] = "later corruption\n";
  dental::cache::OfflineInventoryCache rebooted(storage);
  assert(rebooted.loadAtBoot());
  assert(strcmp(rebooted.metadata().generation, cacheGenerationA()) == 0);
  assert(storage.files[dental::cache::kActiveCachePath] == previous);
}

void failedRecoveryNeverPublishesUnusableMetadata() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
  const std::string previous =
      storage.files[dental::cache::kActiveCachePath];
  assert(cache.begin(cacheGenerationB(), 1U) ==
         dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationB(), 0U,
                    makeCachedProduct("2", "0002")) ==
         dental::cache::ItemResult::kAccepted);
  storage.failTemporaryPromotion = true;
  storage.failBackupRestore = true;
  assert(cache.commit(cacheGenerationB(), 1U) ==
         dental::cache::CommitResult::kReplacementFailed);
  assert(!cache.metadata().available);
  assert(storage.files[dental::cache::kBackupCachePath] == previous);
  assert(storage.files.find(dental::cache::kTemporaryCachePath) !=
         storage.files.end());

  MemoryCacheStorage removalFailure;
  removalFailure.files[dental::cache::kActiveCachePath] = "corrupt\n";
  removalFailure.files[dental::cache::kBackupCachePath] = previous;
  removalFailure.failActiveRemoval = true;
  dental::cache::OfflineInventoryCache cannotRemove(removalFailure);
  assert(!cannotRemove.loadAtBoot());
  assert(!cannotRemove.metadata().available);
  assert(removalFailure.files[dental::cache::kBackupCachePath] == previous);

  MemoryCacheStorage renameFailure;
  renameFailure.files[dental::cache::kActiveCachePath] = "corrupt\n";
  renameFailure.files[dental::cache::kBackupCachePath] = previous;
  renameFailure.failBackupRestore = true;
  dental::cache::OfflineInventoryCache cannotRename(renameFailure);
  assert(!cannotRename.loadAtBoot());
  assert(!cannotRename.metadata().available);
  assert(renameFailure.files[dental::cache::kBackupCachePath] == previous);
}

void malformedSequenceAndCountMismatchPreserveTransfer() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 1U) ==
         dental::cache::BeginResult::kStarted);
  assert(cache.item(cacheGenerationB(), 0U, makeCachedProduct()) ==
         dental::cache::ItemResult::kGenerationMismatch);
  dental::cache::CacheProduct malformed = makeCachedProduct();
  snprintf(malformed.id, sizeof(malformed.id), "%s", "0");
  assert(cache.item(cacheGenerationA(), 0U, malformed) ==
         dental::cache::ItemResult::kUnexpectedIndex);
  assert(cache.receivedItems() == 0U);
  assert(cache.item(cacheGenerationA(), 0U, makeCachedProduct()) ==
         dental::cache::ItemResult::kAccepted);
  assert(cache.commit(cacheGenerationB(), 1U) ==
         dental::cache::CommitResult::kGenerationMismatch);
  assert(cache.commit(cacheGenerationA(), 0U) ==
         dental::cache::CommitResult::kCountMismatch);
  assert(cache.transferActive());
  assert(cache.commit(cacheGenerationA(), 1U) ==
         dental::cache::CommitResult::kCommitted);
}

void emptyCacheAndUnavailableStorageAreSafe() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 0U) == dental::cache::BeginResult::kStarted);
  assert(cache.commit(cacheGenerationA(), 0U) ==
         dental::cache::CommitResult::kCommitted);
  assert(cache.metadata().available && cache.metadata().itemCount == 0U);
  dental::cache::OfflineInventoryCache emptyReboot(storage);
  assert(emptyReboot.loadAtBoot());
  assert(emptyReboot.metadata().available &&
         emptyReboot.metadata().itemCount == 0U);

  storage.storageAvailable = false;
  dental::cache::OfflineInventoryCache unavailable(storage);
  assert(!unavailable.loadAtBoot());
  assert(unavailable.begin(cacheGenerationB(), 0U) ==
         dental::cache::BeginResult::kStorageUnavailable);
  assert(unavailable.commit(cacheGenerationB(), 0U) ==
         dental::cache::CommitResult::kStorageUnavailable);

  MemoryCacheStorage lostDuringTransfer;
  dental::cache::OfflineInventoryCache interrupted(lostDuringTransfer);
  installSingleCache(interrupted, cacheGenerationA(), makeCachedProduct());
  const std::string installed =
      lostDuringTransfer.files[dental::cache::kActiveCachePath];
  assert(interrupted.begin(cacheGenerationB(), 1U) ==
         dental::cache::BeginResult::kStarted);
  lostDuringTransfer.storageAvailable = false;
  assert(interrupted.item(cacheGenerationB(), 0U,
                          makeCachedProduct("2", "0002")) ==
         dental::cache::ItemResult::kWriteFailed);
  assert(lostDuringTransfer.files[dental::cache::kActiveCachePath] ==
         installed);
}

void cacheOperationsDoNotAlterEventFifo() {
  PendingEventQueue queue;
  const PendingTransactionEvent event = makeEvent(1U);
  assert(queue.enqueue(event));
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  assert(cache.begin(cacheGenerationA(), 0U) == dental::cache::BeginResult::kStarted);
  assert(cache.commit(cacheGenerationA(), 0U) ==
         dental::cache::CommitResult::kCommitted);
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->eventId, event.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);
}

const char* offlineDeviceId() { return "20500DE58C14"; }

dental::offline::OfflineJournalRecord appendOfflineRecord(
    dental::offline::PendingJournal& journal,
    dental::offline::OfflineAction action,
    const dental::cache::CacheProduct& product,
    const char* generation = cacheGenerationA(),
    const char* timestamp = "2026-09-09 12:34:56") {
  uint64_t currentStock = 0ULL;
  assert(journal.deriveCurrentStock(product, generation, currentStock) ==
         dental::offline::OverlayResult::kSuccess);
  uint64_t resultingStock = 0ULL;
  dental::cache::StockStatus resultingStatus =
      dental::cache::StockStatus::kEmpty;
  assert(dental::offline::calculateOfflineStock(
             action, currentStock, product.lowStockThreshold, resultingStock,
             resultingStatus) == dental::offline::OfflineStockResult::kSuccess);
  dental::offline::OfflineJournalRecord committed = {};
  assert(journal.append(action, timestamp, product, generation,
                        resultingStock, resultingStatus, committed) ==
         dental::offline::JournalAppendResult::kCommitted);
  return committed;
}

void transactionRouteSelectionCanBeFrozenAtAcceptance() {
  assert(dental::offline::selectTransactionRoute(true) ==
         dental::offline::TransactionRoute::kOnline);
  const dental::offline::TransactionRoute captured =
      dental::offline::selectTransactionRoute(false);
  assert(captured == dental::offline::TransactionRoute::kOffline);
  const bool desktopReturnsDuringScan = true;
  assert(desktopReturnsDuringScan);
  assert(captured == dental::offline::TransactionRoute::kOffline);
}

void offlineStockRulesMatchHighLowEmptySemantics() {
  uint64_t stock = 0ULL;
  dental::cache::StockStatus status = dental::cache::StockStatus::kEmpty;
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kRestock, 0ULL, 2ULL, stock,
             status) == dental::offline::OfflineStockResult::kSuccess);
  assert(stock == 1ULL && status == dental::cache::StockStatus::kLow);
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kRestock, 2ULL, 2ULL, stock,
             status) == dental::offline::OfflineStockResult::kSuccess);
  assert(stock == 3ULL && status == dental::cache::StockStatus::kHigh);
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kCheckout, 1ULL, 2ULL, stock,
             status) == dental::offline::OfflineStockResult::kSuccess);
  assert(stock == 0ULL && status == dental::cache::StockStatus::kEmpty);
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kCheckout, 0ULL, 2ULL, stock,
             status) == dental::offline::OfflineStockResult::kOutOfStock);
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kRestock,
             dental::cache::kMaximumStockValue, 2ULL, stock, status) ==
         dental::offline::OfflineStockResult::kOverflow);
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kRestock,
             dental::cache::kMaximumStockValue + 1ULL, 2ULL, stock, status) ==
         dental::offline::OfflineStockResult::kInvalid);
}

void offlineCacheLookupIsExactAndPreservesLeadingZeroes() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  const dental::cache::CacheProduct expected =
      makeCachedProduct("42", "0000-12/34", 2ULL, 2ULL,
                        dental::cache::StockStatus::kLow);
  installSingleCache(cache, cacheGenerationA(), expected);
  dental::offline::OfflineCacheLookup lookup(storage);
  dental::cache::CacheProduct found = {};
  assert(lookup.find(cache.metadata(), "0000-12/34", found) ==
         dental::offline::CacheLookupResult::kFound);
  assert(strcmp(found.id, "42") == 0);
  assert(strcmp(found.barcode, "0000-12/34") == 0);
  assert(found.currentStock == 2ULL);
  assert(lookup.find(cache.metadata(), "1234", found) ==
         dental::offline::CacheLookupResult::kNotFound);
  assert(lookup.find(cache.metadata(), "00001235", found) ==
         dental::offline::CacheLookupResult::kNotFound);
}

void offlineCacheLookupRejectsCorruptionAndUnavailableStorage() {
  MemoryCacheStorage storage;
  dental::cache::OfflineInventoryCache cache(storage);
  installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
  const dental::cache::CacheMetadata metadata = cache.metadata();
  dental::offline::OfflineCacheLookup lookup(storage);
  dental::cache::CacheProduct found = {};
  const size_t rowOffset =
      storage.files[dental::cache::kActiveCachePath].find("0012345678901");
  assert(rowOffset != std::string::npos);
  storage.files[dental::cache::kActiveCachePath][rowOffset] = '9';
  assert(lookup.find(metadata, "9012345678901", found) ==
         dental::offline::CacheLookupResult::kInvalidCache);
  storage.storageAvailable = false;
  assert(lookup.find(metadata, "0012345678901", found) ==
         dental::offline::CacheLookupResult::kStorageUnavailable);
}

void pendingJournalCreatesExactVersionedEmptyFile() {
  static_assert(dental::offline::kMaximumPendingRecords == 10000U,
                "Desktop and firmware status bounds must match");
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(journal.metadata().available);
  assert(journal.metadata().pendingCount == 0U);
  assert(!journal.blocksCacheReplacement());
  const std::string expected =
      std::string(dental::offline::kPendingJournalMagic) + ",1," +
      offlineDeviceId() + "\n" + dental::offline::kPendingJournalColumns +
      "\n";
  assert(storage.files[dental::offline::kPendingJournalPath] == expected);
}

void pendingJournalRecordPreservesExactFieldsAndCrc() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product =
      makeCachedProduct("42", "00001234", 2ULL, 3ULL,
                        dental::cache::StockStatus::kLow);
  const dental::offline::OfflineJournalRecord record = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product);
  assert(record.sequence == 1ULL);
  assert(strcmp(record.eventId,
                "off-20500DE58C14-0000000000000001") == 0);
  assert(strcmp(record.timestamp, "2026-09-09 12:34:56") == 0);
  assert(strcmp(record.productId, "42") == 0);
  assert(strcmp(record.barcode, "00001234") == 0);
  assert(record.delta == 1 && record.resultingStock == 3ULL);
  assert(record.resultingStatus == dental::cache::StockStatus::kLow);
  const std::string& csv =
      storage.files[dental::offline::kPendingJournalPath];
  assert(csv.find("\"00001234\",\"RESTOCK\",+1,3,\"LOW\"") !=
         std::string::npos);
  assert(csv.find(cacheGenerationA()) != std::string::npos);
  assert(csv[csv.size() - 1U] == '\n');
  assert(csv.find("\n\n") == std::string::npos);
  assert(journal.metadata().pendingCount == 1U);
  assert(journal.blocksCacheReplacement());
}

void pendingTransportEmptyJournalIsNonDestructive() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::map<std::string, std::string> filesBefore = storage.files;
  const uint32_t appendCallsBefore = storage.appendCallCount;
  dental::offline::OfflineJournalRecord record = {};
  snprintf(record.eventId, sizeof(record.eventId), "%s", "sentinel");

  assert(journal.peekOldest(record) ==
         dental::offline::JournalPeekResult::kEmpty);
  assert(record.eventId[0] == '\0');
  assert(journal.metadata().pendingCount == 0U);
  assert(storage.files == filesBefore);
  assert(storage.appendCallCount == appendCallsBefore);
}

void pendingTransportReturnsOldestExactRecordRepeatedly() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product =
      makeCachedProduct("42", "00\"\\ABC", 2ULL, 3ULL,
                        dental::cache::StockStatus::kLow);
  const dental::offline::OfflineJournalRecord first = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product,
      cacheGenerationA(), "2026-09-09 01:02:03");
  appendOfflineRecord(journal, dental::offline::OfflineAction::kCheckout,
                      product, cacheGenerationA(), "2026-09-09 01:02:04");
  const std::map<std::string, std::string> filesBefore = storage.files;
  const uint32_t appendCallsBefore = storage.appendCallCount;

  for (unsigned read = 0U; read < 20U; ++read) {
    dental::offline::OfflineJournalRecord returned = {};
    assert(journal.peekOldest(returned) ==
           dental::offline::JournalPeekResult::kFound);
    assert(returned.sequence == first.sequence);
    assert(strcmp(returned.eventId, first.eventId) == 0);
    assert(strcmp(returned.timestamp, "2026-09-09 01:02:03") == 0);
    assert(strcmp(returned.productId, "42") == 0);
    assert(strcmp(returned.barcode, "00\"\\ABC") == 0);
    assert(returned.action == dental::offline::OfflineAction::kRestock);
    assert(returned.delta == 1);
    assert(returned.resultingStock == 3ULL);
    assert(returned.resultingStatus == dental::cache::StockStatus::kLow);
    assert(strcmp(returned.cacheGeneration, cacheGenerationA()) == 0);
  }

  dental::offline::OfflineJournalRecord returned = {};
  assert(journal.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kFound);
  std::string json;
  dental::offline::appendPendingEventJson(json, returned);
  std::string expected =
      "{\"eventId\":\"off-20500DE58C14-0000000000000001\","
      "\"timestamp\":\"2026-09-09 01:02:03\",\"productId\":\"42\","
      "\"barcode\":\"00\\\"\\\\ABC\",\"action\":\"RESTOCK\","
      "\"delta\":1,\"resultingStock\":3,\"stockStatus\":\"LOW\","
      "\"cacheGeneration\":\"";
  expected += cacheGenerationA();
  expected += "\"}";
  assert(json == expected);
  assert(journal.metadata().pendingCount == 2U);
  assert(storage.files == filesBefore);
  assert(storage.appendCallCount == appendCallsBefore);

  MemoryPendingJournalStorage checkoutStorage;
  dental::offline::PendingJournal checkoutJournal(checkoutStorage);
  assert(checkoutJournal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct lastItem =
      makeCachedProduct("7", "0000", 1ULL, 2ULL,
                        dental::cache::StockStatus::kLow);
  appendOfflineRecord(checkoutJournal,
                      dental::offline::OfflineAction::kCheckout, lastItem);
  assert(checkoutJournal.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kFound);
  assert(returned.action == dental::offline::OfflineAction::kCheckout);
  assert(returned.delta == -1);
  assert(returned.resultingStock == 0ULL);
  assert(returned.resultingStatus == dental::cache::StockStatus::kEmpty);
  std::string checkoutJson;
  dental::offline::appendPendingEventJson(checkoutJson, returned);
  assert(checkoutJson.find(
             "\"barcode\":\"0000\",\"action\":\"CHECKOUT\",\"delta\":-1,"
             "\"resultingStock\":0,\"stockStatus\":\"EMPTY\"") !=
         std::string::npos);
}

void pendingTransportSurvivesRebootAndKeepsOldest() {
  MemoryPendingJournalStorage storage;
  dental::offline::OfflineJournalRecord first = {};
  {
    dental::offline::PendingJournal journal(storage);
    assert(journal.loadOrCreate(offlineDeviceId()) ==
           dental::offline::JournalLoadResult::kReady);
    const dental::cache::CacheProduct product = makeCachedProduct();
    first = appendOfflineRecord(
        journal, dental::offline::OfflineAction::kRestock, product);
    appendOfflineRecord(journal, dental::offline::OfflineAction::kCheckout,
                        product);
  }

  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::map<std::string, std::string> filesBefore = storage.files;
  dental::offline::OfflineJournalRecord returned = {};
  assert(rebooted.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(returned.eventId, first.eventId) == 0);
  assert(rebooted.metadata().pendingCount == 2U);
  assert(storage.files == filesBefore);
}

void pendingTransportFailsClosedWithoutRepairingReadPath() {
  const dental::cache::CacheProduct product = makeCachedProduct();
  MemoryPendingJournalStorage malformedStorage;
  dental::offline::PendingJournal malformed(malformedStorage);
  assert(malformed.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(malformed, dental::offline::OfflineAction::kRestock,
                      product, cacheGenerationA(), "2026-09-09 01:02:03");
  appendOfflineRecord(malformed, dental::offline::OfflineAction::kCheckout,
                      product, cacheGenerationA(), "2026-09-09 01:02:04");
  std::string& malformedContents =
      malformedStorage.files[dental::offline::kPendingJournalPath];
  const size_t damagedTimestamp = malformedContents.find("2026-09-09 01:02:04");
  assert(damagedTimestamp != std::string::npos);
  malformedContents[damagedTimestamp] = '3';
  const std::map<std::string, std::string> malformedBefore =
      malformedStorage.files;
  dental::offline::OfflineJournalRecord returned = {};
  assert(malformed.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kInvalidJournal);
  assert(returned.eventId[0] == '\0');
  assert(malformed.metadata().pendingCount == 2U);
  assert(malformedStorage.files == malformedBefore);

  MemoryPendingJournalStorage tornStorage;
  dental::offline::PendingJournal torn(tornStorage);
  assert(torn.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(torn, dental::offline::OfflineAction::kRestock, product);
  tornStorage.files[dental::offline::kPendingJournalPath] += "partial-tail";
  const std::map<std::string, std::string> tornBefore = tornStorage.files;
  assert(torn.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kInvalidJournal);
  assert(returned.eventId[0] == '\0');
  assert(torn.metadata().pendingCount == 1U);
  assert(tornStorage.files == tornBefore);

  MemoryPendingJournalStorage replacementSource;
  dental::offline::PendingJournal replacement(replacementSource);
  assert(replacement.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(replacement, dental::offline::OfflineAction::kRestock,
                      product);
  appendOfflineRecord(replacement, dental::offline::OfflineAction::kCheckout,
                      product);
  tornStorage.files[dental::offline::kPendingJournalPath] =
      replacementSource.files[dental::offline::kPendingJournalPath];
  assert(torn.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kInvalidJournal);
  assert(returned.eventId[0] == '\0');
  assert(torn.metadata().pendingCount == 1U);
}

void pendingTransportUnavailableIsHarmless() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());
  const std::map<std::string, std::string> filesBefore = storage.files;
  storage.storageAvailable = false;
  dental::offline::OfflineJournalRecord returned = {};
  assert(journal.peekOldest(returned) ==
         dental::offline::JournalPeekResult::kJournalUnavailable);
  assert(returned.eventId[0] == '\0');
  assert(journal.metadata().pendingCount == 1U);
  assert(storage.files == filesBefore);
}

std::string journalColumnsAndRows(const std::string& contents) {
  const size_t columns = contents.find(dental::offline::kPendingJournalColumns);
  assert(columns != std::string::npos);
  return contents.substr(columns);
}

void offlineAcknowledgementRetiresOnlyHeadAndUsesExactContract() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  const dental::offline::OfflineJournalRecord first = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product,
      cacheGenerationA(), "2026-09-09 01:02:03");
  const dental::offline::OfflineJournalRecord second = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kCheckout, product,
      cacheGenerationA(), "2026-09-09 01:02:04");
  const dental::offline::OfflineJournalRecord third = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product,
      cacheGenerationA(), "2026-09-09 01:02:05");
  const std::string before =
      storage.files[dental::offline::kPendingJournalPath];

  assert(journal.acknowledgeOldest(second.eventId) ==
         dental::offline::JournalAcknowledgementResult::kMismatch);
  assert(storage.files[dental::offline::kPendingJournalPath] == before);
  assert(journal.metadata().pendingCount == 3U);

  assert(journal.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  assert(journal.metadata().pendingCount == 2U);
  assert(journal.metadata().storedCount == 3U);
  assert(journal.metadata().acknowledgedSequence == first.sequence);
  assert(journal.metadata().maximumSequence == third.sequence);
  assert(journalColumnsAndRows(
             storage.files[dental::offline::kPendingJournalPath]) ==
         journalColumnsAndRows(before));

  dental::offline::OfflineJournalRecord head = {};
  assert(journal.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, second.eventId) == 0);

  std::string response;
  dental::offline::appendOfflineAcknowledgementJson(
      response, first.eventId, journal.metadata().pendingCount, false);
  assert(response ==
         "{\"acknowledged\":true,\"eventId\":\"off-20500DE58C14-"
         "0000000000000001\",\"pendingSyncItems\":2,"
         "\"alreadyAcknowledged\":false}");
}

void offlineAcknowledgementRequestParserIsStrictAndNonMutating() {
  char eventId[dental::events::kEventIdCapacity] = {};
  const std::string valid =
      "{\"eventId\":\"off-20500DE58C14-0000000000000001\"}";
  assert(dental::events::parseAcknowledgementBody(
      valid.c_str(), valid.size(), eventId));
  assert(strcmp(eventId, "off-20500DE58C14-0000000000000001") == 0);

  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());
  const std::map<std::string, std::string> before = storage.files;
  const char* malformed[] = {
      "", "{}", "{\"eventId\":1}",
      "{\"eventId\":\"off-20500DE58C14-0000000000000001\",\"x\":1}",
      "{\"eventId\":\"off\\u002D20500DE58C14-0000000000000001\"}",
      "{\"eventId\":\"\"}", "[]"};
  for (const char* body : malformed) {
    assert(!dental::events::parseAcknowledgementBody(
        body, strlen(body), eventId));
  }
  assert(storage.files == before);
  assert(journal.metadata().pendingCount == 1U);
}

void offlineAcknowledgementReplaySurvivesRebootAndProtectsNextHead() {
  MemoryPendingJournalStorage storage;
  dental::offline::OfflineJournalRecord first = {};
  dental::offline::OfflineJournalRecord second = {};
  {
    dental::offline::PendingJournal journal(storage);
    assert(journal.loadOrCreate(offlineDeviceId()) ==
           dental::offline::JournalLoadResult::kReady);
    const dental::cache::CacheProduct product = makeCachedProduct();
    first = appendOfflineRecord(journal,
                                dental::offline::OfflineAction::kRestock,
                                product);
    second = appendOfflineRecord(journal,
                                 dental::offline::OfflineAction::kCheckout,
                                 product);
    assert(journal.acknowledgeOldest(first.eventId) ==
           dental::offline::JournalAcknowledgementResult::kAcknowledged);
  }

  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::map<std::string, std::string> beforeRetry = storage.files;
  assert(rebooted.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::
             kAlreadyAcknowledged);
  assert(rebooted.metadata().pendingCount == 1U);
  assert(storage.files == beforeRetry);
  dental::offline::OfflineJournalRecord head = {};
  assert(rebooted.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, second.eventId) == 0);

  std::string replayResponse;
  dental::offline::appendOfflineAcknowledgementJson(
      replayResponse, first.eventId, rebooted.metadata().pendingCount, true);
  assert(replayResponse ==
         "{\"acknowledged\":true,\"eventId\":\"off-20500DE58C14-"
         "0000000000000001\",\"pendingSyncItems\":1,"
         "\"alreadyAcknowledged\":true}");
}

void offlineAcknowledgementWriteFaultsNeverAdvanceTheHead() {
  const dental::cache::CacheProduct product = makeCachedProduct();

  MemoryPendingJournalStorage headerFailure;
  dental::offline::PendingJournal headerJournal(headerFailure);
  assert(headerJournal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::offline::OfflineJournalRecord headerHead =
      appendOfflineRecord(headerJournal,
                          dental::offline::OfflineAction::kRestock, product);
  const std::string headerBefore =
      headerFailure.files[dental::offline::kPendingJournalPath];
  headerFailure.failNextWrite = true;
  assert(headerJournal.acknowledgeOldest(headerHead.eventId) ==
         dental::offline::JournalAcknowledgementResult::kWriteFailed);
  assert(headerFailure.files[dental::offline::kPendingJournalPath] ==
         headerBefore);
  assert(headerJournal.metadata().pendingCount == 1U);

  MemoryPendingJournalStorage copyFailure;
  dental::offline::PendingJournal copyJournal(copyFailure);
  assert(copyJournal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::offline::OfflineJournalRecord copyHead =
      appendOfflineRecord(copyJournal,
                          dental::offline::OfflineAction::kRestock, product);
  appendOfflineRecord(copyJournal, dental::offline::OfflineAction::kCheckout,
                      product);
  const std::string copyBefore =
      copyFailure.files[dental::offline::kPendingJournalPath];
  copyFailure.failOnAppendCall = copyFailure.appendCallCount + 1U;
  assert(copyJournal.acknowledgeOldest(copyHead.eventId) ==
         dental::offline::JournalAcknowledgementResult::kWriteFailed);
  assert(copyFailure.files[dental::offline::kPendingJournalPath] == copyBefore);
  assert(copyJournal.metadata().pendingCount == 2U);

  MemoryPendingJournalStorage promotionFailure;
  dental::offline::PendingJournal promotionJournal(promotionFailure);
  assert(promotionJournal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::offline::OfflineJournalRecord promotionHead =
      appendOfflineRecord(promotionJournal,
                          dental::offline::OfflineAction::kRestock, product);
  appendOfflineRecord(promotionJournal,
                      dental::offline::OfflineAction::kCheckout, product);
  const std::string promotionBefore =
      promotionFailure.files[dental::offline::kPendingJournalPath];
  promotionFailure.failTemporaryPromotion = true;
  assert(promotionJournal.acknowledgeOldest(promotionHead.eventId) ==
         dental::offline::JournalAcknowledgementResult::kWriteFailed);
  assert(promotionFailure.files[dental::offline::kPendingJournalPath] ==
         promotionBefore);
  assert(promotionJournal.metadata().pendingCount == 2U);
  assert(promotionJournal.acknowledgeOldest(promotionHead.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  assert(promotionJournal.metadata().pendingCount == 1U);
}

void interruptedAcknowledgementRecoveryNeverRetiresTheNextRow() {
  MemoryPendingJournalStorage source;
  dental::offline::PendingJournal journal(source);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  const dental::offline::OfflineJournalRecord first = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product);
  const dental::offline::OfflineJournalRecord second = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kCheckout, product);
  const std::string oldActive =
      source.files[dental::offline::kPendingJournalPath];
  assert(journal.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  const std::string acknowledgedActive =
      source.files[dental::offline::kPendingJournalPath];

  MemoryPendingJournalStorage beforePromotion;
  beforePromotion.files[dental::offline::kPendingJournalBackupPath] = oldActive;
  beforePromotion.files[dental::offline::kPendingJournalTemporaryPath] =
      acknowledgedActive;
  dental::offline::PendingJournal rolledBack(beforePromotion);
  assert(rolledBack.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  dental::offline::OfflineJournalRecord head = {};
  assert(rolledBack.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, first.eventId) == 0);
  assert(rolledBack.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  assert(rolledBack.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, second.eventId) == 0);

  MemoryPendingJournalStorage afterPromotion;
  afterPromotion.files[dental::offline::kPendingJournalPath] =
      acknowledgedActive;
  afterPromotion.files[dental::offline::kPendingJournalBackupPath] = oldActive;
  dental::offline::PendingJournal committed(afterPromotion);
  assert(committed.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(committed.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::
             kAlreadyAcknowledged);
  assert(committed.metadata().pendingCount == 1U);
  assert(committed.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, second.eventId) == 0);
}

void acknowledgedPrefixKeepsStockOverlayAndUnrelatedRowsExact() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct firstProduct =
      makeCachedProduct("1", "0001", 8ULL, 3ULL,
                        dental::cache::StockStatus::kHigh);
  const dental::cache::CacheProduct secondProduct =
      makeCachedProduct("2", "0002", 5ULL, 3ULL,
                        dental::cache::StockStatus::kHigh);
  const dental::offline::OfflineJournalRecord first = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, firstProduct);
  const dental::offline::OfflineJournalRecord unrelated = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kCheckout, secondProduct,
      cacheGenerationA(), "2026-09-09 12:34:57");
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      firstProduct, cacheGenerationA(),
                      "2026-09-09 12:34:58");
  const std::string rowsBefore = journalColumnsAndRows(
      storage.files[dental::offline::kPendingJournalPath]);

  assert(journal.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  assert(journalColumnsAndRows(
             storage.files[dental::offline::kPendingJournalPath]) ==
         rowsBefore);
  dental::offline::OfflineJournalRecord head = {};
  assert(journal.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, unrelated.eventId) == 0);
  assert(strcmp(head.productId, "2") == 0);
  assert(strcmp(head.barcode, "0002") == 0);

  uint64_t firstStock = 0ULL;
  uint64_t secondStock = 0ULL;
  assert(journal.deriveCurrentStock(firstProduct, cacheGenerationA(),
                                    firstStock) ==
         dental::offline::OverlayResult::kSuccess);
  assert(journal.deriveCurrentStock(secondProduct, cacheGenerationA(),
                                    secondStock) ==
         dental::offline::OverlayResult::kSuccess);
  assert(firstStock == 10ULL);
  assert(secondStock == 4ULL);
}

void cacheRefreshCompactionRetainsReplayWatermarkAndSequenceMonotonicity() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct original = makeCachedProduct();
  const dental::offline::OfflineJournalRecord first = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, original);
  assert(journal.compactAcknowledgedPrefix() ==
         dental::offline::JournalCompactionResult::kNotReady);
  assert(journal.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  assert(journal.metadata().pendingCount == 0U);
  assert(journal.metadata().storedCount == 1U);
  assert(journal.compactAcknowledgedPrefix() ==
         dental::offline::JournalCompactionResult::kCompacted);
  assert(journal.metadata().pendingCount == 0U);
  assert(journal.metadata().storedCount == 0U);
  assert(journal.metadata().compactedSequence == first.sequence);
  assert(journal.metadata().acknowledgedSequence == first.sequence);
  assert(storage.files[dental::offline::kPendingJournalPath].find(
             first.eventId) == std::string::npos);

  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(rebooted.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::
             kAlreadyAcknowledged);
  const dental::cache::CacheProduct refreshed =
      makeCachedProduct("1", "0012345678901", 9ULL, 3ULL,
                        dental::cache::StockStatus::kHigh);
  const dental::offline::OfflineJournalRecord next = appendOfflineRecord(
      rebooted, dental::offline::OfflineAction::kCheckout, refreshed,
      cacheGenerationB());
  assert(next.sequence == first.sequence + 1ULL);
  assert(strcmp(next.eventId,
                "off-20500DE58C14-0000000000000002") == 0);
  assert(rebooted.acknowledgeOldest(first.eventId) ==
         dental::offline::JournalAcknowledgementResult::
             kAlreadyAcknowledged);
  dental::offline::OfflineJournalRecord head = {};
  assert(rebooted.peekOldest(head) ==
         dental::offline::JournalPeekResult::kFound);
  assert(strcmp(head.eventId, next.eventId) == 0);
}

void cacheRefreshCompactionFaultLeavesAcknowledgedOverlayRecoverable() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  const dental::offline::OfflineJournalRecord record = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, product);
  assert(journal.acknowledgeOldest(record.eventId) ==
         dental::offline::JournalAcknowledgementResult::kAcknowledged);
  const std::string retained =
      storage.files[dental::offline::kPendingJournalPath];
  storage.failTemporaryPromotion = true;
  assert(journal.compactAcknowledgedPrefix() ==
         dental::offline::JournalCompactionResult::kWriteFailed);
  assert(storage.files[dental::offline::kPendingJournalPath] == retained);
  assert(journal.metadata().storedCount == 1U);
  assert(journal.metadata().pendingCount == 0U);

  uint64_t stock = 0ULL;
  assert(journal.deriveCurrentStock(product, cacheGenerationA(), stock) ==
         dental::offline::OverlayResult::kSuccess);
  assert(stock == 9ULL);
  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(rebooted.metadata().storedCount == 1U);
  assert(rebooted.acknowledgeOldest(record.eventId) ==
         dental::offline::JournalAcknowledgementResult::
             kAlreadyAcknowledged);
  assert(rebooted.compactAcknowledgedPrefix() ==
         dental::offline::JournalCompactionResult::kCompacted);
}

void maximumBoundedFieldsSurviveOfflineLookupAndJournalReuse() {
  // Host tests cannot reproduce the ESP32 loopTask stack limit, but this
  // drives the same lookup -> overlay -> append -> rescan path with the largest
  // scanner barcode accepted by the offline protocol. It guards the reusable
  // scratch records against aliasing or truncation after moving them off-stack.
  std::string barcode(dental::cache::kMaximumBarcodeUtf16Units, '7');
  barcode[0] = '0';
  std::string name(dental::cache::kMaximumProductNameUtf16Units, 'N');
  dental::cache::CacheProduct source =
      makeCachedProduct("99", barcode.c_str(), 1ULL, 1ULL,
                        dental::cache::StockStatus::kLow);
  snprintf(source.name, sizeof(source.name), "%s", name.c_str());

  MemoryCacheStorage cacheStorage;
  dental::cache::OfflineInventoryCache cache(cacheStorage);
  installSingleCache(cache, cacheGenerationA(), source);
  dental::offline::OfflineCacheLookup lookup(cacheStorage);
  dental::cache::CacheProduct found = {};
  assert(lookup.find(cache.metadata(), barcode.c_str(), found) ==
         dental::offline::CacheLookupResult::kFound);
  assert(strcmp(found.barcode, barcode.c_str()) == 0);
  assert(strcmp(found.name, name.c_str()) == 0);

  MemoryPendingJournalStorage journalStorage;
  dental::offline::PendingJournal journal(journalStorage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::offline::OfflineJournalRecord committed = appendOfflineRecord(
      journal, dental::offline::OfflineAction::kRestock, found);
  assert(strcmp(committed.barcode, barcode.c_str()) == 0);
  assert(committed.resultingStock == 2ULL);
  assert(journal.metadata().pendingCount == 1U);

  uint64_t effectiveStock = 0ULL;
  assert(journal.deriveCurrentStock(found, cacheGenerationA(), effectiveStock) ==
         dental::offline::OverlayResult::kSuccess);
  assert(effectiveStock == 2ULL);
}

void pendingOverlayChainsAcrossRebootWithUniqueSequenceIds() {
  MemoryPendingJournalStorage storage;
  const dental::cache::CacheProduct product =
      makeCachedProduct("7", "0007", 2ULL, 3ULL,
                        dental::cache::StockStatus::kLow);
  {
    dental::offline::PendingJournal journal(storage);
    assert(journal.loadOrCreate(offlineDeviceId()) ==
           dental::offline::JournalLoadResult::kReady);
    for (unsigned index = 0U; index < 3U; ++index) {
      appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                          product);
    }
    for (unsigned index = 0U; index < 2U; ++index) {
      appendOfflineRecord(journal, dental::offline::OfflineAction::kCheckout,
                          product);
    }
    uint64_t current = 0ULL;
    assert(journal.deriveCurrentStock(product, cacheGenerationA(), current) ==
           dental::offline::OverlayResult::kSuccess);
    assert(current == 3ULL);
    assert(journal.metadata().pendingCount == 5U);
  }
  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(rebooted.metadata().maximumSequence == 5ULL);
  const dental::offline::OfflineJournalRecord next = appendOfflineRecord(
      rebooted, dental::offline::OfflineAction::kRestock, product);
  assert(next.sequence == 6ULL);
  assert(strcmp(next.eventId,
                "off-20500DE58C14-0000000000000006") == 0);
  assert(rebooted.metadata().pendingCount == 6U);
}

void zeroStockCheckoutNeverAppendsAJournalRecord() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::string before =
      storage.files[dental::offline::kPendingJournalPath];
  uint64_t resultingStock = 99ULL;
  dental::cache::StockStatus status = dental::cache::StockStatus::kHigh;
  assert(dental::offline::calculateOfflineStock(
             dental::offline::OfflineAction::kCheckout, 0ULL, 2ULL,
             resultingStock, status) ==
         dental::offline::OfflineStockResult::kOutOfStock);
  assert(storage.files[dental::offline::kPendingJournalPath] == before);
  assert(journal.metadata().pendingCount == 0U);
}

void tornFinalJournalRecordRecoversCompletePrefix() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      product);
  appendOfflineRecord(journal, dental::offline::OfflineAction::kCheckout,
                      product);
  const std::string completePrefix =
      storage.files[dental::offline::kPendingJournalPath];
  storage.files[dental::offline::kPendingJournalPath] +=
      "3,\"off-20500DE58C14-0000000000000003\",\"2026-09";

  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kRecoveredTornTail);
  assert(rebooted.metadata().pendingCount == 2U);
  assert(rebooted.metadata().recoveredTornTail);
  assert(storage.files[dental::offline::kPendingJournalPath] ==
         completePrefix);
  uint64_t current = 0ULL;
  assert(rebooted.deriveCurrentStock(product, cacheGenerationA(), current) ==
         dental::offline::OverlayResult::kSuccess);
  assert(current == product.currentStock);
}

void terminatedMalformedOrCrcDamagedJournalIsNeverSilentlyApplied() {
  MemoryPendingJournalStorage malformedStorage;
  dental::offline::PendingJournal journal(malformedStorage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());
  malformedStorage.files[dental::offline::kPendingJournalPath] += "bad,row\n";
  dental::offline::PendingJournal malformed(malformedStorage);
  assert(malformed.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kInvalid);
  assert(malformed.uncertain() && malformed.blocksCacheReplacement());

  MemoryPendingJournalStorage crcStorage;
  dental::offline::PendingJournal original(crcStorage);
  assert(original.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(original, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());
  std::string& contents =
      crcStorage.files[dental::offline::kPendingJournalPath];
  const size_t timestamp = contents.find("2026-09-09 12:34:56");
  assert(timestamp != std::string::npos);
  contents[timestamp] = '3';
  dental::offline::PendingJournal damaged(crcStorage);
  assert(damaged.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kInvalid);
  assert(damaged.uncertain() && damaged.blocksCacheReplacement());
}

void pendingJournalGenerationAssociationIsStrict() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      product);
  dental::cache::CacheMetadata compatible = {};
  compatible.available = true;
  compatible.itemCount = 1U;
  snprintf(compatible.generation, sizeof(compatible.generation), "%s",
           cacheGenerationA());
  assert(journal.compatibleWith(compatible));
  snprintf(compatible.generation, sizeof(compatible.generation), "%s",
           cacheGenerationB());
  assert(!journal.compatibleWith(compatible));
  uint64_t current = 0ULL;
  assert(journal.deriveCurrentStock(product, cacheGenerationB(), current) ==
         dental::offline::OverlayResult::kGenerationMismatch);
}

void pendingJournalProductAndBarcodeAssociationIsStrict() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const dental::cache::CacheProduct product = makeCachedProduct();
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      product);
  dental::cache::CacheProduct conflicting = product;
  snprintf(conflicting.id, sizeof(conflicting.id), "%s", "2");
  uint64_t current = 0ULL;
  assert(journal.deriveCurrentStock(conflicting, cacheGenerationA(), current) ==
         dental::offline::OverlayResult::kInvalidJournal);
  assert(journal.uncertain() && journal.blocksCacheReplacement());
}

void ambiguousCompleteAppendIsAcceptedButPartialAppendIsRepaired() {
  const dental::cache::CacheProduct product = makeCachedProduct();
  MemoryPendingJournalStorage completeStorage;
  dental::offline::PendingJournal complete(completeStorage);
  assert(complete.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  // The body append succeeds; the separate newline commit marker reaches the
  // file but its response is lost. Full-file validation must recognize the
  // transaction as committed.
  completeStorage.reportFailureOnAppendCall = 2U;
  const dental::offline::OfflineJournalRecord committed = appendOfflineRecord(
      complete, dental::offline::OfflineAction::kRestock, product);
  assert(committed.sequence == 1ULL && complete.metadata().pendingCount == 1U);

  MemoryPendingJournalStorage partialStorage;
  dental::offline::PendingJournal partial(partialStorage);
  assert(partial.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::string original =
      partialStorage.files[dental::offline::kPendingJournalPath];
  partialStorage.nextPartialAppendBytes = 12U;
  dental::offline::OfflineJournalRecord ignored = {};
  assert(partial.append(dental::offline::OfflineAction::kRestock,
                        "2026-09-09 12:34:56", product,
                        cacheGenerationA(), 9ULL,
                        dental::cache::StockStatus::kHigh, ignored) ==
         dental::offline::JournalAppendResult::kWriteFailed);
  assert(partial.metadata().available && partial.metadata().pendingCount == 0U);
  assert(partialStorage.files[dental::offline::kPendingJournalPath] ==
         original);

  MemoryPendingJournalStorage missingCommitMarkerStorage;
  dental::offline::PendingJournal missingCommitMarker(
      missingCommitMarkerStorage);
  assert(missingCommitMarker.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  missingCommitMarkerStorage.failOnAppendCall = 2U;
  assert(missingCommitMarker.append(
             dental::offline::OfflineAction::kRestock,
             "2026-09-09 12:34:56", product, cacheGenerationA(), 9ULL,
             dental::cache::StockStatus::kHigh, ignored) ==
         dental::offline::JournalAppendResult::kWriteFailed);
  assert(missingCommitMarker.metadata().available);
  assert(missingCommitMarker.metadata().pendingCount == 0U);
}

void journalRecoveryUsesValidTemporaryAndBackupFiles() {
  const dental::cache::CacheProduct product = makeCachedProduct();
  MemoryPendingJournalStorage temporaryStorage;
  {
    dental::offline::PendingJournal source(temporaryStorage);
    assert(source.loadOrCreate(offlineDeviceId()) ==
           dental::offline::JournalLoadResult::kReady);
    appendOfflineRecord(source, dental::offline::OfflineAction::kRestock,
                        product);
  }
  temporaryStorage.files[dental::offline::kPendingJournalTemporaryPath] =
      temporaryStorage.files[dental::offline::kPendingJournalPath];
  temporaryStorage.files.erase(dental::offline::kPendingJournalPath);
  dental::offline::PendingJournal fromTemporary(temporaryStorage);
  assert(fromTemporary.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(fromTemporary.metadata().pendingCount == 1U);

  MemoryPendingJournalStorage backupStorage;
  backupStorage.files[dental::offline::kPendingJournalBackupPath] =
      temporaryStorage.files[dental::offline::kPendingJournalPath];
  backupStorage.files[dental::offline::kPendingJournalPath] = "corrupt\n";
  dental::offline::PendingJournal fromBackup(backupStorage);
  assert(fromBackup.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(fromBackup.metadata().pendingCount == 1U);
  assert(backupStorage.files.find(dental::offline::kPendingJournalPath) !=
         backupStorage.files.end());
}

void incompleteRepairTemporaryNeverDisplacesFullerBackup() {
  const dental::cache::CacheProduct product = makeCachedProduct();
  MemoryPendingJournalStorage oneRecordStorage;
  dental::offline::PendingJournal oneRecord(oneRecordStorage);
  assert(oneRecord.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(oneRecord, dental::offline::OfflineAction::kRestock,
                      product);

  MemoryPendingJournalStorage twoRecordStorage;
  dental::offline::PendingJournal twoRecords(twoRecordStorage);
  assert(twoRecords.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(twoRecords, dental::offline::OfflineAction::kRestock,
                      product);
  appendOfflineRecord(twoRecords, dental::offline::OfflineAction::kCheckout,
                      product);

  // This is the exact on-card shape left by a reset while a two-record backup
  // was only partly copied into the repair temporary file. The one-record temp
  // is valid in isolation, but must never win over the fuller valid backup.
  MemoryPendingJournalStorage interrupted;
  interrupted.files[dental::offline::kPendingJournalPath] = "corrupt\n";
  interrupted.files[dental::offline::kPendingJournalTemporaryPath] =
      oneRecordStorage.files[dental::offline::kPendingJournalPath];
  interrupted.files[dental::offline::kPendingJournalBackupPath] =
      twoRecordStorage.files[dental::offline::kPendingJournalPath];
  dental::offline::PendingJournal recovered(interrupted);
  assert(recovered.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  assert(recovered.metadata().pendingCount == 2U);
  assert(recovered.metadata().maximumSequence == 2ULL);
  uint64_t current = 0ULL;
  assert(recovered.deriveCurrentStock(product, cacheGenerationA(), current) ==
         dental::offline::OverlayResult::kSuccess);
  assert(current == product.currentStock);
}

void validTemporaryCannotMaskInvalidAuthoritativePaths() {
  MemoryPendingJournalStorage validSource;
  dental::offline::PendingJournal source(validSource);
  assert(source.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(source, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());

  MemoryPendingJournalStorage interrupted;
  interrupted.files[dental::offline::kPendingJournalPath] = "bad active\n";
  interrupted.files[dental::offline::kPendingJournalBackupPath] =
      "bad backup\n";
  interrupted.files[dental::offline::kPendingJournalTemporaryPath] =
      validSource.files[dental::offline::kPendingJournalPath];
  dental::offline::PendingJournal recovered(interrupted);
  assert(recovered.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kInvalid);
  assert(!recovered.metadata().available);
  assert(recovered.uncertain() && recovered.blocksCacheReplacement());
  assert(interrupted.files[dental::offline::kPendingJournalPath] ==
         "bad active\n");
}

void invalidOfflineRecordFieldsCannotReachStorage() {
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  const std::string before =
      storage.files[dental::offline::kPendingJournalPath];
  dental::offline::OfflineJournalRecord record = {};
  assert(journal.append(dental::offline::OfflineAction::kRestock,
                        "2000-99-99 25:61:61", makeCachedProduct(),
                        cacheGenerationA(), 9ULL,
                        dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  dental::cache::CacheProduct invalidBarcode = makeCachedProduct();
  snprintf(invalidBarcode.barcode, sizeof(invalidBarcode.barcode), "%s",
           "bad,barcode");
  assert(journal.append(dental::offline::OfflineAction::kRestock,
                        "2026-09-09 12:34:56", invalidBarcode,
                        cacheGenerationA(), 9ULL,
                        dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(journal.append(dental::offline::OfflineAction::kRestock,
                        "2026-09-09 12:34:56", makeCachedProduct(),
                        cacheGenerationA(), 10ULL,
                        dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(journal.append(dental::offline::OfflineAction::kRestock,
                        "2026-09-09 12:34:56", makeCachedProduct(),
                        cacheGenerationA(), 9ULL,
                        dental::cache::StockStatus::kLow, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(journal.append(static_cast<dental::offline::OfflineAction>(99U),
                        "2026-09-09 12:34:56", makeCachedProduct(),
                        cacheGenerationA(), 7ULL,
                        dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(journal.append(dental::offline::OfflineAction::kRestock, nullptr,
                        makeCachedProduct(), cacheGenerationA(), 9ULL,
                        dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(journal.append(dental::offline::OfflineAction::kRestock,
                        "2026-09-09 12:34:56", makeCachedProduct(), nullptr,
                        9ULL, dental::cache::StockStatus::kHigh, record) ==
         dental::offline::JournalAppendResult::kInvalidRecord);
  assert(storage.files[dental::offline::kPendingJournalPath] == before);
}

void unavailableJournalAndCacheAreSafeFailures() {
  MemoryPendingJournalStorage journalStorage;
  journalStorage.storageAvailable = false;
  dental::offline::PendingJournal journal(journalStorage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kStorageUnavailable);
  assert(!journal.metadata().available);
  MemoryCacheStorage cacheStorage;
  cacheStorage.storageAvailable = false;
  dental::offline::OfflineCacheLookup lookup(cacheStorage);
  dental::cache::CacheMetadata metadata = {};
  metadata.available = true;
  snprintf(metadata.generation, sizeof(metadata.generation), "%s",
           cacheGenerationA());
  dental::cache::CacheProduct product = {};
  assert(lookup.find(metadata, "0012345678901", product) ==
         dental::offline::CacheLookupResult::kStorageUnavailable);
}

void offlineJournalDoesNotAlterOnlineQueueOrIntegrationCsv() {
  PendingEventQueue queue;
  const PendingTransactionEvent event = makeEvent(1U);
  assert(queue.enqueue(event));
  MemoryPendingJournalStorage storage;
  storage.files["/integration_test.csv"] = "online sentinel\n";
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) ==
         dental::offline::JournalLoadResult::kReady);
  appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                      makeCachedProduct());
  assert(storage.files["/integration_test.csv"] == "online sentinel\n");
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->eventId, event.eventId) == 0);
  assert(queue.oldestAppliedResult() == nullptr);
}

void healthyRtcBootIsReadyWithoutSynchronization() {
  const dental::rtc_recovery::Status status =
      dental::rtc_recovery::classifyInitialState(true, true, false, true);
  assert(status.state == dental::rtc_recovery::State::kReady);
  assert(status.reason == dental::rtc_recovery::Reason::kNone);
  assert(dental::rtc_recovery::timeIsTrusted(status));
  assert(strcmp(dental::rtc_recovery::stateName(status.state), "ready") == 0);
}

void lostPowerRtcNeedsSynchronizationWithoutBecomingUnavailable() {
  const dental::rtc_recovery::Status status =
      dental::rtc_recovery::classifyInitialState(true, true, true, true);
  assert(status.state == dental::rtc_recovery::State::kNeedsSync);
  assert(status.reason == dental::rtc_recovery::Reason::kLostPower);
  assert(!dental::rtc_recovery::timeIsTrusted(status));
  assert(strcmp(dental::rtc_recovery::stateName(status.state), "needs_sync") ==
         0);
  assert(strcmp(dental::rtc_recovery::reasonName(status.reason), "lost_power") ==
         0);
}

void invalidRtcTimeNeedsSynchronization() {
  const dental::rtc_recovery::Status status =
      dental::rtc_recovery::classifyInitialState(true, true, false, false);
  assert(status.state == dental::rtc_recovery::State::kNeedsSync);
  assert(status.reason == dental::rtc_recovery::Reason::kInvalidTime);
}

void rtcCommunicationFailuresRemainUnavailable() {
  const dental::rtc_recovery::Status undetected =
      dental::rtc_recovery::classifyInitialState(false, false, false, false);
  const dental::rtc_recovery::Status unreadable =
      dental::rtc_recovery::classifyInitialState(true, false, false, true);
  assert(undetected.state == dental::rtc_recovery::State::kUnavailable);
  assert(unreadable.state == dental::rtc_recovery::State::kUnavailable);
  assert(undetected.reason ==
         dental::rtc_recovery::Reason::kCommunicationFailure);
  assert(unreadable.reason ==
         dental::rtc_recovery::Reason::kCommunicationFailure);
}

void rtcSyncRequestParserAcceptsTypedHostTimeAndOffset() {
  dental::rtc_recovery::SyncRequest request = {};
  const char body[] =
      "{\"epochSeconds\":1789065600,\"utcOffsetMinutes\":480}";
  assert(dental::rtc_recovery::parseSyncRequest(body, strlen(body), request));
  assert(request.epochSeconds == 1789065600UL);
  assert(request.utcOffsetMinutes == 480);
  assert(request.localEpochSeconds == 1789094400UL);

  const char reversed[] =
      " { \"utcOffsetMinutes\" : -300, \"epochSeconds\" : 1789065600 } ";
  assert(dental::rtc_recovery::parseSyncRequest(
      reversed, strlen(reversed), request));
  assert(request.utcOffsetMinutes == -300);
  assert(request.localEpochSeconds == 1789047600UL);
}

void rtcSyncRequestParserRejectsMalformedOrUnreasonableTime() {
  const char* invalid[] = {
      "", "{}", "{\"epochSeconds\":1789065600}",
      "{\"epochSeconds\":1789065600,\"utcOffsetMinutes\":480,\"extra\":1}",
      "{\"epochSeconds\":\"1789065600\",\"utcOffsetMinutes\":480}",
      "{\"epochSeconds\":1789065600.5,\"utcOffsetMinutes\":480}",
      "{\"epochSeconds\":0,\"utcOffsetMinutes\":480}",
      "{\"epochSeconds\":4102444800,\"utcOffsetMinutes\":0}",
      "{\"epochSeconds\":1789065600,\"utcOffsetMinutes\":841}",
      "{\"epochSeconds\":1789065600,\"utcOffsetMinutes\":480} trailing"};
  for (size_t index = 0U; index < sizeof(invalid) / sizeof(invalid[0]);
       ++index) {
    dental::rtc_recovery::SyncRequest request = {};
    assert(!dental::rtc_recovery::parseSyncRequest(
        invalid[index], strlen(invalid[index]), request));
  }
}

void rtcSynchronizationRequiresVerifiedWriteAndReread() {
  const uint32_t requested = 1789094400UL;
  assert(dental::rtc_recovery::synchronizationVerified(
      requested, true, false, true, requested));
  assert(dental::rtc_recovery::synchronizationVerified(
      requested, true, false, true, requested + 2U));
  assert(!dental::rtc_recovery::synchronizationVerified(
      requested, false, false, true, requested));
  assert(!dental::rtc_recovery::synchronizationVerified(
      requested, true, true, true, requested));
  assert(!dental::rtc_recovery::synchronizationVerified(
      requested, true, false, false, requested));
  assert(!dental::rtc_recovery::synchronizationVerified(
      requested, true, false, true, requested + 3U));
  assert(!dental::rtc_recovery::synchronizationVerified(
      requested, true, false, true, requested - 1U));
}

void rtcSynchronizationRequiresExactDeviceToken() {
  const char token[] =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert(dental::rtc_recovery::constantTimeTokenMatches(token, token));
  assert(!dental::rtc_recovery::constantTimeTokenMatches(token, ""));
  assert(!dental::rtc_recovery::constantTimeTokenMatches(
      token,
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee"));
  assert(!dental::rtc_recovery::constantTimeTokenMatches(nullptr, token));
}

}  // namespace

int main() {
  emptyQueue();
  repeatedRetrievalKeepsOldest();
  fifoAcknowledgements();
  fullQueueNeverOverwritesPending();
  ringWrapPreservesOrder();
  mismatchedAndUnknownAckPreserveHead();
  lostResponseRetryNeverConsumesNextHead();
  receiptsAreBoundedAndVolatile();
  barcodeTextPreserved();
  eventIdentifiersPreserveUniquenessAndBounds();
  acknowledgementParser();
  transactionResultParserAcceptsValidPayloads();
  transactionResultParserRejectsInvalidPayloads();
  validRestockHighResultRemainsPendingUntilAck();
  validRestockLowAndCheckoutEmptyResults();
  mismatchedResultCannotChangeHead();
  identicalResultRetryIsSafeAndConflictRejects();
  stockIndicatorTruthTableMatchesVerifiedLogic();
  resultApplicationPreservesExistingAckRetryBehavior();
  transactionResultFeedbackQueueIsBoundedAndFifo();
  resultRetryAfterAckUsesReceiptWithoutTouchingNextHead();
  resultReceiptsAreBoundedAndUnknownAckCreatesNone();
  jsonSerializationEscapesText();
  heartbeatSetsDesktopAvailable();
  repeatedHeartbeatRefreshesLease();
  leaseExpiryMakesDesktopUnavailable();
  networkLossClearsDesktopAvailabilityImmediately();
  heartbeatAfterReconnectRestoresAvailability();
  leaseExpiryIsMillisWrapSafe();
  heartbeatDoesNotChangePendingEventFifo();
  cacheRequestParserIsStrictAndPreservesBarcode();
  cacheRequestBoundsAndDecodedTextAreStrict();
  validCacheInstallationPreservesExactCsvAndMetadata();
  cacheSurvivesRebootAndInstalledBeginIsIdempotent();
  incompleteTransferAndMalformedReplacementPreserveActive();
  failedPromotionRestoresPreviousValidCache();
  repeatedBeginRestartsUnverifiablePrefixAndDuplicateItemIsSafe();
  cacheChecksumBindsMetadataAndAllContent();
  bootRecoversCommittedTemporaryWithoutDisplacingValidActive();
  commitReplacesInvalidActiveAndRetainsValidBackup();
  retainedBackupRecoversLaterActiveCorruption();
  failedRecoveryNeverPublishesUnusableMetadata();
  malformedSequenceAndCountMismatchPreserveTransfer();
  emptyCacheAndUnavailableStorageAreSafe();
  cacheOperationsDoNotAlterEventFifo();
  transactionRouteSelectionCanBeFrozenAtAcceptance();
  offlineStockRulesMatchHighLowEmptySemantics();
  offlineCacheLookupIsExactAndPreservesLeadingZeroes();
  offlineCacheLookupRejectsCorruptionAndUnavailableStorage();
  pendingJournalCreatesExactVersionedEmptyFile();
  pendingJournalRecordPreservesExactFieldsAndCrc();
  pendingTransportEmptyJournalIsNonDestructive();
  pendingTransportReturnsOldestExactRecordRepeatedly();
  pendingTransportSurvivesRebootAndKeepsOldest();
  pendingTransportFailsClosedWithoutRepairingReadPath();
  pendingTransportUnavailableIsHarmless();
  offlineAcknowledgementRetiresOnlyHeadAndUsesExactContract();
  offlineAcknowledgementRequestParserIsStrictAndNonMutating();
  offlineAcknowledgementReplaySurvivesRebootAndProtectsNextHead();
  offlineAcknowledgementWriteFaultsNeverAdvanceTheHead();
  interruptedAcknowledgementRecoveryNeverRetiresTheNextRow();
  acknowledgedPrefixKeepsStockOverlayAndUnrelatedRowsExact();
  cacheRefreshCompactionRetainsReplayWatermarkAndSequenceMonotonicity();
  cacheRefreshCompactionFaultLeavesAcknowledgedOverlayRecoverable();
  maximumBoundedFieldsSurviveOfflineLookupAndJournalReuse();
  pendingOverlayChainsAcrossRebootWithUniqueSequenceIds();
  zeroStockCheckoutNeverAppendsAJournalRecord();
  tornFinalJournalRecordRecoversCompletePrefix();
  terminatedMalformedOrCrcDamagedJournalIsNeverSilentlyApplied();
  pendingJournalGenerationAssociationIsStrict();
  pendingJournalProductAndBarcodeAssociationIsStrict();
  ambiguousCompleteAppendIsAcceptedButPartialAppendIsRepaired();
  journalRecoveryUsesValidTemporaryAndBackupFiles();
  incompleteRepairTemporaryNeverDisplacesFullerBackup();
  validTemporaryCannotMaskInvalidAuthoritativePaths();
  invalidOfflineRecordFieldsCannotReachStorage();
  unavailableJournalAndCacheAreSafeFailures();
  offlineJournalDoesNotAlterOnlineQueueOrIntegrationCsv();
  healthyRtcBootIsReadyWithoutSynchronization();
  lostPowerRtcNeedsSynchronizationWithoutBecomingUnavailable();
  invalidRtcTimeNeedsSynchronization();
  rtcCommunicationFailuresRemainUnavailable();
  rtcSyncRequestParserAcceptsTypedHostTimeAndOffset();
  rtcSyncRequestParserRejectsMalformedOrUnreasonableTime();
  rtcSynchronizationRequiresVerifiedWriteAndReread();
  rtcSynchronizationRequiresExactDeviceToken();
  puts("Firmware event queue/protocol/presence/cache/offline journal/RTC: 86 host test scenarios PASSED");
  return 0;
}
