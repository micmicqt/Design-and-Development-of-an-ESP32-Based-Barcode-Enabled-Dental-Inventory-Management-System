#include "status_outputs.h"

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

int main() {
  dental_atmega::initializeStatusOutputs();
  // Foundation only: no automatic LED cycling, peripherals, or bridge transport.
  for (;;) {}
}
