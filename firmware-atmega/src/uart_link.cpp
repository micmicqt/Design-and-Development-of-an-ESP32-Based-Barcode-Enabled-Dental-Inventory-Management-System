#include "uart_link.h"
#include "../../firmware-common/include/controller_link_protocol.h"

#include <avr/interrupt.h>
#include <avr/io.h>
#include <util/atomic.h>

namespace {
volatile uint32_t elapsedMilliseconds = 0UL;
constexpr uint16_t kDivider =
    (F_CPU + 8UL * dental_link::kBaud) / (16UL * dental_link::kBaud) - 1UL;
static_assert(F_CPU == 16000000UL, "UART/timer target requires 16 MHz");
static_assert(kDivider == 103U, "Expected 9600 baud in normal USART mode");
}

ISR(TIMER0_COMPA_vect) { ++elapsedMilliseconds; }

namespace dental_atmega {
namespace uart {

void initialize() {
  UCSR0B = 0U;
  UCSR0A = 0U;  // Normal speed, no multiprocessor addressing.
  UBRR0H = static_cast<uint8_t>(kDivider >> 8U);
  UBRR0L = static_cast<uint8_t>(kDivider);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);  // 8 data, no parity, one stop.
  DDRD = (DDRD & static_cast<uint8_t>(~_BV(DDD0))) | _BV(DDD1);
  UCSR0B = _BV(RXEN0) | _BV(TXEN0);
}

void initializeClock() {
  // Timer0 CTC at 1 kHz, without PWM/GPIO output or Arduino runtime.
  TCCR0A = _BV(WGM01);
  TCCR0B = 0U;
  TCNT0 = 0U;
  OCR0A = 249U;
  TIFR0 = _BV(OCF0A);
  TIMSK0 = _BV(OCIE0A);
  TCCR0B = _BV(CS01) | _BV(CS00);  // Prescaler 64.
}

uint32_t milliseconds() {
  uint32_t now;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { now = elapsedMilliseconds; }
  return now;
}

bool tryWrite(uint8_t byte) {
  if ((UCSR0A & _BV(UDRE0)) == 0U) return false;
  UDR0 = byte;
  return true;
}

bool tryRead(uint8_t& byte, bool& error) {
  const uint8_t status = UCSR0A;
  if ((status & _BV(RXC0)) == 0U) return false;
  byte = UDR0;
  error = (status & (_BV(FE0) | _BV(DOR0) | _BV(UPE0))) != 0U;
  return true;
}

}  // namespace uart
}  // namespace dental_atmega
