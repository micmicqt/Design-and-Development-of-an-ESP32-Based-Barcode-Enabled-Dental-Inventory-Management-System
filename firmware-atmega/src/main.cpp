#include "status_outputs.h"
#include "ping_client.h"
#include "uart_link.h"
#include "physical_workflow.h"
#include "scanner_uart.h"
#include "lcd_display.h"
#include "ds3231.h"
#include "rtc_link.h"

#include <avr/interrupt.h>
#include <avr/io.h>

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

// Retained local diagnostic state. USART0 D0/D1 is free from the scanner.
// LCD ready means backpack ACKs, not optical proof.
volatile dental_atmega::lcd::State lcdState = dental_atmega::lcd::State::kInitializing;
volatile dental_atmega::twi::Result lcdLastError = dental_atmega::twi::Result::kIdle;
volatile dental_link::rtc::State rtcState = dental_link::rtc::State::kUnavailable;
volatile dental_link::rtc::Reason rtcReason =
    dental_link::rtc::Reason::kCommunicationFailure;

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
  dental_atmega::ds3231::Driver<decltype(twi)> rtc(twi);
  dental_atmega::RtcLink rtcLink;
  rtc.begin();
  uint32_t lastRtcClockRefreshMs = dental_atmega::uart::milliseconds();
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
      rtcLink.receive(byte, error, rtc);
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
    const uint32_t now = dental_atmega::uart::milliseconds();
    rtc.service(now);
    const bool rtcMayStart = !scanner.controllerTransmissionActive() &&
                             link.state() != dental_atmega::LinkState::kSending;
    rtcLink.service(rtc, transmitter, rtcMayStart);
    if (rtc.state() == dental_link::rtc::State::kReady && rtc.idle() &&
        !rtcLink.pending() &&
        static_cast<uint32_t>(now - lastRtcClockRefreshMs) >= 1000UL &&
        rtc.requestRead()) {
      lastRtcClockRefreshMs = now;
    }
    if (!rtcLink.transmitting()) scanner.service(now, link, transmitter);
    // Cooperative peripheral service after core input/transport processing.
    // LCD failure/status never participates in transaction acceptance.
    lcdScreen.service(now, scanner.state(), rtc.state(), rtc.time(), lcd);
    lcdState = lcd.state();
    lcdLastError = lcd.error();
    rtcState = rtc.state();
    rtcReason = rtc.reason();
  }
}
