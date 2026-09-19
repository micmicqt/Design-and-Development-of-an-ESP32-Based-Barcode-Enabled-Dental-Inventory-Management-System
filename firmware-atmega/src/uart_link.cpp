#include "uart_link.h"
#include "scanner_uart.h"
#include "software_uart.h"
#include "hardware_config.h"
#include "../../firmware-common/include/controller_link_protocol.h"

#include <avr/interrupt.h>
#include <avr/io.h>
#include <util/atomic.h>

namespace {
namespace soft = dental_atmega::software_uart;
volatile uint32_t elapsedMilliseconds = 0UL;
static_assert(F_CPU == 16000000UL, "UART/timer target requires 16 MHz");
static_assert(dental_link::kBaud == 9600UL, "Both software UARTs require 9600 baud");

soft::TimedReceiver controllerReceiver;
soft::TimedSender controllerSender;
soft::Ring<soft::ReceivedByte> controllerRxQueue;
soft::Ring<uint8_t> controllerTxQueue;
volatile bool controllerRxOverflow = false;

soft::TimedReceiver scannerReceiver;
soft::TimedSender scannerSender;
soft::Ring<soft::ReceivedByte, 64U> scannerRxQueue;
soft::Ring<uint8_t> scannerTxQueue;
volatile bool scannerRxOverflow = false;

void driveControllerTx(bool high) {
  if (high) PORTD |= _BV(soft::kTxPortBit);
  else PORTD &= static_cast<uint8_t>(~_BV(soft::kTxPortBit));
}
void driveScannerTx(bool high) {
  if (high) PORTC |= _BV(soft::kScannerTxPortBit);
  else PORTC &= static_cast<uint8_t>(~_BV(soft::kScannerTxPortBit));
}
void startControllerTx(uint8_t byte, uint16_t now) {
  controllerSender.begin(byte, now); driveControllerTx(false);
}
void startScannerTx(uint8_t byte, uint16_t now) {
  scannerSender.begin(byte, now); driveScannerTx(false);
}

// Schedule the earliest independent TX deadline on shared Compare A.
void scheduleTxCompare() {
  if (!controllerSender.active() && !scannerSender.active()) {
    TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1A)); return;
  }
  uint16_t target = controllerSender.active() ? controllerSender.next() : scannerSender.next();
  if (scannerSender.active() && (!controllerSender.active() ||
      soft::deadlineBefore(scannerSender.next(), target))) target = scannerSender.next();
  const uint16_t now = TCNT1;
  if (soft::deadlineDue(now, target)) target = static_cast<uint16_t>(now + 4U);
  OCR1A = target; TIFR1 = _BV(OCF1A); TIMSK1 |= _BV(OCIE1A);
}

void scheduleRxCompare() {
  if (!controllerReceiver.active() && !scannerReceiver.active()) {
    TIMSK1 &= static_cast<uint8_t>(~_BV(OCIE1B)); return;
  }
  uint16_t target = controllerReceiver.active() ? controllerReceiver.next() : scannerReceiver.next();
  if (scannerReceiver.active() && (!controllerReceiver.active() ||
      soft::deadlineBefore(scannerReceiver.next(), target))) target = scannerReceiver.next();
  const uint16_t now = TCNT1;
  if (soft::deadlineDue(now, target)) target = static_cast<uint16_t>(now + 4U);
  OCR1B = target; TIFR1 = _BV(OCF1B); TIMSK1 |= _BV(OCIE1B);
}

void finishControllerRx(soft::SampleResult result) {
  if (result != soft::SampleResult::kFalseStart) {
    const soft::ReceivedByte received = {
        controllerReceiver.byte(), result == soft::SampleResult::kFramingError};
    if (!controllerRxQueue.push(received)) controllerRxOverflow = true;
  }
  PCIFR = _BV(PCIF2); PCMSK2 |= _BV(PCINT22);
}
void finishScannerRx(soft::SampleResult result) {
  if (result != soft::SampleResult::kFalseStart) {
    const soft::ReceivedByte received = {
        scannerReceiver.byte(), result == soft::SampleResult::kFramingError};
    if (!scannerRxQueue.push(received)) scannerRxOverflow = true;
  }
  PCIFR = _BV(PCIF1); PCMSK1 |= _BV(PCINT8);
}
}

ISR(TIMER0_COMPA_vect) { ++elapsedMilliseconds; }

ISR(PCINT2_vect) {
  if (!controllerReceiver.active() && (PIND & _BV(soft::kRxPortBit)) == 0U) {
    controllerReceiver.begin(TCNT1);
    PCMSK2 &= static_cast<uint8_t>(~_BV(PCINT22));
    scheduleRxCompare();
  }
}

ISR(PCINT1_vect) {
  if (!scannerReceiver.active() && (PINC & _BV(soft::kScannerRxPortBit)) == 0U) {
    scannerReceiver.begin(TCNT1);
    PCMSK1 &= static_cast<uint8_t>(~_BV(PCINT8));
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
  if (scannerReceiver.due(now)) {
    const soft::SampleResult result = scannerReceiver.sample(
        (PINC & _BV(soft::kScannerRxPortBit)) != 0U);
    if (result != soft::SampleResult::kMore) finishScannerRx(result);
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
  if (scannerSender.due(now)) {
    driveScannerTx(scannerSender.tick());
    if (!scannerSender.active()) {
      uint8_t next;
      if (scannerTxQueue.pop(next)) startScannerTx(next, now);
    }
  }
  scheduleTxCompare();
}

namespace dental_atmega {
namespace uart {
void initialize() {
  PORTD |= _BV(soft::kTxPortBit) | _BV(soft::kRxPortBit);
  DDRD = (DDRD & static_cast<uint8_t>(~_BV(soft::kRxPortBit))) | _BV(soft::kTxPortBit);
  // Timer1 free-running at 2 MHz. A multiplexes both TX deadlines, B both RX.
  TCCR1A = 0U; TCCR1B = _BV(CS11); TIMSK1 = 0U; TCNT1 = 0U;
  PCIFR = _BV(PCIF2); PCMSK2 = _BV(PCINT22); PCICR |= _BV(PCIE2);
  // Explicitly leave hardware USART0 disconnected from application logic.
  UCSR0B = 0U;
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
  bool accepted;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (!controllerSender.active()) {
      startControllerTx(byte, TCNT1); accepted = true;
    } else accepted = controllerTxQueue.push(byte);
    if (accepted) scheduleTxCompare();
  }
  return accepted;
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
} // namespace uart

namespace scanner_uart {
void initialize() {
  // A0 input with pull-up, A1 idle HIGH output. Preserve PC4/PC5 TWI bits.
  PORTC = hardware::scannerPort(PORTC);
  DDRC = hardware::scannerDdr(DDRC);
  PCIFR = _BV(PCIF1); PCMSK1 |= _BV(PCINT8); PCICR |= _BV(PCIE1);
  UCSR0B = 0U;
}
bool tryWrite(uint8_t byte) {
  bool accepted;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
    if (!scannerSender.active()) {
      startScannerTx(byte, TCNT1); accepted = true;
    } else accepted = scannerTxQueue.push(byte);
    if (accepted) scheduleTxCompare();
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
