#pragma once
#include <stdint.h>

bool atmegaSdInitialize();
void remoteDiskInvalidate();
void remoteDiskBeginForegroundCache();
void remoteDiskEndForegroundCache();
bool atmegaSdReadSector(uint32_t sector, uint8_t* destination);
bool atmegaSdWriteSector(uint32_t sector, const uint8_t* source);
bool atmegaSdSync();
void atmegaSdReportDiskRead(uint32_t sector, uint32_t count, uint8_t result);
