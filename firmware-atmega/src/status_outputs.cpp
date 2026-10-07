#include "status_outputs.h"

#include <avr/io.h>
#include <util/atomic.h>

namespace dental_atmega {

void setSmallStatus(SmallStatus status) {
  // Timer1's controller TX ISR also changes PD7. Keep this masked PORTD
  // read/modify/write indivisible so an LED update cannot erase a TX edge.
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    PORTD = replaceOwnedBits(PORTD, hardware::kSmallMask, smallPortBits(status));
  }
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
