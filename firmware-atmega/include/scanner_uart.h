#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace scanner_uart {
// Current runtime wiring: GM65 TX -> PD0/D0 RX only. PD1/D1 -> GM65 RX
// stays disconnected until scanner commands and their interface are verified.
// Keep D1 free during Uno bootloader uploads; isolate GM65 TX from D0 too.
void initialize();
// RX ISR queues bytes with USART framing/parity/overrun status.
bool tryRead(uint8_t& byte, bool& error);
}  // namespace scanner_uart
}  // namespace dental_atmega
