#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace uart {

void initialize();
void initializeClock();
uint32_t milliseconds();
bool tryWrite(uint8_t byte);
// Software UART on PD6 RX / PD7 TX; framing/queue-overrun errors are reported.
// Hardware USART0 PD0/PD1 is untouched and reserved for future GM65 operation.
bool tryRead(uint8_t& byte, bool& error);

struct Transmitter {
  bool tryWrite(uint8_t byte) { return uart::tryWrite(byte); }
};

}  // namespace uart
}  // namespace dental_atmega
