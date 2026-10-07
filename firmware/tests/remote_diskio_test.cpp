#include "../include/remote_diskio.h"
#include "../include/remote_storage_timing.h"
#include <ff.h>
#include <diskio.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace {
bool initializeResult = true;
bool readResult = true;
uint32_t initializeCalls = 0U;
uint32_t readCalls = 0U;
uint32_t reportedSector = 0U;
uint32_t reportedCount = 0U;
uint8_t reportedResult = 0xFFU;
bool validFatVolume = false;
}

bool atmegaSdInitialize() { ++initializeCalls; return initializeResult; }
bool atmegaSdReadSector(uint32_t sector, uint8_t* destination) {
  ++readCalls;
  if (!readResult) return false;
  if (validFatVolume && sector == 0U) {
    memset(destination, 0, 512U);
    destination[0] = 0xEBU;
    destination[1] = 0x3CU;
    destination[2] = 0x90U;
    destination[11] = 0x00U; destination[12] = 0x02U; // 512-byte sectors
    destination[13] = 0x01U;                         // one sector/cluster
    destination[14] = 0x01U; destination[15] = 0x00U; // reserved sectors
    destination[16] = 0x02U;                         // two FATs
    destination[17] = 0x00U; destination[18] = 0x02U; // 512 root entries
    destination[19] = 0x00U; destination[20] = 0x80U; // 32768 sectors
    destination[21] = 0xF8U;
    destination[22] = 0x80U; destination[23] = 0x00U; // 128 sectors/FAT
    destination[24] = 0x20U; destination[25] = 0x00U;
    destination[26] = 0x40U; destination[27] = 0x00U;
    destination[510] = 0x55U; destination[511] = 0xAAU;
    return true;
  }
  for (uint16_t index = 0U; index < 512U; ++index)
    destination[index] = static_cast<uint8_t>(sector + index);
  return true;
}
bool atmegaSdWriteSector(uint32_t, const uint8_t*) { return true; }
bool atmegaSdSync() { return true; }
void atmegaSdReportDiskRead(uint32_t sector, uint32_t count, uint8_t result) {
  reportedSector = sector; reportedCount = count; reportedResult = result;
}

int main() {
  assert(dental::storage::kRawPollBudgetMs == 4160U);
  assert(dental::storage::kSectorWireBytes == 1330U);
  assert(dental::storage::kReadSectorTimeoutMs == 15900U);
  assert(dental::storage::kWriteSectorTimeoutMs == 11877U);
  assert(dental::storage::kSyncTimeoutMs == 6180U);
  assert(dental::storage::kInitializationRequestTimeoutMs == 8000UL);
  assert(dental::storage::kInitializationRequestTimeoutMs >
         dental::storage::kBoundedInitializationWorstCaseMs + 1000UL);
  uint8_t sector[1024] = {};
  assert(disk_initialize(0U) == 0U);
  assert(initializeCalls == 1U && disk_status(0U) == 0U);
  assert(disk_read(0U, sector, 0U, 1U) == RES_OK);
  assert(readCalls == 1U && reportedSector == 0U && reportedCount == 1U &&
         reportedResult == RES_OK && sector[510] == 0xFEU && sector[511] == 0xFFU);
  // A successful diagnostic read leaves the disk ready. FatFs can invoke
  // disk_initialize again during mount without another link request.
  assert(disk_status(0U) == 0U);
  assert(disk_initialize(0U) == 0U && initializeCalls == 1U);

  readResult = false;
  assert(disk_read(0U, sector, 7U, 1U) == RES_ERROR);
  assert(reportedSector == 7U && reportedResult == RES_ERROR);
  assert(disk_read(0U, sector, 0U, 1U) == RES_NOTRDY);

  readResult = true;
  assert(disk_initialize(0U) == 0U);
  assert(initializeCalls == 2U);
  assert(disk_read(0U, sector, 9U, 2U) == RES_OK);
  assert(reportedSector == 9U && reportedCount == 2U &&
         reportedResult == RES_OK);

  initializeResult = false;
  readResult = false;
  assert(disk_read(0U, sector, 0U, 1U) == RES_ERROR);
  assert(disk_initialize(0U) == STA_NOINIT && initializeCalls == 3U);
  assert(disk_read(0U, sector, 0U, 1U) == RES_NOTRDY);

  // The same initialized adapter state used by the diagnostic read is visible
  // to the real pinned ChanFatFS mount path.
  initializeResult = readResult = validFatVolume = true;
  assert(disk_initialize(0U) == 0U && initializeCalls == 4U);
  assert(disk_read(0U, sector, 0U, 1U) == RES_OK);
  FATFS fileSystem = {};
  assert(f_mount(&fileSystem, "", 1U) == FR_OK);
  assert(disk_status(0U) == 0U && initializeCalls == 4U &&
         fileSystem.fs_type == FS_FAT16);

  // Runtime recovery forces a fresh SD:STATUS exchange before remounting.
  remoteDiskInvalidate();
  assert(disk_status(0U) == STA_NOINIT);
  assert(disk_initialize(0U) == 0U && initializeCalls == 5U);

  remoteDiskBeginForegroundCache();
  const uint32_t callsBeforeCache = readCalls;
  assert(disk_read(0U, sector, 7U, 1U) == RES_OK);
  assert(disk_read(0U, sector, 7U, 1U) == RES_OK);
  assert(readCalls == callsBeforeCache + 1U);
  // A multi-sector directory fits the fixed sixteen-slot cache. Writes still
  // invalidate it and a subsequent physical read is required.
  for (uint32_t directory = 20; directory < 32; ++directory)
    assert(disk_read(0U, sector, directory, 1U) == RES_OK);
  const uint32_t afterDirectory = readCalls;
  for (uint32_t directory = 20; directory < 32; ++directory)
    assert(disk_read(0U, sector, directory, 1U) == RES_OK);
  assert(readCalls == afterDirectory);
  remoteDiskBeginForegroundCache(); // restart original focused cache scenario
  assert(disk_read(0U, sector, 7U, 1U) == RES_OK);
  const uint32_t callsAfterDirectory = readCalls;
  assert(disk_write(0U, sector, 7U, 1U) == RES_OK);
  assert(disk_read(0U, sector, 7U, 1U) == RES_OK);
  assert(readCalls == callsAfterDirectory + 1U);
  readResult = false;
  assert(disk_read(0U, sector, 8U, 1U) == RES_ERROR);
  readResult = true;
  assert(disk_initialize(0U) == 0U);
  assert(disk_read(0U, sector, 7U, 1U) == RES_OK);
  assert(readCalls == callsAfterDirectory + 3U);
  remoteDiskEndForegroundCache();
  puts("ESP32 remote disk/FatFs adapter: 20 focused scenarios PASSED");
}
