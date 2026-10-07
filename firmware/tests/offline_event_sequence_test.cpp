#include "offline_event_sequence.h"
#include "offline_pending_journal.h"
#include <assert.h>
#include <set>
#include <stdio.h>

struct Store : dental::offline::EventSequenceStorage {
  uint64_t value = 0; bool present = false, failWrite = false, corruptReadback = false;
  bool read(uint64_t& out, bool& found) override { out = corruptReadback ? value - 1 : value; found = present; return true; }
  bool write(uint64_t next) override { if (failWrite) return false; value = next; present = true; return true; }
};
int main() {
  Store store; dental::offline::DurableEventSequence sequence(store);
  std::set<uint64_t> unique; uint64_t next;
  for (unsigned i = 0; i < 10000; ++i) {
    // Journal floor reset covers empty/recreated/recovered older journals;
    // reconstruct allocator every iteration to model reboot too.
    dental::offline::DurableEventSequence rebooted(store);
    assert(rebooted.reserve(i % 2 ? 0 : store.value, next));
    assert(next >= dental::offline::kFirstDurableEventSequence && unique.insert(next).second);
    char id[dental::offline::kOfflineEventIdCapacity];
    assert(dental::offline::formatOfflineEventId("148CE50D5020", next, id));
  }
  store.failWrite = true; assert(!sequence.reserve(0, next) && next == 0);
  store.failWrite = false; store.corruptReadback = true;
  assert(!sequence.reserve(0, next) && next == 0);
  store.corruptReadback = false; store.value = 1;
  assert(!sequence.reserve(0, next));
  store.value = UINT64_MAX; assert(!sequence.reserve(0, next));
  puts("Offline durable identities: 10000 unique reboot/recreation reservations + 4 failure cases PASSED");
}
