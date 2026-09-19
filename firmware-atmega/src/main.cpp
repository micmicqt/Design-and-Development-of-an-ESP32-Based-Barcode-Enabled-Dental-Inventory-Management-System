#include "status_outputs.h"
#include "ping_client.h"
#include "uart_link.h"
#include "physical_workflow.h"
#include "scanner_uart.h"
#include "lcd_display.h"

#include <avr/interrupt.h>
#include <avr/io.h>

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

// Retained local diagnostic state; no new controller-link frames. USART0
// D0/D1 is free from the scanner. Ready means backpack ACKs, not optical proof.
volatile dental_atmega::lcd::State lcdState = dental_atmega::lcd::State::kInitializing;
volatile dental_atmega::twi::Result lcdLastError = dental_atmega::twi::Result::kIdle;

int main() {
  dental_atmega::initializeStatusOutputs();
  dental_atmega::uart::initialize();
  dental_atmega::uart::initializeClock();
  dental_atmega::scanner_uart::initialize();
  DDRD = dental_atmega::hardware::buttonDdr(DDRD);
  PORTD = dental_atmega::hardware::buttonPort(PORTD); // External 10 kOhm pull-downs.
  dental_atmega::PingClient link;
  dental_atmega::PhysicalWorkflow scanner;
  dental_atmega::uart::Transmitter transmitter;
  dental_atmega::twi::AvrHardware twiHardware;
  dental_atmega::twi::Master<dental_atmega::twi::AvrHardware> twi(twiHardware);
  twi.initialize();
  dental_atmega::lcd::Display<decltype(twi)> lcd(twi);
  dental_atmega::lcd::WorkflowScreen lcdScreen;
  sei();
  lcd.begin(dental_atmega::uart::milliseconds());
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
                    dental_atmega::hardware::buttonPressed(
                        pins, dental_atmega::hardware::kRestockButtonBit),
                    dental_atmega::hardware::buttonPressed(
                        pins, dental_atmega::hardware::kCheckoutButtonBit));
    scanner.service(dental_atmega::uart::milliseconds(), link, transmitter);
    // Cooperative peripheral service after core input/transport processing.
    // LCD failure/status never participates in transaction acceptance.
    lcdScreen.service(dental_atmega::uart::milliseconds(), scanner.state(), lcd);
    lcdState = lcd.state();
    lcdLastError = lcd.error();
  }
}
