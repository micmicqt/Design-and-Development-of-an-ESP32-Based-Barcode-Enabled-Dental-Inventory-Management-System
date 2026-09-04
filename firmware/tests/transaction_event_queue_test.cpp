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
  jsonSerializationEscapesText();
  puts("Firmware event queue/protocol: 12 host test scenarios PASSED");
  return 0;
}
