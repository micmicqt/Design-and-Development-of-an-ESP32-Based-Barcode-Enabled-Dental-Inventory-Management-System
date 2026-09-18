#include "scanner_uart.h"
#include "../../firmware-common/include/controller_link_protocol.h"
#include <avr/io.h>
#include <avr/interrupt.h>
#include <util/atomic.h>

namespace {
static_assert(F_CPU == 16000000UL, "Scanner USART requires 16 MHz");
static_assert(dental_link::kBaud == 9600UL, "Scanner USART requires 9600 baud");
struct ReceivedByte { uint8_t byte; bool error; };
ReceivedByte bytes[64] = {};
volatile uint8_t head = 0U;
volatile uint8_t tail = 0U;
volatile bool overflow = false;
}

ISR(USART_RX_vect) {
  // Status must be read before UDR0, which clears the received error flags.
  const uint8_t status = UCSR0A;
  const uint8_t byte = UDR0;
  const uint8_t next = static_cast<uint8_t>((head + 1U) & 63U);
  if (overflow || next == tail) { overflow = true; return; }
  bytes[head].byte = byte;
  bytes[head].error = (status & (_BV(FE0) | _BV(DOR0) | _BV(UPE0))) != 0U;
  head = next;
}

namespace dental_atmega {
namespace scanner_uart {
void initialize() {
  UCSR0B = 0U;
  UCSR0A = 0U;  // Normal speed, approximately 9615 baud at divider 103.
  UBRR0H = 0U;
  UBRR0L = 103U;
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);  // 8N1.
  head = tail = 0U;
  overflow = false;
  UCSR0B = _BV(RXEN0) | _BV(TXEN0) | _BV(RXCIE0);
  // No commands/triggers are transmitted during Step 3A.
}
bool tryRead(uint8_t& byte, bool& error) {
  bool available = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (overflow) {
      tail = head;  // Drop uncertain queued input, then quarantine to delimiter.
      overflow = false;
      byte = 0U; error = true; available = true;
    } else if (tail != head) {
      byte = bytes[tail].byte; error = bytes[tail].error;
      tail = static_cast<uint8_t>((tail + 1U) & 63U);
      available = true;
    }
  }
  return available;
}
}  // namespace scanner_uart
}  // namespace dental_atmega
