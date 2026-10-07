#include "remote_diskio.h"
#include <ff.h>
#include <diskio.h>
#include <string.h>

namespace {
DSTATUS remoteStatus = STA_NOINIT;
// Transaction-scoped read-through cache, never a deferred durable write.
// Sixteen fixed slots retain a multi-sector FAT32 directory plus FAT/data
// between the independently flushed body/newline appends and readback.
constexpr uint8_t kReadCacheSectors = 16U;
struct ReadSector { uint32_t sector = 0; bool valid = false; BYTE bytes[512] = {}; } sectors[kReadCacheSectors];
bool cacheActive = false;
uint8_t replacement = 0;
void clearReadCache() { for (auto& entry : sectors) entry.valid = false; }
}
void remoteDiskBeginForegroundCache() { clearReadCache(); replacement = 0; cacheActive = true; }
void remoteDiskEndForegroundCache() { cacheActive = false; clearReadCache(); }

void remoteDiskInvalidate() { remoteStatus = STA_NOINIT; clearReadCache(); }

extern "C" DSTATUS disk_initialize(BYTE drive) {
  if (drive != 0U) return STA_NOINIT;
  // FatFs may ask to initialize an already-proven drive while mounting. Do
  // not perform a second controller round trip or discard the adapter-local
  // ready state established by the diagnostic read path.
  if ((remoteStatus & STA_NOINIT) == 0U) return remoteStatus;
  remoteStatus = atmegaSdInitialize() ? 0U : STA_NOINIT;
  return remoteStatus;
}
extern "C" DSTATUS disk_status(BYTE drive) {
  return drive == 0U ? remoteStatus : STA_NOINIT;
}
extern "C" DRESULT disk_read(BYTE drive, BYTE* buffer, LBA_t sector, UINT count) {
  const uint32_t firstSector = static_cast<uint32_t>(sector);
  const uint32_t requestedCount = count;
  if (drive != 0U || !buffer || count == 0U) {
    atmegaSdReportDiskRead(firstSector, requestedCount, RES_PARERR);
    return RES_PARERR;
  }
  if ((remoteStatus & STA_NOINIT) != 0U) {
    atmegaSdReportDiskRead(firstSector, requestedCount, RES_NOTRDY);
    return RES_NOTRDY;
  }
  while (count-- != 0U) {
    bool cached = false;
    if (cacheActive) for (const auto& entry : sectors) {
      if (entry.valid && entry.sector == sector) { memcpy(buffer, entry.bytes, 512U); cached = true; break; }
    }
    if (cached) { ++sector; buffer += 512U; continue; }
    if (!atmegaSdReadSector(static_cast<uint32_t>(sector), buffer)) {
      clearReadCache();
      remoteStatus = STA_NOINIT;
      atmegaSdReportDiskRead(firstSector, requestedCount, RES_ERROR);
      return RES_ERROR;
    }
    if (cacheActive) {
      auto& entry = sectors[replacement++ % kReadCacheSectors];
      entry.sector = static_cast<uint32_t>(sector); entry.valid = true;
      memcpy(entry.bytes, buffer, 512U);
    }
    ++sector; buffer += 512U;
  }
  atmegaSdReportDiskRead(firstSector, requestedCount, RES_OK);
  return RES_OK;
}
extern "C" DRESULT disk_write(BYTE drive, const BYTE* buffer, LBA_t sector,
                               UINT count) {
  if (drive != 0U || !buffer || count == 0U) return RES_PARERR;
  if ((remoteStatus & STA_NOINIT) != 0U) return RES_NOTRDY;
  while (count-- != 0U) {
    for (auto& entry : sectors) if (entry.sector == sector) entry.valid = false;
    if (!atmegaSdWriteSector(static_cast<uint32_t>(sector), buffer)) {
      clearReadCache();
      remoteStatus = STA_NOINIT; return RES_ERROR;
    }
    ++sector; buffer += 512U;
  }
  return RES_OK;
}
extern "C" DRESULT disk_ioctl(BYTE drive, BYTE command, void*) {
  if (drive != 0U) return RES_PARERR;
  if ((remoteStatus & STA_NOINIT) != 0U) return RES_NOTRDY;
  if (command != CTRL_SYNC) return RES_PARERR;
  if (atmegaSdSync()) return RES_OK;
  clearReadCache();
  remoteStatus = STA_NOINIT;
  return RES_ERROR;
}
