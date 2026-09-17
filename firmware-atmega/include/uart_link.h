#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace uart {

void initialize();
void initializeClock();
uint32_t milliseconds();
bool tryWrite(uint8_t byte);
// Reads status before UDR0, so overrun/framing/parity errors cannot be missed.
bool tryRead(uint8_t& byte, bool& error);

struct Transmitter {
  bool tryWrite(uint8_t byte) { return uart::tryWrite(byte); }
};

}  // namespace uart
}  // namespace dental_atmega
