// Reuse the existing durable cache/journal fixtures, not production storage.
#define main existingInventoryRegressionMain
#include "transaction_event_queue_test.cpp"
#undef main
#include "foreground_storage_priority.h"
#include "button_admission.h"

namespace {
struct GuardedCache : MemoryCacheStorage {
  dental::storage::ForegroundStoragePriority priority;
  bool pending = false;
  bool injectForegroundAtPromotion = false;
  unsigned guardCalls = 0U, releases = 0U;
  bool beginReplacement() override {
    ++guardCalls;
    if (injectForegroundAtPromotion) pending = true;
    return priority.beginReplacement(false, pending);
  }
  void endReplacement() override { ++releases; priority.endReplacement(); }
};
struct PreviewStorage : MemoryPendingJournalStorage {
  bool yield = false;
  dental::offline::JournalReadLineResult readLine(char* line, size_t capacity) override {
    return yield ? dental::offline::JournalReadLineResult::kYielded :
                   MemoryPendingJournalStorage::readLine(line, capacity);
  }
};
void stagingAllowsForeground(bool offline) {
  using namespace dental::cache;
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    GuardedCache storage;
    OfflineInventoryCache cache(storage);
    installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
    const auto active = storage.files[kActiveCachePath];
    storage.priority.beginBackground();
    assert(cache.begin(cacheGenerationB(), 1U) == BeginResult::kStarted);
    assert(cache.item(cacheGenerationB(), 0U, makeCachedProduct()) == ItemResult::kAccepted);
    assert(storage.files[kActiveCachePath] == active);
    assert(dental::controller_link::buttonAdmissionGate(true, false,
              storage.priority.preemptible()) ==
           dental::controller_link::ButtonAdmissionGate::kProceed);
    storage.priority.pause();
    assert(!storage.priority.background());
    // Foreground reads the installed immutable generation, never the stage.
    dental::offline::OfflineCacheLookup lookup(storage);
    CacheProduct found;
    assert(lookup.find(cache.metadata(), "0012345678901", found) ==
           dental::offline::CacheLookupResult::kFound);
    if (offline) {
      MemoryPendingJournalStorage journalStorage;
      dental::offline::PendingJournal journal(journalStorage);
      assert(journal.loadOrCreate(offlineDeviceId()) == dental::offline::JournalLoadResult::kReady);
      const auto row = appendOfflineRecord(journal,
          cycle % 2U ? dental::offline::OfflineAction::kCheckout :
                       dental::offline::OfflineAction::kRestock, found);
      assert(strcmp(row.cacheGeneration, cache.metadata().generation) == 0);
      assert(journal.metadata().pendingCount == 1U);
      storage.pending = journal.blocksCacheReplacement();
      const auto journalBefore = journalStorage.files;
      storage.priority.resume();
      assert(cache.commit(cacheGenerationB(), 1U) == CommitResult::kInterlocked);
      assert(storage.files[kActiveCachePath] == active);
      assert(journalStorage.files == journalBefore);
      OfflineInventoryCache rebooted(storage); assert(rebooted.loadAtBoot());
      assert(strcmp(rebooted.metadata().generation, cacheGenerationA()) == 0);
    } else {
      // The foreground queue's exactly-once commit/ACK tests run separately.
      storage.priority.resume();
      assert(cache.commit(cacheGenerationB(), 1U) == CommitResult::kCommitted);
      assert(strcmp(cache.metadata().generation, cacheGenerationB()) == 0);
    }
    storage.priority.endBackground();
    assert(!storage.priority.replacing());
  }
}
void finalGuardAndPreview() {
  using namespace dental::cache;
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    GuardedCache storage; OfflineInventoryCache cache(storage);
    installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
    storage.priority.beginBackground();
    assert(cache.begin(cacheGenerationB(), 1U) == BeginResult::kStarted);
    assert(cache.item(cacheGenerationB(), 0U, makeCachedProduct()) == ItemResult::kAccepted);
    storage.injectForegroundAtPromotion = true;
    assert(cache.commit(cacheGenerationB(), 1U) == CommitResult::kInterlocked);
    assert(strcmp(cache.metadata().generation, cacheGenerationA()) == 0);
    assert(!storage.priority.replacing());
    PreviewStorage preview;
    dental::offline::PendingJournal journal(preview);
    assert(journal.loadOrCreate(offlineDeviceId()) == dental::offline::JournalLoadResult::kReady);
    const auto row = appendOfflineRecord(journal, dental::offline::OfflineAction::kRestock,
                                         makeCachedProduct());
    const auto original = preview.files;
    preview.yield = true; dental::offline::OfflineJournalRecord read;
    assert(journal.peekOldest(read) == dental::offline::JournalPeekResult::kYielded);
    assert(journal.metadata().available && !journal.temporarilyUnavailable());
    preview.yield = false;
    assert(journal.peekOldest(read) == dental::offline::JournalPeekResult::kFound);
    assert(strcmp(read.eventId, row.eventId) == 0 && preview.files == original);
  }
}
}
int main() {
  stagingAllowsForeground(false); stagingAllowsForeground(true); finalGuardAndPreview();
  // One uninterrupted durable journal: 50 RESTOCK + 50 CHECKOUT, with a real
  // lookup/overlay/derivation/append and sequence verification on every scan.
  MemoryCacheStorage cacheStorage;
  dental::cache::OfflineInventoryCache cache(cacheStorage);
  installSingleCache(cache, cacheGenerationA(), makeCachedProduct());
  MemoryPendingJournalStorage storage;
  dental::offline::PendingJournal journal(storage);
  assert(journal.loadOrCreate(offlineDeviceId()) == dental::offline::JournalLoadResult::kReady);
  dental::offline::OfflineCacheLookup lookup(cacheStorage);
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    dental::cache::CacheProduct product;
    assert(lookup.find(cache.metadata(), "0012345678901", product) == dental::offline::CacheLookupResult::kFound);
    const auto row = appendOfflineRecord(journal, cycle % 2U ?
        dental::offline::OfflineAction::kCheckout : dental::offline::OfflineAction::kRestock, product);
    assert(row.sequence == cycle + 1ULL && row.resultingStock == (cycle % 2U ? 8ULL : 9ULL));
    assert(journal.metadata().pendingCount == cycle + 1U);
  }
  const auto saved = storage.files;
  dental::offline::PendingJournal rebooted(storage);
  assert(rebooted.loadOrCreate(offlineDeviceId()) == dental::offline::JournalLoadResult::kReady);
  uint64_t resulting = 0ULL;
  assert(rebooted.deriveCurrentStock(makeCachedProduct(), cacheGenerationA(), resulting) == dental::offline::OverlayResult::kSuccess);
  assert(resulting == 8ULL && rebooted.metadata().pendingCount == 100U && storage.files == saved);
  puts("Foreground cache priority: 100 online-route + 100 durable offline + 100 final-guard/preview cycles PASSED");
  puts("Durable offline overlay: 50 RESTOCK + 50 CHECKOUT + reopen PASSED");
}
