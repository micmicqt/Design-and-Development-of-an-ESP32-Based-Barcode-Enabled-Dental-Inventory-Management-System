#pragma once
// Host-only shim to exercise AVR-specific access branches. Actual placement
// and LPM accesses are separately checked in the real AVR build/disassembly.
#include <stdint.h>
#include <string.h>
#define PROGMEM
#define PSTR(value) (value)
static unsigned dental_test_flash_reads = 0U;
static unsigned dental_test_flash_copies = 0U;
static unsigned dental_test_flash_compares = 0U;
inline uint8_t pgm_read_byte(const void* pointer) {
  ++dental_test_flash_reads;
  return *static_cast<const uint8_t*>(pointer);
}
inline size_t strlen_P(const char* pointer) { ++dental_test_flash_reads; return strlen(pointer); }
inline void* memcpy_P(void* output, const void* pointer, size_t size) {
  ++dental_test_flash_copies; return memcpy(output, pointer, size);
}
inline int strcmp_P(const char* received, const char* pointer) {
  ++dental_test_flash_compares; return strcmp(received, pointer);
}
inline int strncmp_P(const char* received, const char* pointer, size_t size) {
  ++dental_test_flash_compares; return strncmp(received, pointer, size);
}
