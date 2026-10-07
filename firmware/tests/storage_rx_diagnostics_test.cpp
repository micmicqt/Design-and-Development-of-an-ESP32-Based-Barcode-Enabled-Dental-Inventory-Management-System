#include "storage_rx_diagnostics.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

namespace {
using dental::storage_diagnostics::LineShape;
using dental::storage_diagnostics::LineStructureTracker;

void feed(LineStructureTracker& tracker, const char* line) {
  while (*line) tracker.receive(static_cast<uint8_t>(*line++));
}
}

int main() {
  LineStructureTracker tracker;
  feed(tracker,
       "SD:DATA:000:00112233445566778899AABBCCDDEEFF0011223344556677\n");
  const auto valid = tracker.last();
  assert(valid.length == 60U && valid.dataPrefixIntact &&
         valid.firstColonPresent && valid.secondColonPresent &&
         valid.offsetValidHex && strcmp(valid.offsetText, "000") == 0 &&
         valid.newlineTerminated && !valid.printableValidationFailed &&
         valid.shape == LineShape::kExpected);

  feed(tracker, "SD:DATA:018:001122\n");
  const auto truncated = tracker.last();
  assert(truncated.length == 18U && truncated.dataPrefixIntact &&
         strcmp(truncated.offsetText, "018") == 0 &&
         truncated.shape == LineShape::kTruncated);

  feed(tracker,
       "SD:DATA:000:00112233445566778899AABBCCDDEEFF0011223344556677"
       "SD:DATA:018:0011\n");
  assert(tracker.last().shape == LineShape::kMerged);

  feed(tracker, "SX:DATA:000:00\n");
  assert(!tracker.last().dataPrefixIntact);

  const uint8_t invalid[] = {'S','D',':','D','A','T','A',':','0','0','0',':',
                             '0',0x01U,'\n'};
  for (uint8_t byte : invalid) tracker.receive(byte);
  assert(tracker.last().printableValidationFailed &&
         tracker.last().unexpectedBytes == 1U);

  feed(tracker, "SD:DATA:00G:00\n");
  assert(tracker.last().offsetTextAvailable && !tracker.last().offsetValidHex &&
         tracker.last().shape == LineShape::kUnknown);

  puts("ESP32 storage RX diagnostics: 6 focused scenarios PASSED");
}
