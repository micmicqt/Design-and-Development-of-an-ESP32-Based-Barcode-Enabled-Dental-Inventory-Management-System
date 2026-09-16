#include "status_encoding.h"

#include <assert.h>
#include <stdio.h>

using namespace dental_atmega;

int main() {
  const SmallStatus small[] = {SmallStatus::OFF, SmallStatus::YELLOW,
                               SmallStatus::RED, SmallStatus::GREEN};
  const bool smallA[] = {false, false, true, true};
  const bool smallB[] = {false, true, false, true};
  const uint8_t smallBits[] = {0x00U, 0x10U, 0x20U, 0x30U};
  for (unsigned i = 0U; i < 4U; ++i) {
    assert(encodeSmall(small[i]).a == smallA[i]);
    assert(encodeSmall(small[i]).b == smallB[i]);
    assert(smallPortBits(small[i]) == smallBits[i]);
  }

  const BigStatus big[] = {BigStatus::OFF, BigStatus::YELLOW, BigStatus::GREEN};
  const bool bigA[] = {false, true, true};
  const bool bigB[] = {false, false, true};
  const uint8_t bigBits[] = {0x00U, 0x01U, 0x03U};
  for (unsigned i = 0U; i < 3U; ++i) {
    assert(encodeBig(big[i]).a == bigA[i]);
    assert(encodeBig(big[i]).b == bigB[i]);
    assert(bigPortBits(big[i]) == bigBits[i]);
    assert(encodeBig(big[i]).a || !encodeBig(big[i]).b);  // Never reserved 01.
  }

  assert(kStartupSmallStatus == SmallStatus::OFF);
  assert(kStartupBigStatus == BigStatus::OFF);
  assert(smallPortBits(kStartupSmallStatus) == 0U);
  assert(bigPortBits(kStartupBigStatus) == 0U);

  for (unsigned repeat = 0U; repeat < 100U; ++repeat) {
    for (unsigned i = 0U; i < 4U; ++i)
      assert(smallPortBits(small[i]) == smallBits[i]);
    for (unsigned i = 0U; i < 3U; ++i)
      assert(bigPortBits(big[i]) == bigBits[i]);
  }

  // Exhaustive invalid-enum fallback and unrelated-port preservation checks.
  for (unsigned value = 0U; value < 256U; ++value) {
    if (value >= 4U) assert(smallPortBits(static_cast<SmallStatus>(value)) == 0U);
    if (value >= 3U) assert(bigPortBits(static_cast<BigStatus>(value)) == 0U);
    for (unsigned i = 0U; i < 4U; ++i) {
      const uint8_t port = replaceOwnedBits(value, hardware::kSmallMask, smallBits[i]);
      assert((port & hardware::kSmallMask) == smallBits[i]);
      assert((port & 0xCFU) == (value & 0xCFU));
    }
    for (unsigned i = 0U; i < 3U; ++i) {
      const uint8_t port = replaceOwnedBits(value, hardware::kBigMask, bigBits[i]);
      assert((port & hardware::kBigMask) == bigBits[i]);
      assert((port & 0xFCU) == (value & 0xFCU));
    }
  }

  puts("ATmega status encoding: 6 focused scenarios PASSED (7 defined states)");
  return 0;
}
