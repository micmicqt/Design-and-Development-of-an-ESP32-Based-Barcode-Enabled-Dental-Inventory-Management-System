#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace dental_link { namespace display {
constexpr uint8_t kColumns = 20U;
struct Rows { char text[4][kColumns + 1] = {}; };
// The LCD's ASCII-compatible subset: UTF-8 code points become one '?', never
// split byte sequences. Original cache/scanner strings are not modified.
inline void fit(const char* input, char* output) {
  uint8_t written = 0;
  if (!input) input = "";
  while (*input && written < kColumns) {
    const uint8_t c = static_cast<uint8_t>(*input++);
    if (c >= 0x80U) {
      while ((static_cast<uint8_t>(*input) & 0xC0U) == 0x80U) ++input;
      output[written++] = '?';
    } else output[written++] = c >= 0x20U && c <= 0x7EU ? static_cast<char>(c) : '?';
  }
  if (*input && written) output[written - 1U] = '~';
  output[written] = '\0';
}
inline void processing(bool restock, const char* barcode, Rows& rows) {
  fit(restock ? "OFFLINE RESTOCK" : "OFFLINE CHECKOUT", rows.text[0]);
  fit("PROCESSING...", rows.text[1]); fit(barcode, rows.text[2]);
  fit("PLEASE WAIT", rows.text[3]);
}
inline void saved(bool restock, const char* name, const char* barcode,
                  uint64_t stock, const char* status, Rows& rows) {
  fit(restock ? "RESTOCK SAVED" : "CHECKOUT SAVED", rows.text[0]);
  fit(name, rows.text[1]);
  const int length = snprintf(rows.text[2], sizeof(rows.text[2]), "STOCK: %llu %s",
      static_cast<unsigned long long>(stock), status);
  if (length > kColumns) snprintf(rows.text[2], sizeof(rows.text[2]), "%llu %c",
      static_cast<unsigned long long>(stock), status[0]);
  fit(barcode, rows.text[3]);
}
} }
