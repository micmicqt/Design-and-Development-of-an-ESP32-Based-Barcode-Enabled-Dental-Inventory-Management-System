#include "status_outputs.h"
#include "ping_client.h"
#include "uart_link.h"

#include <avr/interrupt.h>

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

int main() {
  dental_atmega::initializeStatusOutputs();
  dental_atmega::uart::initialize();
  dental_atmega::uart::initializeClock();
  dental_atmega::PingClient link;
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
    link.service(dental_atmega::uart::milliseconds(), transmitter);
  }
}
