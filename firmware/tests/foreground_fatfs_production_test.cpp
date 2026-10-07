// Actual production file adapter + pinned ChanFatFS; in-memory sectors only.
#include "offline_inventory_cache.h"
#include "offline_pending_journal.h"
#include "foreground_storage_priority.h"
#include "remote_diskio.h"
#include <ff.h>
#include <diskio.h>
#include <assert.h>
#include <array>
#include <map>
#include <functional>
#include <stdio.h>
#include <string.h>

static std::map<uint32_t, std::array<uint8_t, 512>> disk;
static uint32_t reads, writes, fat, directory, clockMs;
static FATFS fs;
dental::storage::ForegroundStoragePriority storagePriority;
bool microSdAvailable = true, storageProbeActive = false;
bool pendingInterlock = false;
bool journalPreviewActive = false;
void* activeTransaction = nullptr;
bool profileForeground = false;
static std::function<void()> foregroundWork;
static bool requireOpenReader = false;
uint32_t millis() { return clockMs++; }
enum class OfflineAckFatFsOperation : uint8_t {
  kNone, kStat, kOpenRead, kRead, kOpenWrite, kWrite, kSync, kClose, kUnlink, kRename
};
void recordCacheFatFsTiming(OfflineAckFatFsOperation, uint32_t, FRESULT) {}
void recordOfflineAckFatFsFailure(OfflineAckFatFsOperation, FRESULT) {}
bool reserveOfflineSequence(uint64_t floor, uint64_t& next) { next = floor + 1U; return true; }
void recordOfflineReadbackTiming(bool) {}
void foregroundStorageCheckpoint();
bool beginCacheReplacement() {
  foregroundStorageCheckpoint();
  return storagePriority.beginReplacement(false, pendingInterlock);
}
#include "../../.runtime/foreground-fatfs-production.inc"
void foregroundStorageCheckpoint() {
  if (!storagePriority.preemptible() || !foregroundWork ||
      (requireOpenReader && !publicationStorage.reading())) return;
  auto work = foregroundWork; foregroundWork = nullptr;
  storagePriority.pause(); work(); storagePriority.resume();
}
bool atmegaSdInitialize() { return true; }
void countSector(uint32_t sector) {
  if (!storagePriority.background()) return;
  if (sector >= fs.fatbase && sector < fs.fatbase + fs.fsize * fs.n_fats) ++fat;
  else if (sector >= fs.dirbase && sector < fs.database) ++directory;
}
bool atmegaSdReadSector(uint32_t sector, uint8_t* bytes) {
  if (storagePriority.background() || profileForeground) ++reads;
  countSector(sector); memcpy(bytes, disk[sector].data(), 512U); return true;
}
bool atmegaSdWriteSector(uint32_t sector, const uint8_t* bytes) {
  if (storagePriority.background() || profileForeground) ++writes;
  countSector(sector); memcpy(disk[sector].data(), bytes, 512U); return true;
}
bool atmegaSdSync() { return true; }
void atmegaSdReportDiskRead(uint32_t, uint32_t, uint8_t) {}
static void formatHostDisk() {
  auto& boot = disk[0U]; boot.fill(0U);
  boot[0] = 0xEBU; boot[1] = 0x3CU; boot[2] = 0x90U;
  boot[12] = 2U; boot[13] = 1U; boot[14] = 1U; boot[16] = 2U;
  boot[18] = 2U; boot[20] = 0x80U; boot[21] = 0xF8U; boot[22] = 0x80U;
  boot[24] = 0x20U; boot[26] = 0x40U; boot[510] = 0x55U; boot[511] = 0xAAU;
  auto& firstFat = disk[1U]; firstFat.fill(0U);
  firstFat[0] = 0xF8U; firstFat[1] = firstFat[2] = firstFat[3] = 0xFFU;
  disk[129U] = firstFat;
}
static void formatHostFat32Disk(unsigned rootSectors) {
  auto put32 = [](uint8_t* bytes, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<uint8_t>(value >> (i * 8));
  };
  auto& boot = disk[0]; boot.fill(0);
  boot[0] = 0xEB; boot[1] = 0x58; boot[2] = 0x90;
  boot[12] = 2; boot[13] = 1; boot[14] = 32; boot[16] = 2; boot[21] = 0xF8;
  put32(&boot[32], 131072); put32(&boot[36], 1024); put32(&boot[44], 2);
  boot[48] = 1; boot[510] = 0x55; boot[511] = 0xAA;
  memcpy(&boot[82], "FAT32   ", 8);
  auto& fat = disk[32]; fat.fill(0);
  put32(&fat[0], 0x0FFFFFF8); put32(&fat[4], 0xFFFFFFFF);
  for (unsigned sector = 0; sector < rootSectors; ++sector) {
    put32(&fat[(sector + 2) * 4], sector + 1 == rootSectors ? 0x0FFFFFFF : sector + 3);
    auto& root = disk[2080 + sector]; root.fill(0);
    // Valid pre-existing empty SFN files, never journal data. This models a
    // directory bigger than the previous eight-sector read-cache capacity.
    const unsigned entries = sector + 1 == rootSectors ? 8 : 16;
    for (unsigned entry = 0; entry < entries; ++entry) {
      char name[12]; snprintf(name, sizeof(name), "F%07uBIN", sector * 16 + entry);
      memcpy(&root[entry * 32], name, 11); root[entry * 32 + 11] = AM_ARC;
    }
  }
  disk[1056] = fat;
}
static void profile(const char* operation) {
  printf("Host FAT16 profile %s: reads=%u writes=%u FAT=%u directory=%u\n",
         operation, reads, writes, fat, directory);
  reads = writes = fat = directory = 0U;
}
int main() {
  formatHostDisk(); assert(f_mount(&fs, "", 1U) == FR_OK);
  SdCacheStorage storage; dental::cache::OfflineInventoryCache cache(storage);
  const char* first = "v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const char* second = "v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  dental::cache::CacheProduct product = {};
  strcpy(product.id, "1"); strcpy(product.barcode, "00001234");
  strcpy(product.name, "Dental item"); strcpy(product.category, "Restorative & Esthetic");
  product.currentStock = 8U; product.lowStockThreshold = 3U;
  product.status = dental::cache::StockStatus::kHigh;
  assert(cache.begin(first, 1U) == dental::cache::BeginResult::kStarted);
  assert(cache.item(first, 0U, product) == dental::cache::ItemResult::kAccepted);
  assert(cache.commit(first, 1U) == dental::cache::CommitResult::kCommitted);
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    const char* generation = cycle % 2U ? first : second;
    storagePriority.beginBackground();
    requireOpenReader = false;
    foregroundWork = [&]() {
      assert(!storagePriority.background());
      dental::offline::OfflineCacheLookup lookup(storage);
      dental::cache::CacheProduct found;
      assert(lookup.find(cache.metadata(), "00001234", found) ==
             dental::offline::CacheLookupResult::kFound);
      assert(remoteStorage.appendFile("/foreground.log", "durable\n", 8U) ||
             remoteStorage.writeFile("/foreground.log", "durable\n", 8U));
    };
    assert(cache.begin(generation, 1U) == dental::cache::BeginResult::kStarted);
    assert(!foregroundWork); if (cycle == 0U) profile("BEGIN");
    assert(cache.item(generation, 0U, product) == dental::cache::ItemResult::kAccepted);
    if (cycle == 0U) profile("ITEM");
    requireOpenReader = true;
    foregroundWork = [&]() {
      // The paused candidate cursor must survive a foreground cache read and
      // a write that switches the shared FF_FS_TINY volume window.
      dental::offline::OfflineCacheLookup lookup(storage);
      dental::cache::CacheProduct found;
      assert(lookup.find(cache.metadata(), "00001234", found) ==
             dental::offline::CacheLookupResult::kFound);
      assert(remoteStorage.appendFile("/foreground.log", "durable\n", 8U));
    };
    assert(cache.commit(generation, 1U) == dental::cache::CommitResult::kCommitted);
    assert(!foregroundWork); if (cycle == 0U) profile("COMMIT");
    storagePriority.endBackground();
    assert(strcmp(cache.metadata().generation, generation) == 0);
  }
  assert(f_mount(nullptr, "", 0U) == FR_OK);
  assert(f_mount(&fs, "", 1U) == FR_OK); // Reopen the persisted host disk.
  dental::cache::OfflineInventoryCache reopened(storage);
  assert(reopened.loadAtBoot() && strcmp(reopened.metadata().generation, first) == 0);
  puts("Production FatFs foreground yield: 100 begin/write/validation cursor interleavings + reopen PASSED");
  return 0;
}
