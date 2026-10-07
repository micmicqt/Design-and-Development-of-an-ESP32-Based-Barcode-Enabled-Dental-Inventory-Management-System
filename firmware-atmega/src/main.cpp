#include "status_outputs.h"
#include "ping_client.h"
#include "uart_link.h"
#include "physical_workflow.h"
#include "scanner_uart.h"
#include "lcd_display.h"
#include "ds3231.h"
#include "rtc_link.h"
#include "sd_card.h"
#include "controller_tx_scheduler.h"
#include "status_feedback.h"

#include <avr/interrupt.h>
#include <avr/io.h>

#ifndef F_CPU
#error "F_CPU must be explicitly configured"
#endif
static_assert(F_CPU == 16000000UL, "ATmega target requires 16 MHz");

// Retained local diagnostic state. D6/D7 software UART is the ESP32 link;
// GM65 uses the independent D0/D1 hardware USART0.
// LCD ready means backpack ACKs, not optical proof.
volatile dental_atmega::lcd::State lcdState = dental_atmega::lcd::State::kInitializing;
volatile dental_atmega::twi::Result lcdLastError = dental_atmega::twi::Result::kIdle;
volatile dental_link::rtc::State rtcState = dental_link::rtc::State::kUnavailable;
volatile dental_link::rtc::Reason rtcReason =
    dental_link::rtc::Reason::kCommunicationFailure;
dental_atmega::storage::RawCard microSd;
dental_atmega::storage::Link<dental_atmega::storage::RawCard> storageLink(microSd);

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
  static dental_atmega::lcd::WorkflowScreen lcdScreen;
  dental_atmega::ds3231::Driver<decltype(twi)> rtc(twi);
  dental_atmega::RtcLink rtcLink;
  rtc.begin();
  uint32_t lastRtcClockRefreshMs = dental_atmega::uart::milliseconds();
  sei();
  lcd.begin(dental_atmega::uart::milliseconds());
  // Card initialization belongs to the first SD:STATUS request. Performing
  // the bounded but blocking SPI reset here could consume the ESP32's first
  // RTC request timeout and overflow the small USART receive ring before the
  // request-processing loop has ever run.
  dental_atmega::ControllerTxScheduler txScheduler;
  // Reusable state stays off the already-constrained AVR main-loop stack.
  static dental_atmega::StatusFeedback statusFeedback;
  dental_atmega::PhysicalState previousPhysicalState = scanner.state();
  static dental_atmega::SmallStatus appliedSmall = dental_atmega::SmallStatus::OFF;
  static dental_atmega::BigStatus appliedBig = dental_atmega::BigStatus::OFF;
  for (;;) {
    // Bounded polling; neither missing PONG nor a stuck transmitter blocks main.
    uint8_t byte;
    bool error;
    for (uint8_t received = 0U; received < 8U; ++received) {
      if (!dental_atmega::uart::tryRead(byte, error)) break;
      if (error) link.receiveError();
      else {
        const uint32_t receivedAt = dental_atmega::uart::milliseconds();
        const dental_link::Frame frame = link.receive(receivedAt, byte);
        scanner.modeResponse(receivedAt, frame);
        lcdScreen.feedback(receivedAt, frame);
        if (frame == dental_link::Frame::kLcdDisplay)
          lcdScreen.displayFrame(receivedAt, link.payload());
        statusFeedback.receive(receivedAt, frame);
      }
      rtcLink.receive(byte, error, rtc);
      storageLink.receive(byte, error);
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
    txScheduler.service(now, storageLink, rtcLink, scanner, link, rtc,
                        transmitter);
    const dental_atmega::PhysicalState physicalState = scanner.state();
    if (physicalState != previousPhysicalState &&
        (physicalState == dental_atmega::PhysicalState::kDeliveryError ||
         physicalState == dental_atmega::PhysicalState::kStorageUnavailable ||
         physicalState == dental_atmega::PhysicalState::kModeRejected ||
         physicalState == dental_atmega::PhysicalState::kModeBusy))
      statusFeedback.localError(now);
    previousPhysicalState = physicalState;
    statusFeedback.service(now);
    if (statusFeedback.small() != appliedSmall) {
      dental_atmega::setSmallStatus(statusFeedback.small());
      appliedSmall = statusFeedback.small();
    }
    if (statusFeedback.big() != appliedBig) {
      dental_atmega::setBigStatus(statusFeedback.big());
      appliedBig = statusFeedback.big();
    }
    if (rtc.state() == dental_link::rtc::State::kReady && rtc.idle() &&
        !rtcLink.pending() &&
        static_cast<uint32_t>(now - lastRtcClockRefreshMs) >= 1000UL &&
        rtc.requestRead()) {
      lastRtcClockRefreshMs = now;
    }
    // Cooperative peripheral service after core input/transport processing.
    // LCD failure/status never participates in transaction acceptance.
    lcdScreen.service(now, scanner.state(), rtc.state(), rtc.time(), lcd);
    lcdState = lcd.state();
    lcdLastError = lcd.error();
    rtcState = rtc.state();
    rtcReason = rtc.reason();
  }
}
