#include <Arduino.h>
#include <FS.h>
#include <HardwareSerial.h>
#include <LiquidCrystal_I2C.h>
#include <RTClib.h>
#include <SD.h>
#include <SPI.h>
#include <Wire.h>

#include "hardware_config.h"
#include "protocol_config.h"

namespace {

constexpr uint32_t kI2cClockHz = 100000UL;
constexpr uint32_t kScannerBaud = 9600UL;
constexpr uint32_t kMicroSdSpiFrequencyHz = 1000000UL;
constexpr uint8_t kMicroSdMountAttempts = 3U;
constexpr uint32_t kMicroSdRetryDelayMs = 250UL;
constexpr uint32_t kButtonDebounceMs = 50UL;
constexpr uint32_t kAcknowledgementTimeoutMs = 2000UL;
constexpr uint32_t kBarcodeTimeoutMs = 10000UL;
constexpr uint32_t kBarcodeIdleTimeoutMs = 100UL;
constexpr uint32_t kIndicatorFeedbackMs = 1000UL;
constexpr uint32_t kLcdFeedbackMs = 2000UL;
constexpr size_t kMaximumBarcodeLength = 256U;

struct TransactionProfile {
  uint8_t buttonGpio;
  const char* action;
  const char* modeTitle;
  const char* savedTitle;
  const char* lcdQuantity;
  const char* serialQuantity;
  const char* csvSuffix;
  const char* rtcReadFailure;
};

constexpr TransactionProfile kRestockTransaction = {
    dental::hardware::kRestockTestButtonGpio,
    "RESTOCK",
    "RESTOCK MODE",
    "RESTOCK SAVED",
    "Qty: +1",
    "Quantity: +1",
    ",RESTOCK,1\n",
    "RTC read failed; RESTOCK event was not saved",
};

constexpr TransactionProfile kCheckoutTransaction = {
    dental::hardware::kCheckoutTestButtonGpio,
    "CHECKOUT",
    "CHECKOUT MODE",
    "CHECKOUT SAVED",
    "Qty: -1",
    "Quantity: -1",
    ",CHECKOUT,1\n",
    "RTC read failed; CHECKOUT event was not saved",
};

constexpr char kIntegrationTestPath[] = "/integration_test.csv";
constexpr char kIntegrationTestHeader[] =
    "timestamp,barcode,action,quantity\n";

constexpr uint8_t kGm65TriggerCommand[] = {
    0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01, 0xAB, 0xCD};
constexpr uint8_t kGm65Acknowledgement[] = {
    0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};

static_assert(sizeof(kGm65TriggerCommand) == 9U,
              "The GM65 trigger command must contain exactly nine bytes.");
static_assert(sizeof(kGm65Acknowledgement) == 7U,
              "The GM65 acknowledgement must contain exactly seven bytes.");

enum class WorkflowState : uint8_t {
  kIdle,
  kWaitingForAcknowledgement,
  kWaitingForBarcode,
  kShowingFeedback,
};

enum class CsvAppendResult : uint8_t {
  kSuccess,
  kOpenFailed,
  kWriteFailed,
};

LiquidCrystal_I2C lcd(dental::hardware::kLcdI2cAddress,
                      dental::hardware::kLcdColumnCount,
                      dental::hardware::kLcdRowCount);
RTC_DS3231 rtc;
HardwareSerial scannerSerial(2);

bool lcdAvailable = false;
bool rtcAvailable = false;
bool microSdAvailable = false;

struct DebouncedButtonState {
  const TransactionProfile* transaction;
  int lastRawState;
  int stableState;
  uint32_t lastTransitionMs;
};

DebouncedButtonState restockButton = {
    &kRestockTransaction, HIGH, HIGH, 0UL};
DebouncedButtonState checkoutButton = {
    &kCheckoutTransaction, HIGH, HIGH, 0UL};

WorkflowState workflowState = WorkflowState::kIdle;
uint32_t workflowStateStartedMs = 0UL;
bool feedbackIndicatorIsOn = false;
const TransactionProfile* activeTransaction = nullptr;
bool buttonsMustBeReleased = false;

size_t acknowledgementMatchIndex = 0U;
String barcodeBuffer;
bool barcodeIsInvalid = false;
uint32_t lastBarcodeByteMs = 0UL;

void writePaddedLcdLine(uint8_t row, const String& text) {
  if (!lcdAvailable) {
    return;
  }

  char paddedLine[dental::hardware::kLcdColumnCount + 1U];
  snprintf(paddedLine, sizeof(paddedLine), "%-20.20s", text.c_str());
  lcd.setCursor(0, row);
  lcd.print(paddedLine);
}

void showLcdScreen(const String& line1, const String& line2,
                   const String& line3, const String& line4) {
  writePaddedLcdLine(0U, line1);
  writePaddedLcdLine(1U, line2);
  writePaddedLcdLine(2U, line3);
  writePaddedLcdLine(3U, line4);
}

void showInitializationScreen() {
  showLcdScreen("Any Time Dental", "Inventory System", "Initializing...", "");
}

void showIdleScreen() {
  showLcdScreen("Any Time Dental", "System Ready", "Restock / Checkout",
                "Press a button");
}

bool i2cAddressResponds(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0U;
}

void setTransactionIndicatorOff() {
  digitalWrite(dental::hardware::kTwoIndicatorControlAGpio, LOW);
  digitalWrite(dental::hardware::kTwoIndicatorControlBGpio, LOW);
}

void setSuccessIndicator() {
  // Set B before A so neither transaction LED flashes during the transition.
  digitalWrite(dental::hardware::kTwoIndicatorControlAGpio, LOW);
  digitalWrite(dental::hardware::kTwoIndicatorControlBGpio, HIGH);
  digitalWrite(dental::hardware::kTwoIndicatorControlAGpio, HIGH);
}

void setErrorIndicator() {
  digitalWrite(dental::hardware::kTwoIndicatorControlAGpio, LOW);
  digitalWrite(dental::hardware::kTwoIndicatorControlBGpio, LOW);
  digitalWrite(dental::hardware::kTwoIndicatorControlAGpio, HIGH);
}

void configureLedOutputs() {
  const uint8_t outputPins[] = {
      dental::hardware::kTwoIndicatorControlAGpio,
      dental::hardware::kTwoIndicatorControlBGpio,
      dental::hardware::kThreeIndicatorControlAGpio,
      dental::hardware::kThreeIndicatorControlBGpio,
  };

  for (const uint8_t pin : outputPins) {
    digitalWrite(pin, LOW);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  // GPIO26/GPIO27 remain LOW for this test; D3/D4/D5 are not exercised.
}

void resetScannerWorkflowBuffers() {
  acknowledgementMatchIndex = 0U;
  barcodeBuffer = "";
  barcodeIsInvalid = false;
  lastBarcodeByteMs = 0UL;
}

void drainScannerInput() {
  while (scannerSerial.available() > 0) {
    scannerSerial.read();
  }
}

void beginErrorFeedback(const char* serialReason, const char* lcdReason) {
  Serial.print("ERROR: ");
  Serial.println(serialReason);
  showLcdScreen("ERROR", lcdReason, "Try again", "Returning idle");
  setErrorIndicator();
  feedbackIndicatorIsOn = true;
  workflowState = WorkflowState::kShowingFeedback;
  workflowStateStartedMs = millis();
  resetScannerWorkflowBuffers();
}

void beginSuccessFeedback(const char* timestamp, const String& barcode) {
  Serial.print(activeTransaction->action);
  Serial.println(" EVENT SAVED");
  Serial.print("Timestamp: ");
  Serial.println(timestamp);
  Serial.print("Barcode: ");
  Serial.println(barcode);
  Serial.println(activeTransaction->serialQuantity);

  showLcdScreen(activeTransaction->savedTitle, barcode,
                activeTransaction->lcdQuantity, "Saved to SD");
  setSuccessIndicator();
  feedbackIndicatorIsOn = true;
  workflowState = WorkflowState::kShowingFeedback;
  workflowStateStartedMs = millis();
  resetScannerWorkflowBuffers();
}

bool ensureIntegrationTestFile() {
  if (SD.exists(kIntegrationTestPath)) {
    File existingFile = SD.open(kIntegrationTestPath, FILE_READ);
    if (!existingFile || existingFile.isDirectory()) {
      if (existingFile) {
        existingFile.close();
      }
      Serial.println(
          "MicroSD CSV initialization FAILED: existing path is not a file");
      return false;
    }
    existingFile.close();
    Serial.println("MicroSD CSV: existing integration_test.csv preserved");
    return true;
  }

  File newFile = SD.open(kIntegrationTestPath, FILE_WRITE);
  if (!newFile) {
    Serial.println("MicroSD CSV initialization FAILED: could not create file");
    return false;
  }

  const size_t expectedBytes = strlen(kIntegrationTestHeader);
  const size_t writtenBytes = newFile.print(kIntegrationTestHeader);
  newFile.flush();
  newFile.close();

  if (writtenBytes != expectedBytes) {
    Serial.println("MicroSD CSV initialization FAILED: header write failed");
    return false;
  }

  Serial.println("MicroSD CSV: integration_test.csv created with header");
  return true;
}

bool initializeMicroSd() {
  SPI.begin(dental::hardware::kMicroSdClockGpio,
            dental::hardware::kMicroSdMisoGpio,
            dental::hardware::kMicroSdMosiGpio,
            dental::hardware::kMicroSdChipSelectGpio);

  for (uint8_t attempt = 1U; attempt <= kMicroSdMountAttempts; ++attempt) {
    Serial.print("MicroSD mount attempt ");
    Serial.print(attempt);
    Serial.print('/');
    Serial.print(kMicroSdMountAttempts);
    Serial.print(" at ");
    Serial.print(kMicroSdSpiFrequencyHz);
    Serial.println(" Hz");

    if (SD.begin(dental::hardware::kMicroSdChipSelectGpio, SPI,
                 kMicroSdSpiFrequencyHz, "/sd", 5U, false)) {
      Serial.println("MicroSD initialization: SUCCESS");
      return ensureIntegrationTestFile();
    }

    Serial.println("MicroSD mount attempt FAILED");
    if (attempt < kMicroSdMountAttempts) {
      delay(kMicroSdRetryDelayMs);
    }
  }

  Serial.println("MicroSD initialization: FAILED after retries");
  return false;
}

CsvAppendResult appendTransactionEvent(const char* timestamp,
                                       const String& barcode) {
  File csvFile = SD.open(kIntegrationTestPath, FILE_APPEND);
  if (!csvFile || csvFile.isDirectory()) {
    if (csvFile) {
      csvFile.close();
    }
    return CsvAppendResult::kOpenFailed;
  }

  size_t writtenBytes = 0U;
  writtenBytes += csvFile.print(timestamp);
  writtenBytes += csvFile.print(',');
  writtenBytes += csvFile.print(barcode);
  writtenBytes += csvFile.print(activeTransaction->csvSuffix);
  csvFile.flush();
  csvFile.close();

  const size_t expectedBytes =
      strlen(timestamp) + 1U + barcode.length() +
      strlen(activeTransaction->csvSuffix);
  return writtenBytes == expectedBytes ? CsvAppendResult::kSuccess
                                       : CsvAppendResult::kWriteFailed;
}

bool readRtcTimestamp(char* destination, size_t destinationSize) {
  if (!rtcAvailable ||
      !i2cAddressResponds(dental::hardware::kDs3231I2cAddress)) {
    return false;
  }

  const DateTime now = rtc.now();
  if (!now.isValid()) {
    return false;
  }

  const int charactersWritten = snprintf(
      destination, destinationSize, "%04u-%02u-%02u %02u:%02u:%02u",
      static_cast<unsigned>(now.year()), static_cast<unsigned>(now.month()),
      static_cast<unsigned>(now.day()), static_cast<unsigned>(now.hour()),
      static_cast<unsigned>(now.minute()), static_cast<unsigned>(now.second()));
  return charactersWritten > 0 &&
         static_cast<size_t>(charactersWritten) < destinationSize;
}

bool barcodeContainsVisibleCharacter(const String& barcode) {
  for (size_t index = 0U; index < barcode.length(); ++index) {
    if (barcode[index] != ' ') {
      return true;
    }
  }
  return false;
}

void completeBarcode() {
  if (activeTransaction == nullptr) {
    beginErrorFeedback("No transaction action selected", "Mode unavailable");
    return;
  }

  if (barcodeIsInvalid || barcodeBuffer.length() == 0U ||
      !barcodeContainsVisibleCharacter(barcodeBuffer)) {
    beginErrorFeedback("Empty or invalid barcode received", "Invalid barcode");
    return;
  }

  char timestamp[20];
  if (!readRtcTimestamp(timestamp, sizeof(timestamp))) {
    beginErrorFeedback(activeTransaction->rtcReadFailure,
                       "RTC read failed");
    return;
  }

  const CsvAppendResult appendResult =
      appendTransactionEvent(timestamp, barcodeBuffer);
  if (appendResult == CsvAppendResult::kOpenFailed) {
    beginErrorFeedback("MicroSD file open failed; event was not saved",
                       "SD open failed");
    return;
  }
  if (appendResult == CsvAppendResult::kWriteFailed) {
    beginErrorFeedback("MicroSD append failed; event may be incomplete",
                       "SD write failed");
    return;
  }

  beginSuccessFeedback(timestamp, barcodeBuffer);
}

void processBarcodeByte(uint8_t receivedByte, uint32_t nowMs) {
  if (receivedByte == '\r' || receivedByte == '\n') {
    if (barcodeBuffer.length() == 0U && !barcodeIsInvalid) {
      return;
    }
    completeBarcode();
    return;
  }

  lastBarcodeByteMs = nowMs;
  if (receivedByte < 0x20U || receivedByte > 0x7EU || receivedByte == ',') {
    barcodeIsInvalid = true;
    return;
  }

  if (barcodeBuffer.length() >= kMaximumBarcodeLength) {
    barcodeIsInvalid = true;
    return;
  }

  barcodeBuffer += static_cast<char>(receivedByte);
}

void beginBarcodeWait(uint32_t nowMs) {
  Serial.println("GM65 trigger acknowledgement received");
  Serial.println("Waiting for barcode scan");
  barcodeBuffer = "";
  barcodeIsInvalid = false;
  lastBarcodeByteMs = 0UL;
  workflowState = WorkflowState::kWaitingForBarcode;
  workflowStateStartedMs = nowMs;
}

void processAcknowledgementByte(uint8_t receivedByte, uint32_t nowMs) {
  if (receivedByte == kGm65Acknowledgement[acknowledgementMatchIndex]) {
    ++acknowledgementMatchIndex;
    if (acknowledgementMatchIndex == sizeof(kGm65Acknowledgement)) {
      acknowledgementMatchIndex = 0U;
      beginBarcodeWait(nowMs);
    }
    return;
  }

  acknowledgementMatchIndex =
      receivedByte == kGm65Acknowledgement[0] ? 1U : 0U;
}

void serviceScanner(uint32_t nowMs) {
  while (scannerSerial.available() > 0) {
    const uint8_t receivedByte =
        static_cast<uint8_t>(scannerSerial.read());
    if (workflowState == WorkflowState::kWaitingForAcknowledgement) {
      processAcknowledgementByte(receivedByte, nowMs);
    } else if (workflowState == WorkflowState::kWaitingForBarcode) {
      processBarcodeByte(receivedByte, nowMs);
    }

    if (workflowState == WorkflowState::kShowingFeedback) {
      drainScannerInput();
      break;
    }
  }
}

void beginTransactionWorkflow(const TransactionProfile& transaction) {
  activeTransaction = &transaction;
  Serial.print(activeTransaction->action);
  Serial.println(" button pressed");
  showLcdScreen(activeTransaction->modeTitle, "Scanner starting...",
                "Scan barcode", "Please wait");

  if (!lcdAvailable) {
    beginErrorFeedback("LCD is unavailable", "LCD unavailable");
    return;
  }
  if (!rtcAvailable) {
    beginErrorFeedback("RTC is unavailable; event was not started",
                       "RTC unavailable");
    return;
  }
  if (!microSdAvailable) {
    beginErrorFeedback("MicroSD is unavailable; event was not started",
                       "SD unavailable");
    return;
  }

  drainScannerInput();
  resetScannerWorkflowBuffers();
  workflowState = WorkflowState::kWaitingForAcknowledgement;
  workflowStateStartedMs = millis();

  Serial.println("Scanner triggered - waiting for barcode");
  scannerSerial.write(kGm65TriggerCommand, sizeof(kGm65TriggerCommand));
  scannerSerial.flush();
}

bool updateButton(DebouncedButtonState& button, uint32_t nowMs) {
  const int rawState = digitalRead(button.transaction->buttonGpio);
  if (rawState != button.lastRawState) {
    button.lastRawState = rawState;
    button.lastTransitionMs = nowMs;
  }

  if (rawState != button.stableState &&
      nowMs - button.lastTransitionMs >= kButtonDebounceMs) {
    button.stableState = rawState;
    return button.stableState == LOW;
  }

  return false;
}

void serviceButtons(uint32_t nowMs) {
  const bool restockPressed = updateButton(restockButton, nowMs);
  const bool checkoutPressed = updateButton(checkoutButton, nowMs);

  if (workflowState != WorkflowState::kIdle &&
      (restockButton.lastRawState == LOW ||
       checkoutButton.lastRawState == LOW ||
       restockButton.stableState == LOW ||
       checkoutButton.stableState == LOW)) {
    // A press that begins while BUSY is discarded rather than queued. Both
    // buttons must return fully released before a later IDLE press is eligible.
    buttonsMustBeReleased = true;
  }

  if (buttonsMustBeReleased && restockButton.lastRawState == HIGH &&
      checkoutButton.lastRawState == HIGH &&
      restockButton.stableState == HIGH &&
      checkoutButton.stableState == HIGH) {
    buttonsMustBeReleased = false;
  }

  if (!restockPressed && !checkoutPressed) {
    return;
  }

  if (workflowState != WorkflowState::kIdle || buttonsMustBeReleased) {
    if (restockPressed) {
      Serial.println("RESTOCK button press ignored - system busy");
    }
    if (checkoutPressed) {
      Serial.println("CHECKOUT button press ignored - system busy");
    }
    return;
  }

  if (restockPressed && checkoutPressed) {
    // Deterministic priority for simultaneous debounced press events.
    buttonsMustBeReleased = true;
    Serial.println("Both buttons pressed - RESTOCK accepted");
    beginTransactionWorkflow(kRestockTransaction);
  } else if (restockPressed) {
    beginTransactionWorkflow(kRestockTransaction);
  } else {
    beginTransactionWorkflow(kCheckoutTransaction);
  }
}

void initializeButton(DebouncedButtonState& button) {
  pinMode(button.transaction->buttonGpio, INPUT_PULLUP);
  button.lastRawState = digitalRead(button.transaction->buttonGpio);
  button.stableState = button.lastRawState;
  button.lastTransitionMs = millis();

  Serial.print(button.transaction->action);
  Serial.print(" button initialization: SUCCESS - GPIO");
  Serial.println(button.transaction->buttonGpio);
}

void serviceWorkflowTimeouts(uint32_t nowMs) {
  if (workflowState == WorkflowState::kWaitingForAcknowledgement &&
      nowMs - workflowStateStartedMs >= kAcknowledgementTimeoutMs) {
    beginErrorFeedback("GM65 trigger acknowledgement timeout",
                       "Scanner no reply");
    return;
  }

  if (workflowState == WorkflowState::kWaitingForBarcode) {
    if ((barcodeBuffer.length() > 0U || barcodeIsInvalid) &&
        nowMs - lastBarcodeByteMs >= kBarcodeIdleTimeoutMs) {
      completeBarcode();
      return;
    }

    if (nowMs - workflowStateStartedMs >= kBarcodeTimeoutMs) {
      beginErrorFeedback("Barcode scan timeout; event was not saved",
                         "Scan timed out");
    }
    return;
  }

  if (workflowState == WorkflowState::kShowingFeedback) {
    const uint32_t elapsedMs = nowMs - workflowStateStartedMs;
    if (feedbackIndicatorIsOn && elapsedMs >= kIndicatorFeedbackMs) {
      setTransactionIndicatorOff();
      feedbackIndicatorIsOn = false;
    }

    if (elapsedMs >= kLcdFeedbackMs) {
      setTransactionIndicatorOff();
      feedbackIndicatorIsOn = false;
      drainScannerInput();
      resetScannerWorkflowBuffers();
      activeTransaction = nullptr;
      workflowState = WorkflowState::kIdle;
      showIdleScreen();
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(dental::firmware::kSerialBaud);
  Serial.println();
  Serial.println("Dental Inventory System");
  Serial.println("Final Dual-Mode Integrated Hardware Diagnostic");

  configureLedOutputs();
  Serial.println("LED initialization: SUCCESS - all indicators off");

  initializeButton(restockButton);
  initializeButton(checkoutButton);
  buttonsMustBeReleased = restockButton.stableState == LOW ||
                          checkoutButton.stableState == LOW;

  const bool wireInitialized =
      Wire.begin(dental::hardware::kI2cSdaGpio,
                 dental::hardware::kI2cSclGpio, kI2cClockHz);
  if (!wireInitialized) {
    Serial.println("I2C initialization: FAILED");
  } else {
    Serial.println("I2C initialization: SUCCESS - GPIO21/GPIO22 at 100000 Hz");
  }

  if (wireInitialized &&
      i2cAddressResponds(dental::hardware::kLcdI2cAddress)) {
    lcd.init();
    lcd.backlight();
    lcdAvailable = true;
    showInitializationScreen();
    Serial.println("LCD initialization: SUCCESS - 0x27 / 20x4");
  } else {
    Serial.println("LCD initialization: FAILED - no response at 0x27");
  }

  if (wireInitialized && rtc.begin(&Wire)) {
    if (rtc.lostPower()) {
      Serial.println(
          "RTC initialization: FAILED - lost-power flag set; time not modified");
    } else if (!rtc.now().isValid()) {
      Serial.println("RTC initialization: FAILED - retained time is invalid");
    } else {
      rtcAvailable = true;
      Serial.println("RTC initialization: SUCCESS - retained time preserved");
    }
  } else {
    Serial.println("RTC initialization: FAILED - DS3231 not responding");
  }

  microSdAvailable = initializeMicroSd();
  if (!microSdAvailable) {
    Serial.println("MicroSD workflow storage: UNAVAILABLE");
  } else {
    Serial.println("MicroSD workflow storage: READY");
  }

  scannerSerial.begin(kScannerBaud, SERIAL_8N1,
                      dental::hardware::kScannerTestUartRxGpio,
                      dental::hardware::kScannerTestUartTxGpio);
  barcodeBuffer.reserve(kMaximumBarcodeLength);
  Serial.println(
      "GM65 initialization: READY - UART2 RX GPIO16 / TX GPIO17 / 9600 8N1");

  if (!lcdAvailable) {
    beginErrorFeedback("Initialization failed: LCD unavailable",
                       "LCD unavailable");
  } else if (!rtcAvailable) {
    beginErrorFeedback("Initialization failed: RTC unavailable",
                       "RTC unavailable");
  } else if (!microSdAvailable) {
    beginErrorFeedback("Initialization failed: MicroSD unavailable",
                       "SD unavailable");
  } else {
    Serial.println("Integrated dual-mode workflow initialization: SUCCESS");
    showIdleScreen();
  }
}

void loop() {
  // Each service gets a fresh timestamp. The button or scanner service can
  // start a new timed state, so reusing an earlier sample would make unsigned
  // elapsed-time subtraction wrap and falsely expire that state immediately.
  serviceButtons(millis());
  serviceScanner(millis());
  serviceWorkflowTimeouts(millis());
  delay(1UL);
}
