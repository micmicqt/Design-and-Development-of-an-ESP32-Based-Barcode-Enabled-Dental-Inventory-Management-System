#include "status_outputs.h"

#include <avr/io.h>

namespace dental_atmega {

void setSmallStatus(SmallStatus status) {
  PORTD = replaceOwnedBits(PORTD, hardware::kSmallMask, smallPortBits(status));
}

void setBigStatus(BigStatus status) {
  PORTB = replaceOwnedBits(PORTB, hardware::kBigMask, bigPortBits(status));
}

void initializeStatusOutputs() {
  // Load OFF before enabling drivers. Preserve every unrelated port/direction bit.
  setSmallStatus(kStartupSmallStatus);
  setBigStatus(kStartupBigStatus);
  DDRD |= hardware::kSmallMask;
  DDRB |= hardware::kBigMask;
}

}  // namespace dental_atmega
