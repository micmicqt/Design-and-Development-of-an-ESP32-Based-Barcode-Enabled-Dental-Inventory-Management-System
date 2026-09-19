#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace scanner_uart {
// Full-duplex bare-metal software UART: GM65 TX -> PC0/A0 RX and
// PC1/A1 TX -> GM65 RX. USART0 PD0/PD1 is not configured by this module.
void initialize();
// RX ISR queues bytes with fixed storage and framing/overrun status.
bool tryRead(uint8_t& byte, bool& error);
// Underlying bounded TX capability; production currently sends no GM65 command.
bool tryWrite(uint8_t byte);
}  // namespace scanner_uart
}  // namespace dental_atmega
