#include "online_storage_policy.h"
#include "transaction_event_queue.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main() {
  using dental::storage_policy::modeMayStart;
  using dental::storage_policy::mayRecover;
  using dental::storage_policy::emitSectorTrace;
  using dental::events::PendingEventQueue;
  using dental::events::PendingTransactionEvent;

  // RESTOCK and CHECKOUT use the same route policy: online never gates on SD;
  // offline always does. RTC and cache/journal checks remain in the caller.
  for (unsigned action = 0U; action < 2U; ++action) {
    assert(modeMayStart(false, false));
    assert(modeMayStart(false, true));
    assert(!modeMayStart(true, false));
    assert(modeMayStart(true, true));
  }

  // Queuing an online scan has no storage dependency and does not duplicate it.
  PendingEventQueue queue;
  PendingTransactionEvent event = {};
  strcpy(event.eventId, "evt-test-1");
  strcpy(event.mode, "checkout");
  strcpy(event.barcode, "0012345678905");
  strcpy(event.timestamp, "2026-10-02 16:38:55");
  assert(queue.enqueue(event));
  assert(queue.size() == 1U);
  assert(strcmp(queue.oldest()->barcode, "0012345678905") == 0);
  assert(!mayRecover(true, queue.size(), 0U));
  assert(!mayRecover(false, queue.size(), 0U));
  assert(!mayRecover(false, 0U, 1U));
  assert(mayRecover(false, 0U, 0U));
  for (size_t index = 1U; index < dental::events::kQueueCapacity; ++index)
    assert(queue.enqueue(event));
  assert(queue.full() && !queue.enqueue(event));
  assert(queue.size() == dental::events::kQueueCapacity);

  assert(!emitSectorTrace(true, false));
  assert(emitSectorTrace(false, false));
  assert(emitSectorTrace(true, true));
  puts("Online storage/recovery/log policy: focused checks PASSED");
}
