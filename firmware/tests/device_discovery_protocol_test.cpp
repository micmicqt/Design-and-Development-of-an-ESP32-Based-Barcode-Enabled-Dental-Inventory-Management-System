#include "device_discovery_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main() {
  dental::discovery::UsbRequestParser parser;
  const char* request = "WiFi connected\n@ATD:IDENTIFY:1\n";
  unsigned matches = 0U;
  for (const char* cursor = request; *cursor; ++cursor)
    if (parser.accept(static_cast<uint8_t>(*cursor))) ++matches;
  assert(matches == 1U);

  const char* malformed = "@ATD:IDENTIFY:2\n@ATD:IDENTIFY:1:token\n";
  for (const char* cursor = malformed; *cursor; ++cursor)
    assert(!parser.accept(static_cast<uint8_t>(*cursor)));
  for (unsigned index = 0U; index < 100U; ++index)
    assert(!parser.accept(static_cast<uint8_t>('A')));
  assert(!parser.accept('\n'));
  const char* validAgain = "@ATD:IDENTIFY:1\r\n";
  for (const char* cursor = validAgain; *cursor; ++cursor)
    if (parser.accept(static_cast<uint8_t>(*cursor))) ++matches;
  assert(matches == 2U);

  char frame[80] = {};
  assert(dental::discovery::formatIdentity(frame, sizeof(frame), "ATD-1234ABCD",
                                           true, "192.168.1.105"));
  assert(strcmp(frame, "@ATD:DEVICE:1:ATD-1234ABCD:1:192.168.1.105:0.1.0") == 0);
  assert(strstr(frame, "token") == nullptr);
  assert(dental::discovery::formatIdentity(frame, sizeof(frame), "ATD-1234ABCD",
                                           false, "192.168.1.105"));
  assert(strcmp(frame, "@ATD:DEVICE:1:ATD-1234ABCD:0:-:0.1.0") == 0);
  char tooSmall[12] = {};
  assert(!dental::discovery::formatIdentity(tooSmall, sizeof(tooSmall),
                                            "ATD-1234ABCD", true, "192.168.1.105"));
  puts("ESP32 USB discovery protocol: 8 focused scenarios PASSED");
}
