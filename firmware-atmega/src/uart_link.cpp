#include "uart_link.h"
#include "scanner_uart.h"
#include "software_uart.h"
#include "controller_uart_config.h"
#include "hardware_config.h"
#include "../../firmware-common/include/controller_link_protocol.h"

#include <avr/interrupt.h>
#include <avr/io.h>
#include <util/atomic.h>

namespace {
namespace soft = dental_atmega::software_uart;
volatile uint32_t elapsedMilliseconds = 0UL;
static_assert(F_CPU == 16000000UL, "UART/timer target requires 16 MHz");
static_assert(dental_link::kBaud == 9600UL, "Controller and scanner UARTs require 9600 baud");
constexpr uint16_t kScannerUbrr = 103U; // USART0 normal speed at 16 MHz/9600.

soft::TimedReceiver controllerReceiver;
soft::TimedSender controllerSender;
soft::Ring<soft::ReceivedByte> controllerRxQueue;
soft::Ring<uint8_t> controllerTxQueue;
volatile bool controllerRxOverflow = false;
volatile uint8_t controllerTxHighWater = 0U;
volatile uint16_t controllerFramingErrors = 0U;
volatile uint16_t controllerQueueOverflows = 0U;

soft::Ring<soft::ReceivedByte, 64U> scannerRxQueue;
soft::Ring<uint8_t> scannerTxQueue;
volatile bool scannerRxOverflow = false;

void driveControllerTx(bool high) {
  if (high) PORTD |= _BV(soft::kTxPortBit);
  else PORTD &= static_cast<uint8_t>(~_BV(soft::kTxPortBit));
}
void startControllerTx(uint8_t byte, uint16_t now) {
  controllerSender.begin(byte, now); driveControllerTx(false);
}

// Reuse the physically verified Step 2 Timer1/PCINT2 controller transport.
void scheduleTxCompare() {
  if (!controllerSender.active()) {
    TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1A)); return;
  }
  uint16_t target = controllerSender.next();
  const uint16_t now = TCNT1;
  if (soft::deadlineDue(now, target)) target = static_cast<uint16_t>(now + 4U);
  OCR1A = target; TIFR1 = _BV(OCF1A); TIMSK1 |= _BV(OCIE1A);
}

void scheduleRxCompare() {
  if (!controllerReceiver.active()) {
    TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1B)); return;
  }
  uint16_t target = controllerReceiver.next();
  const uint16_t now = TCNT1;
  if (soft::deadlineDue(now, target)) target = static_cast<uint16_t>(now + 4U);
  OCR1B = target; TIFR1 = _BV(OCF1B); TIMSK1 |= _BV(OCIE1B);
}

void finishControllerRx(soft::SampleResult result) {
  if (result != soft::SampleResult::kFalseStart) {
    const bool framing = result == soft::SampleResult::kFramingError;
    if (framing && controllerFramingErrors != UINT16_MAX) ++controllerFramingErrors;
    const soft::ReceivedByte received = {
        controllerReceiver.byte(), framing};
    if (!controllerRxQueue.push(received)) {
      controllerRxOverflow = true;
      if (controllerQueueOverflows != UINT16_MAX) ++controllerQueueOverflows;
    }
  }
  PCIFR = _BV(PCIF2); PCMSK2 |= _BV(PCINT22);
}
}

ISR(TIMER0_COMPA_vect) { ++elapsedMilliseconds; }

ISR(USART_RX_vect) {
  const uint8_t status = UCSR0A;
  const uint8_t byte = UDR0;
  const bool error = (status & (_BV(FE0) | _BV(DOR0) | _BV(UPE0))) != 0U;
  if (!scannerRxQueue.push({byte, error})) scannerRxOverflow = true;
}

ISR(USART_UDRE_vect) {
  uint8_t byte;
  if (scannerTxQueue.pop(byte)) UDR0 = byte;
  else UCSR0B &= static_cast<uint8_t>(~_BV(UDRIE0));
}

ISR(PCINT2_vect) {
  if (!controllerReceiver.active() && (PIND & _BV(soft::kRxPortBit)) == 0U) {
    controllerReceiver.begin(TCNT1);
    PCMSK2 &= static_cast<uint8_t>(~_BV(PCINT22));
    scheduleRxCompare();
  }
}

ISR(TIMER1_COMPB_vect) {
  const uint16_t now = TCNT1;
  if (controllerReceiver.due(now)) {
    const soft::SampleResult result = controllerReceiver.sample(
        (PIND & _BV(soft::kRxPortBit)) != 0U);
    if (result != soft::SampleResult::kMore) finishControllerRx(result);
  }
  scheduleRxCompare();
}

ISR(TIMER1_COMPA_vect) {
  const uint16_t now = TCNT1;
  if (controllerSender.due(now)) {
    driveControllerTx(controllerSender.tick());
    if (!controllerSender.active()) {
      uint8_t next;
      if (controllerTxQueue.pop(next)) startControllerTx(next, now);
    }
  }
  scheduleTxCompare();
}

namespace dental_atmega {
namespace uart {
void initialize() {
  // Only PD6/PD7 are configured here; USART0 PD0/PD1 belongs to GM65.
  DDRD = dental_atmega::controller_uart::configuredDdr(DDRD);
  PORTD = dental_atmega::controller_uart::configuredPort(PORTD);

  // Timer1 runs at 2 MHz for the D6/D7 software UART.
  TCCR1A = 0U; TCCR1B = _BV(CS11); TIMSK1 = 0U; TCNT1 = 0U;
  PCIFR = _BV(PCIF2);
  PCMSK2 |= _BV(PCINT22);
  PCICR |= _BV(PCIE2);
}
void initializeClock() {
  TCCR0A = _BV(WGM01); TCCR0B = 0U; TCNT0 = 0U; OCR0A = 249U;
  TIFR0 = _BV(OCF0A); TIMSK0 = _BV(OCIE0A);
  TCCR0B = _BV(CS01) | _BV(CS00);
}
uint32_t milliseconds() {
  uint32_t now;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { now = elapsedMilliseconds; }
  return now;
}
bool tryWrite(uint8_t byte) {
  bool accepted = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (!controllerSender.active()) {
      startControllerTx(byte, TCNT1);
      scheduleTxCompare();
      accepted = true;
    } else {
      // The running byte already owns OCR1A/OCF1A. Re-arming here can clear
      // a pending bit interrupt (or race an imminent compare), stretching a
      // bit until Timer1 wraps. Only the bit ISR schedules active TX edges.
      accepted = controllerTxQueue.push(byte);
    }
    if (accepted) {
      const uint8_t occupied = controllerTxQueue.size();
      if (occupied > controllerTxHighWater) controllerTxHighWater = occupied;
    }
  }
  return accepted;
}
void resetTxMetrics() {
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    controllerTxHighWater = controllerTxQueue.size();
  }
}
uint8_t txQueueHighWater() {
  uint8_t result;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { result = controllerTxHighWater; }
  return result;
}
bool tryRead(uint8_t& byte, bool& error) {
  bool available = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (controllerRxOverflow) {
      controllerRxQueue.clear(); controllerRxOverflow = false;
      byte = 0U; error = true; available = true;
    } else {
      soft::ReceivedByte received;
      if (controllerRxQueue.pop(received)) {
        byte = received.byte; error = received.error; available = true;
      }
    }
  }
  return available;
}
ErrorCounts errorCounts() {
  ErrorCounts result;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    result = {controllerFramingErrors, 0U, 0U, controllerQueueOverflows};
  }
  return result;
}
} // namespace uart

namespace scanner_uart {
void initialize() {
  // USART0 RXD/PD0 and TXD/PD1 belong exclusively to GM65.
  UCSR0B = 0U;
  UCSR0A = 0U;
  UBRR0H = static_cast<uint8_t>(kScannerUbrr >> 8U);
  UBRR0L = static_cast<uint8_t>(kScannerUbrr);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00); // 9600 baud, 8N1.
  UCSR0B = _BV(RXCIE0) | _BV(RXEN0) | _BV(TXEN0);
}
bool tryWrite(uint8_t byte) {
  bool accepted;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    accepted = scannerTxQueue.push(byte);
    if (accepted) UCSR0B |= _BV(UDRIE0);
  }
  return accepted;
}
bool tryRead(uint8_t& byte, bool& error) {
  bool available = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (scannerRxOverflow) {
      scannerRxQueue.clear(); scannerRxOverflow = false;
      byte = 0U; error = true; available = true;
    } else {
      soft::ReceivedByte received;
      if (scannerRxQueue.pop(received)) {
        byte = received.byte; error = received.error; available = true;
      }
    }
  }
  return available;
}
} // namespace scanner_uart
} // namespace dental_atmega
