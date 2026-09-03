#include <Arduino.h>
#include <HardwareSerial.h>

#include "hardware_config.h"
#include "protocol_config.h"

namespace {

constexpr uint32_t kScannerBaud = 9600UL;
constexpr uint32_t kBarcodeIdleTimeoutMs = 100UL;

constexpr uint8_t kGm65TriggerCommand[] = {
    0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01, 0xAB, 0xCD};
constexpr uint8_t kGm65Acknowledgement[] = {
    0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};

static_assert(sizeof(kGm65TriggerCommand) == 9U,
              "The GM65 trigger command must contain exactly nine bytes.");
static_assert(sizeof(kGm65Acknowledgement) == 7U,
              "The GM65 acknowledgement must contain exactly seven bytes.");

enum class ScannerState : uint8_t {
  kIdle,
  kWaitingForAcknowledgement,
  kWaitingForBarcode,
};

HardwareSerial scannerSerial(2);
ScannerState scannerState = ScannerState::kIdle;
size_t acknowledgementMatchIndex = 0U;
String barcodeBuffer;
uint32_t lastBarcodeByteMs = 0UL;

void drainScannerInput() {
  while (scannerSerial.available() > 0) {
    scannerSerial.read();
  }
}

void triggerScanner() {
  drainScannerInput();
  acknowledgementMatchIndex = 0U;
  barcodeBuffer = "";
  lastBarcodeByteMs = 0UL;
  scannerState = ScannerState::kWaitingForAcknowledgement;

  Serial.println("Sending GM65 trigger command");
  scannerSerial.write(kGm65TriggerCommand, sizeof(kGm65TriggerCommand));
  scannerSerial.flush();
}

void completeBarcode() {
  if (barcodeBuffer.length() == 0U) {
    return;
  }

  Serial.print("BARCODE RECEIVED: ");
  Serial.println(barcodeBuffer);
  Serial.print("Character count: ");
  Serial.println(barcodeBuffer.length());

  barcodeBuffer = "";
  lastBarcodeByteMs = 0UL;
  scannerState = ScannerState::kIdle;
}

void processAcknowledgementByte(uint8_t receivedByte) {
  if (receivedByte == kGm65Acknowledgement[acknowledgementMatchIndex]) {
    ++acknowledgementMatchIndex;
    if (acknowledgementMatchIndex == sizeof(kGm65Acknowledgement)) {
      acknowledgementMatchIndex = 0U;
      barcodeBuffer = "";
      lastBarcodeByteMs = 0UL;
      scannerState = ScannerState::kWaitingForBarcode;
      Serial.println("GM65 trigger acknowledgement received");
      Serial.println("Waiting for barcode scan");
    }
    return;
  }

  acknowledgementMatchIndex =
      receivedByte == kGm65Acknowledgement[0] ? 1U : 0U;
}

void processBarcodeByte(uint8_t receivedByte, uint32_t nowMs) {
  if (receivedByte == '\r' || receivedByte == '\n') {
    // Empty terminators, including the LF half of CRLF, are ignored.
    completeBarcode();
    return;
  }

  barcodeBuffer += static_cast<char>(receivedByte);
  lastBarcodeByteMs = nowMs;
}

void serviceScanner(uint32_t nowMs) {
  while (scannerSerial.available() > 0) {
    const uint8_t receivedByte =
        static_cast<uint8_t>(scannerSerial.read());

    if (scannerState == ScannerState::kWaitingForAcknowledgement) {
      processAcknowledgementByte(receivedByte);
    } else if (scannerState == ScannerState::kWaitingForBarcode) {
      processBarcodeByte(receivedByte, nowMs);
    }
  }

  if (scannerState == ScannerState::kWaitingForBarcode &&
      barcodeBuffer.length() > 0U &&
      nowMs - lastBarcodeByteMs >= kBarcodeIdleTimeoutMs) {
    completeBarcode();
  }
}

void serviceDebugSerial() {
  while (Serial.available() > 0) {
    const char command = static_cast<char>(Serial.read());
    if (command == 't') {
      triggerScanner();
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(dental::firmware::kSerialBaud);
  scannerSerial.begin(kScannerBaud, SERIAL_8N1,
                      dental::hardware::kScannerTestUartRxGpio,
                      dental::hardware::kScannerTestUartTxGpio);
  barcodeBuffer.reserve(256U);

  Serial.println();
  Serial.println("Dental Inventory System");
  Serial.println("GM65 Bidirectional Trigger Test");
  Serial.println("Scanner UART: RX GPIO16 / TX GPIO17");
  Serial.println("Scanner baud: 9600");
  Serial.println("Enter 't' to trigger the scanner");
}

void loop() {
  const uint32_t nowMs = millis();
  serviceDebugSerial();
  serviceScanner(nowMs);
  delay(1UL);
}
