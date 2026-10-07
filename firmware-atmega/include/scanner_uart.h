#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace scanner_uart {
// GM65 hardware USART0: scanner TX -> PD0/D0 RXD, PD1/D1 TXD -> scanner RX.
void initialize();
// RX ISR queues bytes with fixed storage and framing/overrun status.
bool tryRead(uint8_t& byte, bool& error);
// Underlying bounded TX capability; production currently sends no GM65 command.
bool tryWrite(uint8_t byte);
}  // namespace scanner_uart
}  // namespace dental_atmega
