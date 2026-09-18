#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace scanner_uart {
void initialize();
// RX ISR queues bytes with USART framing/parity/overrun status.
bool tryRead(uint8_t& byte, bool& error);
}  // namespace scanner_uart
}  // namespace dental_atmega
