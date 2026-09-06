#include "transaction_event_queue.h"

#include <assert.h>
#include <stdio.h>
#include <string>

using namespace dental::events;

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
  puts("Firmware event queue/protocol: 23 host test scenarios PASSED");
  return 0;
}
