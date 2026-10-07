#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#ifdef __AVR__
#include <avr/pgmspace.h>
#define DENTAL_FLASH_STORAGE PROGMEM
#define DENTAL_TEXT_LITERAL(value) PSTR(value)
#else
#define DENTAL_FLASH_STORAGE
#define DENTAL_TEXT_LITERAL(value) value
#endif

namespace dental_link { namespace text {
// Only immutable protocol literals use these helpers. Received text and
// writable buffers remain normal SRAM; no flash pointer is handed to an ISR.
inline char at(const char* immutable, size_t index) {
#ifdef __AVR__
  return static_cast<char>(pgm_read_byte(immutable + index));
#else
  return immutable[index];
#endif
}
inline size_t length(const char* immutable) {
#ifdef __AVR__
  return strlen_P(immutable);
#else
  return strlen(immutable);
#endif
}
inline void copy(char* destination, const char* immutable, size_t count) {
#ifdef __AVR__
  memcpy_P(destination, immutable, count);
#else
  memcpy(destination, immutable, count);
#endif
}
inline int compare(const char* received, const char* immutable) {
#ifdef __AVR__
  return strcmp_P(received, immutable);
#else
  return strcmp(received, immutable);
#endif
}
inline int compare(const char* received, const char* immutable, size_t count) {
#ifdef __AVR__
  return strncmp_P(received, immutable, count);
#else
  return strncmp(received, immutable, count);
#endif
}
} }
