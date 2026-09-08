#include "desktop_presence_lease.h"
#include "offline_inventory_cache.h"
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
  puts("Firmware event queue/protocol/presence/cache: 45 host test scenarios PASSED");
  return 0;
}
