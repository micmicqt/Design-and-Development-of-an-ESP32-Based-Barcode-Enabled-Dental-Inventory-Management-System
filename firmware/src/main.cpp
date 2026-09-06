#include <Arduino.h>
#include <FS.h>
#include <HardwareSerial.h>
#include <LiquidCrystal_I2C.h>
#include <RTClib.h>
#include <SD.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Wire.h>
#include <bootloader_random.h>
#include <esp_system.h>

#include "hardware_config.h"
#include "protocol_config.h"
#include "secrets.h"
#include "transaction_event_queue.h"

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
constexpr uint32_t kCommittedResultLcdFeedbackMs = 4000UL;
constexpr size_t kMaximumBarcodeLength = 256U;
constexpr uint16_t kHttpServerPort = 80U;
constexpr uint32_t kWiFiConnectionTimeoutMs = 15000UL;
constexpr uint32_t kWiFiRetryBackoffMs = 30000UL;
constexpr uint32_t kWiFiProgressIntervalMs = 2000UL;
constexpr uint8_t kDs3231StatusRegister = 0x0FU;
constexpr uint8_t kDs3231OscillatorStopFlag = 0x80U;
constexpr uint8_t kRtcStatusReadAttempts = 3U;
constexpr uint32_t kRtcStatusRetryDelayMs = 25UL;
using dental::events::AcknowledgementResult;
using dental::events::PendingTransactionEvent;
using dental::events::ResultApplicationResult;
using dental::events::StockIndicatorOutputs;
using dental::events::StockStatus;
using dental::events::TransactionResult;
using dental::events::TransactionResultQueue;
using dental::events::appendJsonString;
constexpr char kWiFiSsidPlaceholder[] = "replace-with-local-wifi-ssid";
constexpr char kWiFiPasswordPlaceholder[] =
    "replace-with-local-wifi-password";

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
  kShowingCommittedResult,
};

enum class CsvAppendResult : uint8_t {
  kSuccess,
  kOpenFailed,
  kWriteFailed,
};

enum class WiFiConnectionState : uint8_t {
  kDisabled,
  kConnecting,
  kWaitingToRetry,
  kConnected,
};

static_assert(kMaximumBarcodeLength == dental::events::kMaximumBarcodeLength,
              "The delivery queue must preserve the complete scanner barcode.");

LiquidCrystal_I2C lcd(dental::hardware::kLcdI2cAddress,
                      dental::hardware::kLcdColumnCount,
                      dental::hardware::kLcdRowCount);
RTC_DS3231 rtc;
HardwareSerial scannerSerial(2);
WebServer httpServer(kHttpServerPort);

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

WiFiConnectionState wiFiConnectionState = WiFiConnectionState::kDisabled;
uint32_t wiFiStateStartedMs = 0UL;
uint32_t lastWiFiProgressMs = 0UL;
bool httpServerRunning = false;

dental::events::PendingEventQueue pendingEvents;
uint64_t nextEventSequence = 1ULL;
char bootSessionIdentifier[40U] = {};

TransactionResultQueue committedResultFeedbacks;
TransactionResult activeCommittedResultFeedback =
    {{}, {}, 0U, 0ULL, StockStatus::kHigh};
bool committedResultIndicatorIsOn = false;

size_t acknowledgementMatchIndex = 0U;
String barcodeBuffer;
bool barcodeIsInvalid = false;
uint32_t lastBarcodeByteMs = 0UL;

void setStockStatusIndicator(StockStatus status);
void startNextCommittedResultFeedback(uint32_t nowMs);

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

const char* currentHttpMode() {
  if (workflowState == WorkflowState::kIdle) {
    return "idle";
  }
  if (activeTransaction == &kRestockTransaction) {
    return "restock";
  }
  if (activeTransaction == &kCheckoutTransaction) {
    return "checkout";
  }
  if (workflowState == WorkflowState::kShowingCommittedResult) {
    return activeCommittedResultFeedback.mode;
  }
  return "busy";
}

void initializeEventSession() {
  const uint64_t chipIdentifier = ESP.getEfuseMac();
  // setup calls this before peripherals/Wi-Fi start. Enable true hardware
  // entropy while RF is off, then disable it before any normal initialization.
  bootloader_random_enable();
  const uint32_t sessionRandomHigh = esp_random();
  const uint32_t sessionRandomLow = esp_random();
  bootloader_random_disable();
  snprintf(bootSessionIdentifier, sizeof(bootSessionIdentifier),
           "%04lX%08lX-%08lX%08lX",
           static_cast<unsigned long>((chipIdentifier >> 32U) & 0xFFFFU),
           static_cast<unsigned long>(chipIdentifier & 0xFFFFFFFFULL),
           static_cast<unsigned long>(sessionRandomHigh),
           static_cast<unsigned long>(sessionRandomLow));
  nextEventSequence = 1ULL;
  Serial.print("Hardware event boot session: ");
  Serial.println(bootSessionIdentifier);
}

const PendingTransactionEvent* oldestPendingEvent() {
  return pendingEvents.oldest();
}

String serializePendingEvent(const PendingTransactionEvent& event) {
  String response;
  response.reserve(384U);
  response += "{\"eventId\":";
  appendJsonString(response, event.eventId);
  response += ",\"mode\":";
  appendJsonString(response, event.mode);
  response += ",\"barcode\":";
  appendJsonString(response, event.barcode);
  response += ",\"timestamp\":";
  appendJsonString(response, event.timestamp);
  response += '}';
  return response;
}

bool enqueuePendingEvent(const TransactionProfile& transaction,
                         const char* timestamp, const String& barcode) {
  if (pendingEvents.full()) {
    Serial.println(
        "WARNING: Hardware event queue full; SD record preserved but live "
        "delivery unavailable");
    return false;
  }

  PendingTransactionEvent event = {};
  if (!dental::events::formatEventId(event.eventId, bootSessionIdentifier,
                                    nextEventSequence)) {
    Serial.println(
        "WARNING: Hardware event ID generation failed; SD record preserved "
        "but live delivery unavailable");
    return false;
  }

  const char* mode =
      &transaction == &kRestockTransaction ? "restock" : "checkout";
  snprintf(event.mode, sizeof(event.mode), "%s", mode);
  barcode.toCharArray(event.barcode, sizeof(event.barcode));
  snprintf(event.timestamp, sizeof(event.timestamp), "%s", timestamp);

  ++nextEventSequence;
  pendingEvents.enqueue(event);
  Serial.print("Hardware transaction event queued: ");
  Serial.println(event.eventId);
  return true;
}

void handleHealthRequest() {
  httpServer.send(
      200, "application/json",
      "{\"status\":\"ok\",\"device\":\"dental-inventory-esp32\",\"phase\":4}");
}

void handleStatusRequest() {
  String response;
  response.reserve(128U);
  response =
      "{\"device\":\"dental-inventory-esp32\",\"online\":true,\"mode\":\"";
  response += currentHttpMode();
  response += "\",\"rtc\":";
  response += rtcAvailable ? "true" : "false";
  response += ",\"sd\":";
  response += microSdAvailable ? "true" : "false";
  response += '}';

  httpServer.send(200, "application/json", response);
}

void handleNextEventRequest() {
  const PendingTransactionEvent* event = oldestPendingEvent();
  if (event == nullptr) {
    httpServer.send(204, "application/json", "");
    return;
  }

  httpServer.send(200, "application/json", serializePendingEvent(*event));
}

void sendAcknowledgementError(int statusCode, const char* errorCode) {
  String response = "{\"acknowledged\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void sendResultError(int statusCode, const char* errorCode) {
  String response = "{\"accepted\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void handleEventResultRequest() {
  TransactionResult requestedResult =
      {{}, {}, 0U, 0ULL, StockStatus::kHigh};
  const String body = httpServer.arg("plain");
  if (!dental::events::parseTransactionResultBody(
          body.c_str(), body.length(), requestedResult)) {
    sendResultError(400, "invalid_request");
    return;
  }

  // Classify before the capacity check so empty/mismatched/conflicting results
  // retain their precise response and never consume a feedback slot.
  const ResultApplicationResult classification =
      pendingEvents.classifyResult(requestedResult);
  if (classification == ResultApplicationResult::kApplied &&
      committedResultFeedbacks.full()) {
    sendResultError(503, "feedback_queue_full");
    return;
  }

  const ResultApplicationResult result =
      pendingEvents.applyResult(requestedResult);
  if (result == ResultApplicationResult::kEmpty) {
    sendResultError(404, "no_pending_event");
    return;
  }
  if (result == ResultApplicationResult::kEventIdMismatch) {
    sendResultError(409, "event_id_mismatch");
    return;
  }
  if (result == ResultApplicationResult::kModeMismatch) {
    sendResultError(409, "event_mode_mismatch");
    return;
  }
  if (result == ResultApplicationResult::kConflict) {
    sendResultError(409, "conflicting_result");
    return;
  }

  if (result == ResultApplicationResult::kApplied) {
    setStockStatusIndicator(requestedResult.stockStatus);
    if (!committedResultFeedbacks.enqueue(requestedResult)) {
      // The preflight check above and single-threaded WebServer dispatch make
      // this unreachable, but never write past the bounded queue.
      sendResultError(503, "feedback_queue_full");
      return;
    }
    Serial.print("Committed transaction result accepted: ");
    Serial.println(requestedResult.eventId);
    startNextCommittedResultFeedback(millis());
  } else {
    Serial.print("Identical committed transaction result already applied: ");
    Serial.println(requestedResult.eventId);
  }

  String response = "{\"accepted\":true,\"eventId\":";
  appendJsonString(response, requestedResult.eventId);
  response += '}';
  httpServer.send(200, "application/json", response);
}

void handleEventAcknowledgementRequest() {
  char requestedEventId[dental::events::kEventIdCapacity] = {};
  const String body = httpServer.arg("plain");
  if (!dental::events::parseAcknowledgementBody(
          body.c_str(), body.length(), requestedEventId)) {
    sendAcknowledgementError(400, "invalid_request");
    return;
  }

  const AcknowledgementResult result = pendingEvents.acknowledge(requestedEventId);
  if (result == AcknowledgementResult::kEmpty) {
    sendAcknowledgementError(404, "no_pending_event");
    return;
  }
  if (result == AcknowledgementResult::kMismatch) {
    sendAcknowledgementError(409, "event_id_mismatch");
    return;
  }

  String response = "{\"acknowledged\":true,\"eventId\":";
  appendJsonString(response, requestedEventId);
  response += '}';
  Serial.print("Hardware transaction event acknowledged: ");
  Serial.println(requestedEventId);
  httpServer.send(200, "application/json", response);
}

void configureHttpRoutes() {
  httpServer.on("/health", HTTP_GET, handleHealthRequest);
  httpServer.on("/status", HTTP_GET, handleStatusRequest);
  httpServer.on("/events/next", HTTP_GET, handleNextEventRequest);
  httpServer.on("/events/ack", HTTP_POST,
                handleEventAcknowledgementRequest);
  httpServer.on("/events/result", HTTP_POST, handleEventResultRequest);
}

bool wiFiCredentialsAreConfigured() {
  return strlen(WIFI_SSID) > 0U &&
         strcmp(WIFI_SSID, kWiFiSsidPlaceholder) != 0 &&
         strcmp(WIFI_PASSWORD, kWiFiPasswordPlaceholder) != 0;
}

void beginWiFiConnectionAttempt(uint32_t nowMs) {
  Serial.println("WiFi connection attempt started");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wiFiConnectionState = WiFiConnectionState::kConnecting;
  wiFiStateStartedMs = nowMs;
  lastWiFiProgressMs = nowMs;
}

void handleWiFiConnected() {
  wiFiConnectionState = WiFiConnectionState::kConnected;
  Serial.println("WiFi connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  httpServer.begin();
  httpServerRunning = true;
  Serial.println("HTTP server started on port 80");
}

void initializeWiFi() {
  configureHttpRoutes();

  if (!wiFiCredentialsAreConfigured()) {
    wiFiConnectionState = WiFiConnectionState::kDisabled;
    Serial.println(
        "WiFi credentials are not configured; hardware workflow remains available");
    return;
  }

  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);
  beginWiFiConnectionAttempt(millis());
}

void serviceWiFi(uint32_t nowMs) {
  if (wiFiConnectionState == WiFiConnectionState::kDisabled) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (wiFiConnectionState != WiFiConnectionState::kConnected) {
      handleWiFiConnected();
    }
    if (httpServerRunning) {
      httpServer.handleClient();
    }
    return;
  }

  if (wiFiConnectionState == WiFiConnectionState::kConnected) {
    if (httpServerRunning) {
      httpServer.stop();
      httpServerRunning = false;
    }
    Serial.println("WiFi disconnected; hardware workflow remains available");
    Serial.println("WiFi retry scheduled after 30 seconds");
    wiFiConnectionState = WiFiConnectionState::kWaitingToRetry;
    wiFiStateStartedMs = nowMs;
  }

  if (wiFiConnectionState == WiFiConnectionState::kConnecting) {
    if (nowMs - lastWiFiProgressMs >= kWiFiProgressIntervalMs) {
      lastWiFiProgressMs = nowMs;
      Serial.println("WiFi connection in progress...");
    }

    if (nowMs - wiFiStateStartedMs >= kWiFiConnectionTimeoutMs) {
      WiFi.disconnect(false, false);
      Serial.println(
          "WiFi connection timeout; hardware workflow remains available");
      Serial.println("WiFi retry scheduled after 30 seconds");
      wiFiConnectionState = WiFiConnectionState::kWaitingToRetry;
      wiFiStateStartedMs = nowMs;
    }
    return;
  }

  if (wiFiConnectionState == WiFiConnectionState::kWaitingToRetry &&
      nowMs - wiFiStateStartedMs >= kWiFiRetryBackoffMs) {
    beginWiFiConnectionAttempt(nowMs);
  }
}

bool i2cAddressResponds(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0U;
}

bool readDs3231StatusRegister(uint8_t& status) {
  for (uint8_t attempt = 1U; attempt <= kRtcStatusReadAttempts; ++attempt) {
    Wire.beginTransmission(dental::hardware::kDs3231I2cAddress);
    Wire.write(kDs3231StatusRegister);
    const uint8_t transmissionResult = Wire.endTransmission(false);
    const uint8_t receivedBytes =
        transmissionResult == 0U
            ? Wire.requestFrom(dental::hardware::kDs3231I2cAddress,
                               static_cast<uint8_t>(1U))
            : 0U;

    if (transmissionResult == 0U && receivedBytes == 1U &&
        Wire.available() == 1) {
      status = static_cast<uint8_t>(Wire.read());
      return true;
    }

    while (Wire.available() > 0) {
      Wire.read();
    }
    if (attempt < kRtcStatusReadAttempts) {
      delay(kRtcStatusRetryDelayMs);
    }
  }

  return false;
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

void setStockStatusIndicator(StockStatus status) {
  const StockIndicatorOutputs outputs =
      dental::events::stockIndicatorOutputs(status);

  // Pass through 00 before selecting a status so a previous status does not
  // remain visible during the two GPIO writes.
  digitalWrite(dental::hardware::kThreeIndicatorControlAGpio, LOW);
  digitalWrite(dental::hardware::kThreeIndicatorControlBGpio, LOW);
  digitalWrite(dental::hardware::kThreeIndicatorControlAGpio,
               outputs.controlA ? HIGH : LOW);
  digitalWrite(dental::hardware::kThreeIndicatorControlBGpio,
               outputs.controlB ? HIGH : LOW);
}

void startNextCommittedResultFeedback(uint32_t nowMs) {
  if (workflowState != WorkflowState::kIdle ||
      committedResultFeedbacks.size() == 0U) {
    return;
  }

  if (!committedResultFeedbacks.dequeue(activeCommittedResultFeedback)) return;

  char stockLine[32U] = {};
  snprintf(stockLine, sizeof(stockLine), "Stock: %llu",
           static_cast<unsigned long long>(
               activeCommittedResultFeedback.resultingStock));
  String quantityLine = "Qty: ";
  quantityLine += strcmp(activeCommittedResultFeedback.mode, "restock") == 0
                      ? "+"
                      : "-";
  quantityLine += String(activeCommittedResultFeedback.quantity);
  String statusLine = "Status: ";
  statusLine += dental::events::stockStatusName(
      activeCommittedResultFeedback.stockStatus);

  showLcdScreen(
      strcmp(activeCommittedResultFeedback.mode, "restock") == 0
          ? "RESTOCK SUCCESS"
          : "CHECKOUT SUCCESS",
      quantityLine, stockLine, statusLine);
  setSuccessIndicator();
  committedResultIndicatorIsOn = true;
  workflowState = WorkflowState::kShowingCommittedResult;
  workflowStateStartedMs = nowMs;
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

  // GPIO26/GPIO27 stay at 00 until an authoritative desktop result selects a
  // persistent HIGH, LOW, or EMPTY stock indication.
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

  enqueuePendingEvent(*activeTransaction, timestamp, barcodeBuffer);
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
  if (workflowState == WorkflowState::kShowingCommittedResult) {
    const uint32_t elapsedMs = nowMs - workflowStateStartedMs;
    if (committedResultIndicatorIsOn &&
        elapsedMs >= kIndicatorFeedbackMs) {
      setTransactionIndicatorOff();
      committedResultIndicatorIsOn = false;
    }

    if (elapsedMs >= kCommittedResultLcdFeedbackMs) {
      setTransactionIndicatorOff();
      committedResultIndicatorIsOn = false;
      workflowState = WorkflowState::kIdle;
      if (committedResultFeedbacks.size() > 0U) {
        startNextCommittedResultFeedback(nowMs);
      } else {
        showIdleScreen();
      }
    }
    return;
  }

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
      if (committedResultFeedbacks.size() > 0U) {
        startNextCommittedResultFeedback(nowMs);
      } else {
        showIdleScreen();
      }
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(dental::firmware::kSerialBaud);
  Serial.println();
  Serial.println("Dental Inventory System");
  Serial.println("Final Dual-Mode Integrated Hardware Diagnostic");
  initializeEventSession();

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
    uint8_t rtcStatus = 0U;
    if (!readDs3231StatusRegister(rtcStatus)) {
      Serial.println(
          "RTC initialization: FAILED - status register read failed");
    } else if ((rtcStatus & kDs3231OscillatorStopFlag) != 0U) {
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

  initializeWiFi();
}

void loop() {
  // Each service gets a fresh timestamp. The button or scanner service can
  // start a new timed state, so reusing an earlier sample would make unsigned
  // elapsed-time subtraction wrap and falsely expire that state immediately.
  serviceButtons(millis());
  serviceScanner(millis());
  serviceWorkflowTimeouts(millis());
  serviceWiFi(millis());
  delay(1UL);
}
