#include "status_outputs.h"
#include "ping_client.h"
#include "uart_link.h"
#include "physical_workflow.h"
#include "scanner_uart.h"

#include <avr/interrupt.h>
#include <avr/io.h>

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

int main() {
  dental_atmega::initializeStatusOutputs();
  dental_atmega::uart::initialize();
  dental_atmega::uart::initializeClock();
  dental_atmega::scanner_uart::initialize();
  DDRD &= static_cast<uint8_t>(~dental_atmega::hardware::kButtonMask);
  PORTD |= dental_atmega::hardware::kButtonMask; // Active LOW buttons to GND.
  dental_atmega::PingClient link;
  dental_atmega::PhysicalWorkflow scanner;
  dental_atmega::uart::Transmitter transmitter;
  sei();
  for (;;) {
    // Bounded polling; neither missing PONG nor a stuck transmitter blocks main.
    uint8_t byte;
    bool error;
    for (uint8_t received = 0U; received < 8U; ++received) {
      if (!dental_atmega::uart::tryRead(byte, error)) break;
      if (error) link.receiveError();
      else link.receive(dental_atmega::uart::milliseconds(), byte);
    }
    for (uint8_t received = 0U; received < 8U; ++received) {
      if (!dental_atmega::scanner_uart::tryRead(byte, error)) break;
      scanner.receive(dental_atmega::uart::milliseconds(), byte, error);
    }
    const uint8_t pins = PIND;
    scanner.buttons(dental_atmega::uart::milliseconds(),
                    (pins & _BV(dental_atmega::hardware::kRestockButtonBit)) != 0U,
                    (pins & _BV(dental_atmega::hardware::kCheckoutButtonBit)) != 0U);
    scanner.service(dental_atmega::uart::milliseconds(), link, transmitter);
  }
}
