#include "uart_link.h"
#include "software_uart.h"
#include "../../firmware-common/include/controller_link_protocol.h"

#include <avr/interrupt.h>
#include <avr/io.h>
#include <util/atomic.h>

namespace {
volatile uint32_t elapsedMilliseconds = 0UL;
static_assert(F_CPU == 16000000UL, "UART/timer target requires 16 MHz");
static_assert(dental_link::kBaud == 9600UL, "Software UART requires 9600 baud");
namespace soft = dental_atmega::software_uart;
soft::Receiver receiver;
soft::Sender sender;
soft::Ring<uint8_t> transmitQueue;
soft::Ring<soft::ReceivedByte> receiveQueue;
volatile bool receiveOverflow = false;

void startTransmission(uint8_t byte) {
  sender.begin(byte);
  // Arm compare before the start edge; interrupts are disabled here.
  OCR1A = static_cast<uint16_t>(TCNT1 + soft::kBitTicks);
  TIFR1 = _BV(OCF1A);
  PORTD &= static_cast<uint8_t>(~_BV(soft::kTxPortBit));
  TIMSK1 |= _BV(OCIE1A);
}

void finishReception() {
  TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1B));
  PCIFR = _BV(PCIF2);
  PCMSK2 |= _BV(PCINT22);
}
}

ISR(TIMER0_COMPA_vect) { ++elapsedMilliseconds; }

ISR(PCINT2_vect) {
  if (!receiver.active() && (PIND & _BV(soft::kRxPortBit)) == 0U) {
    // Half-bit validation rejects a short LOW glitch. Only PD6 triggers this.
    OCR1B = static_cast<uint16_t>(TCNT1 + soft::kHalfBitTicks);
    TIFR1 = _BV(OCF1B);
    receiver.begin();
    PCMSK2 &= static_cast<uint8_t>(~_BV(PCINT22));
    TIMSK1 |= _BV(OCIE1B);
  }
}

ISR(TIMER1_COMPB_vect) {
  const soft::SampleResult result =
      receiver.sample((PIND & _BV(soft::kRxPortBit)) != 0U);
  if (result == soft::SampleResult::kMore) {
    OCR1B = static_cast<uint16_t>(OCR1B + soft::kBitTicks);
  } else {
    if (result != soft::SampleResult::kFalseStart) {
      const soft::ReceivedByte received = {
          receiver.byte(), result == soft::SampleResult::kFramingError};
      if (!receiveQueue.push(received)) receiveOverflow = true;
    }
    finishReception();
  }
}

ISR(TIMER1_COMPA_vect) {
  if (sender.tick()) PORTD |= _BV(soft::kTxPortBit);
  else PORTD &= static_cast<uint8_t>(~_BV(soft::kTxPortBit));
  if (sender.active()) {
    OCR1A = static_cast<uint16_t>(OCR1A + soft::kBitTicks);
  } else {
    uint8_t next;
    if (transmitQueue.pop(next)) startTransmission(next);
    else TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1A));
  }
}

namespace dental_atmega {
namespace uart {

void initialize() {
  // Do not touch USART0, PD0 or PD1: permanently reserved for GM65.
  PORTD |= _BV(soft::kTxPortBit) | _BV(soft::kRxPortBit);
  DDRD = (DDRD & static_cast<uint8_t>(~_BV(soft::kRxPortBit))) |
      _BV(soft::kTxPortBit);
  // Timer1 free-running, prescaler 8: 0.5 us ticks; no compare-pin outputs.
  TCCR1A = 0U;
  TCCR1B = _BV(CS11);
  TIMSK1 = 0U;
  TCNT1 = 0U;
  PCIFR = _BV(PCIF2);
  PCMSK2 = _BV(PCINT22);
  PCICR |= _BV(PCIE2);
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
  bool accepted = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (!sender.active()) { startTransmission(byte); accepted = true; }
    else accepted = transmitQueue.push(byte);
  }
  return accepted;
}

bool tryRead(uint8_t& byte, bool& error) {
  bool available = false;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (receiveOverflow) {
      receiveOverflow = false;
      byte = 0U; error = true; available = true;
    } else {
      soft::ReceivedByte received;
      if (receiveQueue.pop(received)) {
        byte = received.byte; error = received.error; available = true;
      }
    }
  }
  return available;
}

}  // namespace uart
}  // namespace dental_atmega
