// Pinned production FatFs adapter on disposable memory sectors; no hardware.
#define main foregroundRegression
#include "foreground_fatfs_production_test.cpp"
#undef main
#include <algorithm>
#include <vector>

int main() {
  using namespace dental::offline;
  const char* generation = "v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  for (bool fat32 : {false, true}) for (unsigned size : {0U, 2U, 10U, 50U, 100U}) {
    disk.clear(); remoteDiskInvalidate();
    if (fat32) formatHostFat32Disk(10); else formatHostDisk();
    assert(f_mount(&fs, "", 1U) == FR_OK);
    assert(fs.fs_type == (fat32 ? FS_FAT32 : FS_FAT16));
    SdCacheStorage storage; dental::cache::OfflineInventoryCache cache(storage);
    dental::cache::CacheProduct product = {};
    strcpy(product.id, "1"); strcpy(product.barcode, "00001234");
    strcpy(product.name, "Dental item"); strcpy(product.category, "Restorative & Esthetic");
    product.currentStock = 8U; product.lowStockThreshold = 3U;
    product.status = dental::cache::StockStatus::kHigh;
    assert(cache.begin(generation, 1U) == dental::cache::BeginResult::kStarted);
    assert(cache.item(generation, 0U, product) == dental::cache::ItemResult::kAccepted);
    assert(cache.commit(generation, 1U) == dental::cache::CommitResult::kCommitted);
    SdPendingJournalStorage journalStorage; PendingJournal journal(journalStorage);
    assert(journal.loadOrCreate("148CE50D5020") == JournalLoadResult::kReady);
    OfflineJournalRecord record = {};
    for (unsigned n = 0U; n < size; ++n)
      assert(journal.append(OfflineAction::kRestock, "2026-10-07 01:07:22", product,
          generation, 9U + n, dental::cache::StockStatus::kHigh, record) == JournalAppendResult::kCommitted);
    std::vector<unsigned> modeled;
    OfflineCacheLookup lookup(storage); dental::cache::CacheProduct found;
    // Rebuild validated catalog at boot, outside admitted transaction timing.
    assert(lookup.find(cache.metadata(), "00001234", found) == CacheLookupResult::kFound);
    assert(lookup.find(cache.metadata(), nullptr, found) == CacheLookupResult::kNotFound);
    assert(lookup.find(cache.metadata(), "bad\ninput", found) == CacheLookupResult::kNotFound);
    assert(lookup.find(cache.metadata(), "00001234", found) == CacheLookupResult::kFound);
    for (unsigned repeat = 0U; repeat < 5U; ++repeat) {
      profileForeground = true; reads = writes = 0U;
      remoteDiskBeginForegroundCache();
      assert(lookup.find(cache.metadata(), "00001234", found) == CacheLookupResult::kFound);
      unsigned cacheReads = reads; reads = 0U;
      uint64_t stock = 0U;
      assert(journal.deriveCurrentStock(found, generation, stock) == OverlayResult::kSuccess);
      unsigned overlayReads = reads; reads = 0U;
      assert(journal.append(OfflineAction::kRestock, "2026-10-07 01:07:22", found,
          generation, stock + 1U, dental::cache::StockStatus::kHigh, record) == JournalAppendResult::kCommitted);
      // Model only 9600-baud transfer costs; NOT wall-clock/physical latency.
      unsigned total = (cacheReads + overlayReads + reads) * 1400U + writes * 1600U;
      // Literal production FatFs fixture regression: no journal-size growth,
      // and no repeated eviction/rescan of the ten-sector FAT32 directory.
      assert(cacheReads == 0 && overlayReads == 0);
      assert(reads <= (fat32 ? 18U : 8U));
      modeled.push_back(total);
      printf("offline host FAT%u n=%u run=%u cacheReads=%u overlayReads=%u appendReads=%u writes=%u wireModelMs=%u\n",
          fat32 ? 32 : 16, size, repeat, cacheReads, overlayReads, reads, writes, total);
      profileForeground = false;
      remoteDiskEndForegroundCache();
      assert(journal.metadata().pendingCount == size + repeat + 1U);
    }
    std::sort(modeled.begin(), modeled.end());
    printf("offline host FAT%u n=%u min=%u median=%u p95=%u max=%u (wire model only)\n",
        fat32 ? 32 : 16, size, modeled.front(), modeled[2], modeled.back(), modeled.back());
    profileForeground = true; reads = writes = 0U;
    OfflineJournalRecord head;
    assert(journal.peekOldest(head) == JournalPeekResult::kFound && head.sequence == 1U);
    assert(journal.peekOldest(record) == JournalPeekResult::kFound && !strcmp(record.eventId, head.eventId));
    assert(reads == 0U && writes == 0U); // READY preview cannot time out scanning a full journal.
    profileForeground = false;
    PendingJournal reopened(journalStorage);
    assert(reopened.loadOrCreate("148CE50D5020") == JournalLoadResult::kReady);
    uint64_t recoveredStock = 0;
    assert(reopened.deriveCurrentStock(product, generation, recoveredStock) == OverlayResult::kSuccess);
    assert(recoveredStock == product.currentStock + size + 5U);
    auto mismatched = product; strcpy(mismatched.barcode, "00009999");
    assert(reopened.deriveCurrentStock(mismatched, generation, recoveredStock) == OverlayResult::kStockInvalid);
    mismatched = product; mismatched.currentStock += 1U;
    assert(reopened.deriveCurrentStock(mismatched, generation, recoveredStock) == OverlayResult::kStockInvalid);
    mismatched = product; mismatched.lowStockThreshold = 10000U;
    assert(reopened.deriveCurrentStock(mismatched, generation, recoveredStock) == OverlayResult::kStockInvalid);
    assert(reopened.deriveCurrentStock(product, "v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", recoveredStock) == OverlayResult::kGenerationMismatch);
    assert(reopened.acknowledgeOldest(head.eventId) == JournalAcknowledgementResult::kAcknowledged);
    assert(reopened.peekOldest(head) == JournalPeekResult::kFound && head.sequence == 2U);
    assert(reopened.deriveCurrentStock(product, generation, recoveredStock) == OverlayResult::kSuccess);
    assert(recoveredStock == product.currentStock + size + 5U); // ACK rows remain in overlay.
    class AmbiguousStorage : public SdPendingJournalStorage {
      public:
      unsigned appendCalls = 0;
      bool appendFile(const char* path, const char* bytes, size_t count) override {
        const bool result = SdPendingJournalStorage::appendFile(path, bytes, count);
        return ++appendCalls == 2U ? false : result; // Complete newline durable, response lost.
      }
    } ambiguous;
    PendingJournal ambiguousJournal(ambiguous);
    assert(ambiguousJournal.loadOrCreate("148CE50D5020") == JournalLoadResult::kReady);
    assert(ambiguousJournal.append(OfflineAction::kRestock, "2026-10-07 01:07:22", product,
        generation, recoveredStock + 1U, dental::cache::StockStatus::kHigh, record) == JournalAppendResult::kCommitted);
    assert(ambiguousJournal.metadata().pendingCount == size + 5U);
    assert(f_mount(nullptr, "", 0U) == FR_OK);
  }
  puts("Offline production-adapter scaling: FAT16/FAT32 x 5 sizes x 5 durable transactions PASSED");
}
