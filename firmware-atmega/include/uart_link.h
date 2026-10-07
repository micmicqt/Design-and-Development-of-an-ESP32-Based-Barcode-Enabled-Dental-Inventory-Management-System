#pragma once

#include <stdint.h>

namespace dental_atmega {
namespace uart {

void initialize();
void initializeClock();
uint32_t milliseconds();
bool tryWrite(uint8_t byte);
void resetTxMetrics();
uint8_t txQueueHighWater();
// Timer1/PCINT2 software UART on PD6 RX / PD7 TX. USART0 belongs to GM65.
bool tryRead(uint8_t& byte, bool& error);

struct ErrorCounts {
  uint16_t framing;
  uint16_t overrun;
  uint16_t parity;
  uint16_t queueOverflow;
};
ErrorCounts errorCounts();

struct Transmitter {
  bool tryWrite(uint8_t byte) { return uart::tryWrite(byte); }
  void resetQueueMetrics() { uart::resetTxMetrics(); }
  uint8_t queueHighWater() const { return uart::txQueueHighWater(); }
};

}  // namespace uart
}  // namespace dental_atmega
