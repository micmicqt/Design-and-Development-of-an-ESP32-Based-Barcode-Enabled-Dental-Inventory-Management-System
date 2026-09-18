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

#include "desktop_presence_lease.h"
#include "atmega_link.h"
#include "hardware_config.h"
#include "offline_inventory_cache.h"
#include "offline_pending_journal.h"
#include "protocol_config.h"
#include "registration_barcode_capture.h"
#include "rtc_recovery.h"
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
constexpr uint32_t kDesktopPresenceLeaseMs = 12000UL;
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
using dental::cache::BeginResult;
using dental::cache::CacheOperation;
using dental::cache::CacheRequest;
using dental::cache::CommitResult;
using dental::cache::ItemResult;
constexpr char kWiFiSsidPlaceholder[] = "replace-with-local-wifi-ssid";
constexpr char kWiFiPasswordPlaceholder[] =
    "replace-with-local-wifi-password";
constexpr char kDeviceTokenPlaceholder[] =
    "replace-with-a-random-shared-device-token";
const char* kCollectedHttpHeaders[] = {
    dental::protocol::kDeviceTokenHeader};

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
HardwareSerial atmegaSerial(1);
dental::controller_link::PingResponder atmegaResponder;
struct AtmegaTransmitter {
  bool tryWrite(uint8_t byte) {
    if (atmegaSerial.availableForWrite() < 1) return false;
    return atmegaSerial.write(byte) == 1U;
  }
} atmegaTransmitter;

void serviceAtmegaLink() {
  if (!dental::hardware::kAtmegaLinkEnabled) return;
  for (uint8_t processed = 0U; processed < 16U && atmegaSerial.available();
       ++processed) {
    if (atmegaResponder.receive(static_cast<uint8_t>(atmegaSerial.read()),
                                atmegaTransmitter) == dental_link::Frame::kScan) {
      // TEMPORARY Step 3A physical verification only. Never enqueue a transaction.
      Serial.print("ATmega scanner RX: ");
      Serial.println(atmegaResponder.barcode());
    }
  }
  atmegaResponder.service(atmegaTransmitter);
}
WebServer httpServer(kHttpServerPort);

bool lcdAvailable = false;
bool rtcAvailable = false;
bool microSdAvailable = false;
dental::rtc_recovery::Status rtcStatus = {
    dental::rtc_recovery::State::kUnavailable,
    dental::rtc_recovery::Reason::kCommunicationFailure};

class SdCacheStorage : public dental::cache::CacheStorage {
 public:
  bool available() const override { return microSdAvailable; }

  bool exists(const char* path) override { return SD.exists(path); }

  bool remove(const char* path) override { return SD.remove(path); }

  bool rename(const char* from, const char* to) override {
    return SD.rename(from, to);
  }

  bool writeFile(const char* path, const char* data, size_t length) override {
    File file = SD.open(path, FILE_WRITE);
    if (!file || file.isDirectory()) {
      if (file) file.close();
      return false;
    }
    const size_t written = file.write(
        reinterpret_cast<const uint8_t*>(data), length);
    file.flush();
    file.close();
    return written == length;
  }

  bool appendFile(const char* path, const char* data, size_t length) override {
    File file = SD.open(path, FILE_APPEND);
    if (!file || file.isDirectory()) {
      if (file) file.close();
      return false;
    }
    const size_t written = file.write(
        reinterpret_cast<const uint8_t*>(data), length);
    file.flush();
    file.close();
    return written == length;
  }

  bool beginRead(const char* path) override {
    endRead();
    readFile_ = SD.open(path, FILE_READ);
    if (!readFile_ || readFile_.isDirectory()) {
      endRead();
      return false;
    }
    return true;
  }

  dental::cache::ReadLineResult readLine(char* line,
                                          size_t capacity) override {
    if (!readFile_ || capacity == 0U) {
      return dental::cache::ReadLineResult::kError;
    }
    if (!readFile_.available()) {
      line[0] = '\0';
      return dental::cache::ReadLineResult::kEnd;
    }

    size_t written = 0U;
    bool tooLong = false;
    while (readFile_.available()) {
      const int input = readFile_.read();
      if (input < 0) return dental::cache::ReadLineResult::kError;
      const char value = static_cast<char>(input);
      if (value == '\n') break;
      if (value == '\r') continue;
      if (written + 1U >= capacity) {
        tooLong = true;
        continue;
      }
      line[written++] = value;
    }
    line[written] = '\0';
    return tooLong ? dental::cache::ReadLineResult::kTooLong
                   : dental::cache::ReadLineResult::kLine;
  }

  void endRead() override {
    if (readFile_) readFile_.close();
  }

 private:
  File readFile_;
};

class SdPendingJournalStorage
    : public dental::offline::PendingJournalStorage {
 public:
  bool available() const override { return microSdAvailable; }

  bool exists(const char* path) override { return SD.exists(path); }

  bool remove(const char* path) override { return SD.remove(path); }

  bool rename(const char* from, const char* to) override {
    return SD.rename(from, to);
  }

  bool writeFile(const char* path, const char* data, size_t length) override {
    File file = SD.open(path, FILE_WRITE);
    if (!file || file.isDirectory()) {
      if (file) file.close();
      return false;
    }
    const size_t written =
        file.write(reinterpret_cast<const uint8_t*>(data), length);
    file.flush();
    file.close();
    return written == length;
  }

  bool appendFile(const char* path, const char* data, size_t length) override {
    File file = SD.open(path, FILE_APPEND);
    if (!file || file.isDirectory()) {
      if (file) file.close();
      return false;
    }
    const size_t written =
        file.write(reinterpret_cast<const uint8_t*>(data), length);
    file.flush();
    file.close();
    return written == length;
  }

  bool beginRead(const char* path) override {
    endRead();
    readFile_ = SD.open(path, FILE_READ);
    if (!readFile_ || readFile_.isDirectory()) {
      endRead();
      return false;
    }
    return true;
  }

  dental::offline::JournalReadLineResult readLine(
      char* line, size_t capacity) override {
    using dental::offline::JournalReadLineResult;
    if (!readFile_ || capacity == 0U) {
      return JournalReadLineResult::kError;
    }
    if (!readFile_.available()) {
      line[0] = '\0';
      return JournalReadLineResult::kEnd;
    }

    size_t written = 0U;
    bool tooLong = false;
    bool terminated = false;
    while (readFile_.available()) {
      const int input = readFile_.read();
      if (input < 0) return JournalReadLineResult::kError;
      const char value = static_cast<char>(input);
      if (value == '\n') {
        terminated = true;
        break;
      }
      if (value == '\r') continue;
      if (written + 1U >= capacity) {
        tooLong = true;
        continue;
      }
      line[written++] = value;
    }
    line[written] = '\0';
    if (tooLong) {
      return terminated ? JournalReadLineResult::kTooLongTerminated
                        : JournalReadLineResult::kTooLongUnterminated;
    }
    return terminated ? JournalReadLineResult::kTerminatedLine
                      : JournalReadLineResult::kUnterminatedLine;
  }

  void endRead() override {
    if (readFile_) readFile_.close();
  }

 private:
  File readFile_;
};

SdCacheStorage cacheStorage;
dental::cache::OfflineInventoryCache offlineInventoryCache(cacheStorage);
SdPendingJournalStorage pendingJournalStorage;
dental::offline::OfflineCacheLookup offlineCacheLookup(cacheStorage);
dental::offline::PendingJournal offlinePendingJournal(pendingJournalStorage);
// These bounded records are reused by the single-threaded transaction state
// machine. Keeping them in static storage prevents maximum-size desktop fields
// from exhausting the Arduino loop task stack during nested SD validation.
dental::cache::CacheProduct offlineProductBuffer = {};
dental::offline::OfflineJournalRecord offlineCommittedRecordBuffer = {};
dental::offline::OfflineJournalRecord offlinePendingReadBuffer = {};

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
dental::offline::TransactionRoute activeTransactionRoute =
    dental::offline::TransactionRoute::kOnline;
bool transactionRouteCaptured = false;
char capturedCacheGeneration[dental::cache::kGenerationCapacity] = {};
uint32_t capturedCacheItemCount = 0U;

WiFiConnectionState wiFiConnectionState = WiFiConnectionState::kDisabled;
uint32_t wiFiStateStartedMs = 0UL;
uint32_t lastWiFiProgressMs = 0UL;
bool httpServerRunning = false;
dental::presence::DesktopPresenceLease desktopPresence(
    kDesktopPresenceLeaseMs);

dental::events::PendingEventQueue pendingEvents;
uint64_t nextEventSequence = 1ULL;
char bootSessionIdentifier[40U] = {};
char offlineDeviceIdentifier[dental::offline::kDeviceIdentifierCapacity] = {};

TransactionResultQueue committedResultFeedbacks;
TransactionResult activeCommittedResultFeedback =
    {{}, {}, 0U, 0ULL, StockStatus::kHigh};
bool committedResultIndicatorIsOn = false;

size_t acknowledgementMatchIndex = 0U;
String barcodeBuffer;
bool barcodeIsInvalid = false;
uint32_t lastBarcodeByteMs = 0UL;
dental::registration::BarcodeCapture registrationBarcodeCapture;
bool registrationCaptureOutcomeReported = false;

void setStockStatusIndicator(StockStatus status);
void startNextCommittedResultFeedback(uint32_t nowMs);
bool readDs3231StatusRegister(uint8_t& status);
void drainScannerInput();

StockStatus toEventStockStatus(dental::cache::StockStatus status) {
  switch (status) {
    case dental::cache::StockStatus::kHigh: return StockStatus::kHigh;
    case dental::cache::StockStatus::kLow: return StockStatus::kLow;
    case dental::cache::StockStatus::kEmpty: return StockStatus::kEmpty;
  }
  return StockStatus::kEmpty;
}

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

void showRtcSynchronizationRequiredScreen() {
  showLcdScreen("Any Time Dental", "RTC needs time", "Start desktop app",
                "to synchronize");
}

void setRtcStatus(dental::rtc_recovery::Status status) {
  rtcStatus = status;
  rtcAvailable = dental::rtc_recovery::timeIsTrusted(status);
}

const char* currentHttpMode() {
  if (registrationBarcodeCapture.active()) {
    return "busy";
  }
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

bool offlineTransactionIsActive() {
  return activeTransaction != nullptr &&
         activeTransactionRoute == dental::offline::TransactionRoute::kOffline;
}

bool offlineOperationIsReady() {
  const dental::cache::CacheMetadata& cacheMetadata =
      offlineInventoryCache.metadata();
  return lcdAvailable && rtcAvailable && microSdAvailable &&
         cacheMetadata.available &&
         offlinePendingJournal.compatibleWith(cacheMetadata);
}

bool requestIsInstalledCacheNoOp(const CacheRequest& request) {
  const dental::cache::CacheMetadata& cacheMetadata =
      offlineInventoryCache.metadata();
  return request.operation == CacheOperation::kBegin &&
         cacheMetadata.available &&
         request.itemCount == cacheMetadata.itemCount &&
         strcmp(request.generation, cacheMetadata.generation) == 0;
}

void initializeEventSession() {
  const uint64_t chipIdentifier = ESP.getEfuseMac();
  if (!dental::offline::formatDeviceIdentifier(chipIdentifier,
                                                offlineDeviceIdentifier)) {
    offlineDeviceIdentifier[0] = '\0';
  }
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
  if (offlineDeviceIdentifier[0] != '\0') {
    Serial.print("Offline journal device identifier: ");
    Serial.println(offlineDeviceIdentifier);
  } else {
    Serial.println("Offline journal device identifier: UNAVAILABLE");
  }
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
  response.reserve(384U);
  response =
      "{\"device\":\"dental-inventory-esp32\",\"online\":true,\"mode\":\"";
  response += currentHttpMode();
  response += "\",\"rtc\":";
  response += rtcAvailable ? "true" : "false";
  response += ",\"rtcState\":";
  appendJsonString(response,
                   dental::rtc_recovery::stateName(rtcStatus.state));
  response += ",\"rtcReason\":";
  appendJsonString(response,
                   dental::rtc_recovery::reasonName(rtcStatus.reason));
  response += ",\"sd\":";
  response += microSdAvailable ? "true" : "false";
  response += ",\"desktopOnline\":";
  response += desktopPresence.desktopAvailable() ? "true" : "false";
  const dental::cache::CacheMetadata& cacheMetadata =
      offlineInventoryCache.metadata();
  response += ",\"offlineCacheAvailable\":";
  response += cacheMetadata.available ? "true" : "false";
  response += ",\"offlineCacheGeneration\":";
  if (cacheMetadata.available) {
    appendJsonString(response, cacheMetadata.generation);
  } else {
    response += "null";
  }
  response += ",\"offlineCacheItems\":";
  response += cacheMetadata.available ? String(cacheMetadata.itemCount) : "0";
  const dental::offline::PendingJournalMetadata& journalMetadata =
      offlinePendingJournal.metadata();
  if (journalMetadata.available && !offlinePendingJournal.uncertain()) {
    response += ",\"pendingSyncItems\":";
    response += String(journalMetadata.pendingCount);
    response += ",\"offlineReady\":";
    response += offlineOperationIsReady() ? "true" : "false";
  }
  response += '}';

  httpServer.send(200, "application/json", response);
}

void handleDesktopHeartbeatRequest() {
  desktopPresence.recordHeartbeat(millis());
  httpServer.send(200, "application/json", "{\"desktopOnline\":true}");
}

bool deviceTokenIsConfigured() {
  return strlen(DENTAL_DEVICE_TOKEN) >= 32U &&
         strcmp(DENTAL_DEVICE_TOKEN, kDeviceTokenPlaceholder) != 0;
}

bool deviceRequestIsAuthenticated() {
  if (!deviceTokenIsConfigured() ||
      !httpServer.hasHeader(dental::protocol::kDeviceTokenHeader)) {
    return false;
  }
  const String suppliedToken =
      httpServer.header(dental::protocol::kDeviceTokenHeader);
  return dental::rtc_recovery::constantTimeTokenMatches(
      DENTAL_DEVICE_TOKEN, suppliedToken.c_str());
}

void sendRtcSyncError(int statusCode, const char* errorCode) {
  String response = "{\"synchronized\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void sendRtcSyncSuccess(bool alreadyReady) {
  String response =
      "{\"synchronized\":true,\"rtcState\":\"ready\",\"alreadyReady\":";
  response += alreadyReady ? "true" : "false";
  response += '}';
  httpServer.send(200, "application/json", response);
}

void handleRtcSyncRequest() {
  if (!deviceTokenIsConfigured()) {
    sendRtcSyncError(503, "authentication_unconfigured");
    return;
  }
  if (!deviceRequestIsAuthenticated()) {
    sendRtcSyncError(401, "unauthorized");
    return;
  }

  dental::rtc_recovery::SyncRequest request = {};
  const String body = httpServer.arg("plain");
  if (!dental::rtc_recovery::parseSyncRequest(body.c_str(), body.length(),
                                               request)) {
    sendRtcSyncError(400, "invalid_timestamp");
    return;
  }

  if (rtcStatus.state == dental::rtc_recovery::State::kUnavailable) {
    sendRtcSyncError(503, "rtc_unavailable");
    return;
  }
  if (rtcStatus.state == dental::rtc_recovery::State::kReady) {
    // A lost response can be retried safely without rewriting a healthy RTC.
    sendRtcSyncSuccess(true);
    return;
  }

  rtc.adjust(DateTime(request.localEpochSeconds));

  uint8_t statusRegister = 0U;
  const bool statusReadable = readDs3231StatusRegister(statusRegister);
  if (!statusReadable) {
    setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                  dental::rtc_recovery::Reason::kCommunicationFailure});
    Serial.println("RTC synchronization: FAILED - status reread failed");
    sendRtcSyncError(503, "rtc_unavailable");
    return;
  }

  const DateTime observed = rtc.now();
  const bool oscillatorStopped =
      (statusRegister & kDs3231OscillatorStopFlag) != 0U;
  if (!dental::rtc_recovery::synchronizationVerified(
          request.localEpochSeconds, true, oscillatorStopped,
          observed.isValid(), observed.unixtime())) {
    setRtcStatus(
        {dental::rtc_recovery::State::kNeedsSync,
         oscillatorStopped
             ? dental::rtc_recovery::Reason::kLostPower
             : dental::rtc_recovery::Reason::kVerificationFailed});
    Serial.println("RTC synchronization: FAILED - verification failed");
    sendRtcSyncError(500, "verification_failed");
    return;
  }

  setRtcStatus({dental::rtc_recovery::State::kReady,
                dental::rtc_recovery::Reason::kNone});
  Serial.println("RTC synchronization: SUCCESS - desktop time verified");
  if (workflowState == WorkflowState::kIdle && lcdAvailable) {
    showIdleScreen();
  }
  sendRtcSyncSuccess(false);
}

void sendBarcodeCaptureError(int statusCode, const char* errorCode) {
  String response = "{\"captured\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void handleStartBarcodeCaptureRequest() {
  if (!deviceTokenIsConfigured()) {
    sendBarcodeCaptureError(503, "authentication_unconfigured");
    return;
  }
  if (!deviceRequestIsAuthenticated()) {
    sendBarcodeCaptureError(401, "unauthorized");
    return;
  }
  if (!dental::hardware::kScannerUartEnabled) {
    sendBarcodeCaptureError(503, "scanner_unavailable");
    return;
  }
  if (workflowState != WorkflowState::kIdle ||
      registrationBarcodeCapture.active()) {
    sendBarcodeCaptureError(409, "scanner_busy");
    return;
  }

  drainScannerInput();
  if (!registrationBarcodeCapture.start(millis())) {
    sendBarcodeCaptureError(409, "scanner_busy");
    return;
  }
  registrationCaptureOutcomeReported = false;
  showLcdScreen("REGISTER PRODUCT", "Scanner starting...", "Scan barcode",
                "Please wait");
  scannerSerial.write(kGm65TriggerCommand, sizeof(kGm65TriggerCommand));
  scannerSerial.flush();
  Serial.println("Registration barcode capture started");
  httpServer.send(200, "application/json", "{\"started\":true}");
}

void handleReadBarcodeCaptureRequest() {
  if (!deviceTokenIsConfigured()) {
    sendBarcodeCaptureError(503, "authentication_unconfigured");
    return;
  }
  if (!deviceRequestIsAuthenticated()) {
    sendBarcodeCaptureError(401, "unauthorized");
    return;
  }

  using dental::registration::CaptureState;
  const CaptureState state = registrationBarcodeCapture.state();
  if (state == CaptureState::kIdle || registrationBarcodeCapture.active()) {
    httpServer.send(204);
    return;
  }
  if (state == CaptureState::kFailed) {
    sendBarcodeCaptureError(
        409, dental::registration::failureCode(
                 registrationBarcodeCapture.failure()));
    return;
  }

  String response = "{\"captured\":true,\"barcode\":";
  appendJsonString(response, registrationBarcodeCapture.barcode());
  response += '}';
  httpServer.send(200, "application/json", response);
}

const char* cacheOperationName(CacheOperation operation) {
  switch (operation) {
    case CacheOperation::kBegin: return "begin";
    case CacheOperation::kItem: return "item";
    case CacheOperation::kCommit: return "commit";
  }
  return "";
}

void sendCacheError(int statusCode, const char* errorCode) {
  String response = "{\"accepted\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

bool compactAcknowledgedJournalAfterCacheRefresh() {
  const dental::offline::PendingJournalMetadata& metadata =
      offlinePendingJournal.metadata();
  if (!metadata.available || offlinePendingJournal.uncertain() ||
      metadata.pendingCount != 0U || metadata.storedCount == 0U) {
    return true;
  }
  const dental::offline::JournalCompactionResult result =
      offlinePendingJournal.compactAcknowledgedPrefix();
  if (result ==
          dental::offline::JournalCompactionResult::kCompacted ||
      result ==
          dental::offline::JournalCompactionResult::kAlreadyCompacted) {
    Serial.println(
        "Pending offline journal: acknowledged prefix compacted");
    return true;
  }
  if (result ==
      dental::offline::JournalCompactionResult::kJournalUnavailable) {
    sendCacheError(503, "pending_journal_unavailable");
  } else {
    sendCacheError(500, "pending_journal_compaction_failed");
  }
  return false;
}

void sendCacheSuccess(const CacheRequest& request, uint32_t receivedItems,
                      bool alreadyCurrent) {
  String response;
  response.reserve(220U);
  response = "{\"accepted\":true,\"operation\":";
  appendJsonString(response, cacheOperationName(request.operation));
  response += ",\"generation\":";
  appendJsonString(response, request.generation);
  response += ",\"receivedItems\":";
  response += String(receivedItems);
  response += ",\"alreadyCurrent\":";
  response += alreadyCurrent ? "true" : "false";
  response += '}';
  httpServer.send(200, "application/json", response);
}

void handleOfflineCacheRequest() {
  const String body = httpServer.arg("plain");
  CacheRequest request = {};
  if (!dental::cache::parseCacheRequest(body.c_str(), body.length(), request)) {
    sendCacheError(400, "invalid_request");
    return;
  }
  if (!microSdAvailable) {
    sendCacheError(503, "storage_unavailable");
    return;
  }

  // An identical begin request is a true no-op and retains Step 2A retry
  // semantics. Any operation that could replace or advance a cache transfer is
  // interlocked while an offline scan is using the installed generation or
  // while pending/uncertain journal data still refers to that generation.
  const bool installedNoOp = requestIsInstalledCacheNoOp(request);
  if (offlineTransactionIsActive() && !installedNoOp) {
    sendCacheError(409, "offline_transaction_active");
    return;
  }
  if (offlinePendingJournal.blocksCacheReplacement() && !installedNoOp) {
    sendCacheError(409, "pending_sync_interlock");
    return;
  }

  if (request.operation == CacheOperation::kBegin) {
    const BeginResult result = offlineInventoryCache.begin(
        request.generation, request.itemCount);
    if (result == BeginResult::kStorageUnavailable) {
      sendCacheError(503, "storage_unavailable");
      return;
    }
    if (result == BeginResult::kWriteFailed) {
      sendCacheError(500, "cache_write_failed");
      return;
    }
    const bool alreadyCurrent = result == BeginResult::kAlreadyCurrent;
    // An already-current begin is the complete cache-install handshake. The
    // desktop intentionally sends no item/commit requests in this case, which
    // also covers a drained offline batch whose net stock delta is zero.
    if (alreadyCurrent &&
        !compactAcknowledgedJournalAfterCacheRefresh()) {
      return;
    }
    sendCacheSuccess(request, offlineInventoryCache.receivedItems(),
                     alreadyCurrent);
    return;
  }

  if (request.operation == CacheOperation::kItem) {
    const ItemResult result = offlineInventoryCache.item(
        request.generation, request.index, request.product);
    if (result == ItemResult::kNoTransfer) {
      sendCacheError(409, "no_active_transfer");
      return;
    }
    if (result == ItemResult::kGenerationMismatch) {
      sendCacheError(409, "generation_mismatch");
      return;
    }
    if (result == ItemResult::kUnexpectedIndex) {
      sendCacheError(409, "unexpected_index");
      return;
    }
    if (result == ItemResult::kConflictingItem) {
      sendCacheError(409, "conflicting_item");
      return;
    }
    if (result == ItemResult::kWriteFailed) {
      sendCacheError(500, "cache_write_failed");
      return;
    }
    sendCacheSuccess(request, offlineInventoryCache.receivedItems(), false);
    return;
  }

  const CommitResult result = offlineInventoryCache.commit(
      request.generation, request.itemCount);
  if (result == CommitResult::kStorageUnavailable) {
    sendCacheError(503, "storage_unavailable");
    return;
  }
  if (result == CommitResult::kNoTransfer) {
    sendCacheError(409, "no_active_transfer");
    return;
  }
  if (result == CommitResult::kGenerationMismatch) {
    sendCacheError(409, "generation_mismatch");
    return;
  }
  if (result == CommitResult::kCountMismatch) {
    sendCacheError(409, "item_count_mismatch");
    return;
  }
  if (result == CommitResult::kValidationFailed) {
    sendCacheError(422, "cache_validation_failed");
    return;
  }
  if (result == CommitResult::kReplacementFailed) {
    sendCacheError(500, "cache_replacement_failed");
    return;
  }
  const bool alreadyCurrent = result == CommitResult::kAlreadyCurrent;
  if (!compactAcknowledgedJournalAfterCacheRefresh()) return;
  sendCacheSuccess(request, request.itemCount, alreadyCurrent);
  if (!alreadyCurrent) {
    Serial.print("Offline inventory cache installed: ");
    Serial.print(request.generation);
    Serial.print(" / items: ");
    Serial.println(request.itemCount);
  }
}

void handleNextEventRequest() {
  const PendingTransactionEvent* event = oldestPendingEvent();
  if (event == nullptr) {
    httpServer.send(204, "application/json", "");
    return;
  }

  httpServer.send(200, "application/json", serializePendingEvent(*event));
}

void sendOfflinePendingReadError(int statusCode, const char* errorCode) {
  String response = "{\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void handleNextOfflineEventRequest() {
  const dental::offline::JournalPeekResult result =
      offlinePendingJournal.peekOldest(offlinePendingReadBuffer);
  if (result == dental::offline::JournalPeekResult::kEmpty) {
    httpServer.send(204, "application/json", "");
    return;
  }
  if (result == dental::offline::JournalPeekResult::kJournalUnavailable) {
    sendOfflinePendingReadError(503, "pending_journal_unavailable");
    return;
  }
  if (result != dental::offline::JournalPeekResult::kFound) {
    sendOfflinePendingReadError(500, "pending_journal_invalid");
    return;
  }

  String response;
  response.reserve(1024U);
  dental::offline::appendPendingEventJson(response, offlinePendingReadBuffer);
  httpServer.send(200, "application/json", response);
}

void sendAcknowledgementError(int statusCode, const char* errorCode) {
  String response = "{\"acknowledged\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void handleOfflineEventAcknowledgementRequest() {
  char requestedEventId[dental::events::kEventIdCapacity] = {};
  const String body = httpServer.arg("plain");
  if (!dental::events::parseAcknowledgementBody(
          body.c_str(), body.length(), requestedEventId)) {
    sendAcknowledgementError(400, "invalid_request");
    return;
  }

  const dental::offline::JournalAcknowledgementResult result =
      offlinePendingJournal.acknowledgeOldest(requestedEventId);
  if (result ==
      dental::offline::JournalAcknowledgementResult::kEmpty) {
    sendAcknowledgementError(404, "no_pending_event");
    return;
  }
  if (result ==
      dental::offline::JournalAcknowledgementResult::kMismatch) {
    sendAcknowledgementError(409, "event_id_mismatch");
    return;
  }
  if (result == dental::offline::JournalAcknowledgementResult::
                    kJournalUnavailable) {
    sendAcknowledgementError(503, "pending_journal_unavailable");
    return;
  }
  if (result ==
          dental::offline::JournalAcknowledgementResult::kInvalidJournal ||
      result ==
          dental::offline::JournalAcknowledgementResult::kWriteFailed) {
    sendAcknowledgementError(500, "pending_journal_invalid");
    return;
  }

  const bool alreadyAcknowledged =
      result == dental::offline::JournalAcknowledgementResult::
                    kAlreadyAcknowledged;
  String response;
  response.reserve(160U);
  dental::offline::appendOfflineAcknowledgementJson(
      response, requestedEventId,
      offlinePendingJournal.metadata().pendingCount, alreadyAcknowledged);
  Serial.print(alreadyAcknowledged
                   ? "Offline transaction ACK replay accepted: "
                   : "Offline transaction event acknowledged: ");
  Serial.println(requestedEventId);
  httpServer.send(200, "application/json", response);
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
  httpServer.on("/desktop/heartbeat", HTTP_POST,
                handleDesktopHeartbeatRequest);
  httpServer.on("/rtc/sync", HTTP_POST, handleRtcSyncRequest);
  httpServer.on("/barcode/capture", HTTP_POST,
                handleStartBarcodeCaptureRequest);
  httpServer.on("/barcode/capture", HTTP_GET,
                handleReadBarcodeCaptureRequest);
  httpServer.on("/offline/cache", HTTP_POST, handleOfflineCacheRequest);
  httpServer.on("/offline/events/next", HTTP_GET,
                handleNextOfflineEventRequest);
  httpServer.on("/offline/events/ack", HTTP_POST,
                handleOfflineEventAcknowledgementRequest);
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
  httpServer.collectHeaders(kCollectedHttpHeaders,
                            sizeof(kCollectedHttpHeaders) /
                                sizeof(kCollectedHttpHeaders[0]));

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
    desktopPresence.setNetworkConnected(false);
    return;
  }

  const bool wiFiConnected = WiFi.status() == WL_CONNECTED;
  desktopPresence.setNetworkConnected(wiFiConnected);
  desktopPresence.service(nowMs);

  if (wiFiConnected) {
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
  if (!dental::hardware::kScannerUartEnabled) return;
  while (scannerSerial.available() > 0) {
    scannerSerial.read();
  }
}

void reportRegistrationCaptureOutcome() {
  if (registrationCaptureOutcomeReported ||
      registrationBarcodeCapture.active()) {
    return;
  }

  using dental::registration::CaptureState;
  if (registrationBarcodeCapture.state() == CaptureState::kComplete) {
    Serial.print("REGISTRATION BARCODE RECEIVED: ");
    Serial.println(registrationBarcodeCapture.barcode());
    showLcdScreen("BARCODE CAPTURED", registrationBarcodeCapture.barcode(),
                  "Review on desktop", "No stock changed");
    registrationCaptureOutcomeReported = true;
  } else if (registrationBarcodeCapture.state() == CaptureState::kFailed) {
    const char* failure = dental::registration::failureCode(
        registrationBarcodeCapture.failure());
    Serial.print("Registration barcode capture failed: ");
    Serial.println(failure);
    showLcdScreen("SCAN ERROR", failure, "Try scan again", "No stock changed");
    registrationCaptureOutcomeReported = true;
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

void beginOfflineSuccessFeedback(
    const dental::offline::OfflineJournalRecord& record) {
  char stockLine[32U] = {};
  snprintf(stockLine, sizeof(stockLine), "Stock: %llu",
           static_cast<unsigned long long>(record.resultingStock));
  String statusLine = "Status: ";
  statusLine += dental::cache::stockStatusName(record.resultingStatus);

  Serial.print("OFFLINE ");
  Serial.print(activeTransaction->action);
  Serial.println(" EVENT SAVED");
  Serial.print("Event ID: ");
  Serial.println(record.eventId);
  Serial.print("Timestamp: ");
  Serial.println(record.timestamp);
  Serial.print("Barcode: ");
  Serial.println(record.barcode);
  Serial.println(activeTransaction->serialQuantity);
  Serial.print("Resulting stock: ");
  Serial.println(static_cast<unsigned long long>(record.resultingStock));
  Serial.print("Status: ");
  Serial.println(dental::cache::stockStatusName(record.resultingStatus));

  String title = "OFFLINE ";
  title += activeTransaction->action;
  showLcdScreen(title, activeTransaction->lcdQuantity, stockLine, statusLine);
  setStockStatusIndicator(toEventStockStatus(record.resultingStatus));
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
  if (!rtcAvailable) {
    return false;
  }
  if (!i2cAddressResponds(dental::hardware::kDs3231I2cAddress)) {
    setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                  dental::rtc_recovery::Reason::kCommunicationFailure});
    return false;
  }

  uint8_t statusRegister = 0U;
  if (!readDs3231StatusRegister(statusRegister)) {
    setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                  dental::rtc_recovery::Reason::kCommunicationFailure});
    return false;
  }
  if ((statusRegister & kDs3231OscillatorStopFlag) != 0U) {
    setRtcStatus({dental::rtc_recovery::State::kNeedsSync,
                  dental::rtc_recovery::Reason::kLostPower});
    return false;
  }

  const DateTime now = rtc.now();
  if (!now.isValid()) {
    setRtcStatus({dental::rtc_recovery::State::kNeedsSync,
                  dental::rtc_recovery::Reason::kInvalidTime});
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

void completeOfflineBarcode(const char* timestamp) {
  const dental::cache::CacheMetadata& cacheMetadata =
      offlineInventoryCache.metadata();
  if (!transactionRouteCaptured || !cacheMetadata.available ||
      cacheMetadata.itemCount != capturedCacheItemCount ||
      strcmp(cacheMetadata.generation, capturedCacheGeneration) != 0) {
    beginErrorFeedback("Offline cache generation changed", "Cache changed");
    return;
  }

  offlineProductBuffer = dental::cache::CacheProduct{};
  dental::cache::CacheProduct& product = offlineProductBuffer;
  const dental::offline::CacheLookupResult lookupResult =
      offlineCacheLookup.find(cacheMetadata, barcodeBuffer.c_str(), product);
  if (lookupResult == dental::offline::CacheLookupResult::kNotFound) {
    beginErrorFeedback("Offline barcode not found", "ITEM NOT FOUND");
    return;
  }
  if (lookupResult ==
      dental::offline::CacheLookupResult::kStorageUnavailable) {
    beginErrorFeedback("Offline cache storage unavailable", "SD unavailable");
    return;
  }
  if (lookupResult ==
      dental::offline::CacheLookupResult::kCacheUnavailable) {
    beginErrorFeedback("Offline inventory cache unavailable",
                       "Cache unavailable");
    return;
  }
  if (lookupResult != dental::offline::CacheLookupResult::kFound) {
    beginErrorFeedback("Offline inventory cache validation failed",
                       "Cache invalid");
    return;
  }

  uint64_t currentStock = 0ULL;
  const dental::offline::OverlayResult overlayResult =
      offlinePendingJournal.deriveCurrentStock(
          product, capturedCacheGeneration, currentStock);
  if (overlayResult == dental::offline::OverlayResult::kGenerationMismatch) {
    beginErrorFeedback("Pending journal cache generation mismatch",
                       "Cache mismatch");
    return;
  }
  if (overlayResult == dental::offline::OverlayResult::kStockInvalid) {
    beginErrorFeedback("Pending journal stock chain is invalid",
                       "Journal invalid");
    return;
  }
  if (overlayResult != dental::offline::OverlayResult::kSuccess) {
    beginErrorFeedback("Pending offline journal unavailable",
                       "Journal unavailable");
    return;
  }

  const dental::offline::OfflineAction action =
      activeTransaction == &kRestockTransaction
          ? dental::offline::OfflineAction::kRestock
          : dental::offline::OfflineAction::kCheckout;
  uint64_t resultingStock = currentStock;
  dental::cache::StockStatus resultingStatus =
      dental::offline::deriveStockStatus(currentStock,
                                         product.lowStockThreshold);
  const dental::offline::OfflineStockResult stockResult =
      dental::offline::calculateOfflineStock(
          action, currentStock, product.lowStockThreshold, resultingStock,
          resultingStatus);
  if (stockResult == dental::offline::OfflineStockResult::kOutOfStock) {
    beginErrorFeedback("Offline checkout rejected: no stock available",
                       "OUT OF STOCK");
    return;
  }
  if (stockResult == dental::offline::OfflineStockResult::kOverflow) {
    beginErrorFeedback("Offline restock rejected: stock limit reached",
                       "Stock limit reached");
    return;
  }
  if (stockResult != dental::offline::OfflineStockResult::kSuccess) {
    beginErrorFeedback("Offline stock calculation failed", "Stock invalid");
    return;
  }

  offlineCommittedRecordBuffer = dental::offline::OfflineJournalRecord{};
  dental::offline::OfflineJournalRecord& committedRecord =
      offlineCommittedRecordBuffer;
  const dental::offline::JournalAppendResult appendResult =
      offlinePendingJournal.append(
          action, timestamp, product, capturedCacheGeneration,
          resultingStock, resultingStatus, committedRecord);
  if (appendResult == dental::offline::JournalAppendResult::kFull) {
    beginErrorFeedback("Pending offline journal is full", "Journal full");
    return;
  }
  if (appendResult ==
      dental::offline::JournalAppendResult::kGenerationMismatch) {
    beginErrorFeedback("Pending journal cache generation mismatch",
                       "Cache mismatch");
    return;
  }
  if (appendResult != dental::offline::JournalAppendResult::kCommitted) {
    beginErrorFeedback("Offline transaction was not durably saved",
                       "SD save failed");
    return;
  }

  beginOfflineSuccessFeedback(committedRecord);
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

  if (transactionRouteCaptured &&
      activeTransactionRoute == dental::offline::TransactionRoute::kOffline) {
    completeOfflineBarcode(timestamp);
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
  if (!dental::hardware::kScannerUartEnabled) return;
  if (registrationBarcodeCapture.active()) {
    while (scannerSerial.available() > 0 &&
           registrationBarcodeCapture.active()) {
      registrationBarcodeCapture.receive(
          static_cast<uint8_t>(scannerSerial.read()), nowMs);
    }
    registrationBarcodeCapture.service(nowMs);
    reportRegistrationCaptureOutcome();
    return;
  }

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
  const uint32_t acceptedAtMs = millis();
  const bool networkConnected = WiFi.status() == WL_CONNECTED;
  desktopPresence.setNetworkConnected(networkConnected);
  desktopPresence.service(acceptedAtMs);
  activeTransactionRoute = dental::offline::selectTransactionRoute(
      desktopPresence.desktopAvailable());
  transactionRouteCaptured = true;
  capturedCacheGeneration[0] = '\0';
  capturedCacheItemCount = 0U;
  if (activeTransactionRoute ==
      dental::offline::TransactionRoute::kOffline) {
    const dental::cache::CacheMetadata& cacheMetadata =
        offlineInventoryCache.metadata();
    if (cacheMetadata.available) {
      snprintf(capturedCacheGeneration, sizeof(capturedCacheGeneration), "%s",
               cacheMetadata.generation);
      capturedCacheItemCount = cacheMetadata.itemCount;
    }
  }
  Serial.print(activeTransaction->action);
  Serial.println(" button pressed");
  if (!dental::hardware::kScannerUartEnabled) {
    beginErrorFeedback("GM65 unavailable: scanner migration pending",
                       "Scanner unavailable");
    return;
  }
  Serial.print("Transaction route captured: ");
  Serial.println(activeTransactionRoute ==
                         dental::offline::TransactionRoute::kOnline
                     ? "ONLINE"
                     : "OFFLINE");
  showLcdScreen(activeTransaction->modeTitle, "Scanner starting...",
                "Scan barcode", "Please wait");

  if (!lcdAvailable) {
    beginErrorFeedback("LCD is unavailable", "LCD unavailable");
    return;
  }
  if (!rtcAvailable) {
    if (rtcStatus.state == dental::rtc_recovery::State::kNeedsSync) {
      beginErrorFeedback("RTC time is untrusted; event was not started",
                         "RTC needs sync");
    } else {
      beginErrorFeedback("RTC is unavailable; event was not started",
                         "RTC unavailable");
    }
    return;
  }
  if (!microSdAvailable) {
    beginErrorFeedback("MicroSD is unavailable; event was not started",
                       "SD unavailable");
    return;
  }
  if (activeTransactionRoute ==
          dental::offline::TransactionRoute::kOffline &&
      !offlineOperationIsReady()) {
    if (!offlineInventoryCache.metadata().available) {
      beginErrorFeedback("Offline inventory cache is unavailable",
                         "Cache unavailable");
    } else if (offlinePendingJournal.metadata().available &&
               offlinePendingJournal.metadata().pendingCount >=
                   dental::offline::kMaximumPendingRecords) {
      beginErrorFeedback("Pending offline journal is full", "Journal full");
    } else if (!offlinePendingJournal.metadata().available ||
               offlinePendingJournal.uncertain()) {
      beginErrorFeedback("Pending offline journal is unavailable",
                         "Journal unavailable");
    } else {
      beginErrorFeedback("Offline cache and journal are incompatible",
                         "Cache mismatch");
    }
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

  if (workflowState != WorkflowState::kIdle ||
      registrationBarcodeCapture.active() || buttonsMustBeReleased) {
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
      transactionRouteCaptured = false;
      activeTransactionRoute = dental::offline::TransactionRoute::kOnline;
      capturedCacheGeneration[0] = '\0';
      capturedCacheItemCount = 0U;
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
    uint8_t statusRegister = 0U;
    if (!readDs3231StatusRegister(statusRegister)) {
      setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                    dental::rtc_recovery::Reason::kCommunicationFailure});
      Serial.println(
          "RTC initialization: FAILED - status register read failed");
    } else if ((statusRegister & kDs3231OscillatorStopFlag) != 0U) {
      setRtcStatus({dental::rtc_recovery::State::kNeedsSync,
                    dental::rtc_recovery::Reason::kLostPower});
      Serial.println(
          "RTC initialization: NEEDS SYNCHRONIZATION - lost-power flag set");
    } else if (!rtc.now().isValid()) {
      setRtcStatus({dental::rtc_recovery::State::kNeedsSync,
                    dental::rtc_recovery::Reason::kInvalidTime});
      Serial.println(
          "RTC initialization: NEEDS SYNCHRONIZATION - retained time is invalid");
    } else {
      setRtcStatus({dental::rtc_recovery::State::kReady,
                    dental::rtc_recovery::Reason::kNone});
      Serial.println("RTC initialization: SUCCESS - retained time preserved");
    }
  } else {
    setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                  dental::rtc_recovery::Reason::kCommunicationFailure});
    Serial.println("RTC initialization: FAILED - DS3231 not responding");
  }

  microSdAvailable = initializeMicroSd();
  if (!microSdAvailable) {
    Serial.println("MicroSD workflow storage: UNAVAILABLE");
  } else {
    Serial.println("MicroSD workflow storage: READY");
    if (offlineInventoryCache.loadAtBoot()) {
      const dental::cache::CacheMetadata& cacheMetadata =
          offlineInventoryCache.metadata();
      Serial.print("Offline inventory cache: READY - generation ");
      Serial.print(cacheMetadata.generation);
      Serial.print(" / items: ");
      Serial.println(cacheMetadata.itemCount);
    } else {
      Serial.println("Offline inventory cache: no valid cache installed");
    }

    const dental::offline::JournalLoadResult journalLoadResult =
        offlinePendingJournal.loadOrCreate(offlineDeviceIdentifier);
    if (journalLoadResult == dental::offline::JournalLoadResult::kReady ||
        journalLoadResult ==
            dental::offline::JournalLoadResult::kRecoveredTornTail) {
      const dental::offline::PendingJournalMetadata& journalMetadata =
          offlinePendingJournal.metadata();
      Serial.print("Pending offline journal: READY - items: ");
      Serial.println(journalMetadata.pendingCount);
      if (journalLoadResult ==
          dental::offline::JournalLoadResult::kRecoveredTornTail) {
        Serial.println(
            "Pending offline journal: recovered incomplete final record");
      }
    } else if (journalLoadResult ==
               dental::offline::JournalLoadResult::kWriteFailed) {
      Serial.println("Pending offline journal: FAILED - create/write error");
    } else if (journalLoadResult ==
               dental::offline::JournalLoadResult::kStorageUnavailable) {
      Serial.println("Pending offline journal: FAILED - storage unavailable");
    } else {
      Serial.println(
          "Pending offline journal: FAILED - integrity/recovery error");
    }
  }

  // No scanner UART initialization: GPIO16/17 belong exclusively to UART1.
  // TODO: migrate GM65 to ATmega in a later verified step.
  barcodeBuffer.reserve(kMaximumBarcodeLength);
  Serial.println(
      "GM65 initialization: DISABLED - scanner migration pending");

  if (!lcdAvailable) {
    beginErrorFeedback("Initialization failed: LCD unavailable",
                       "LCD unavailable");
  } else if (rtcStatus.state ==
             dental::rtc_recovery::State::kUnavailable) {
    beginErrorFeedback("Initialization failed: RTC unavailable",
                       "RTC unavailable");
  } else if (!microSdAvailable) {
    beginErrorFeedback("Initialization failed: MicroSD unavailable",
                       "SD unavailable");
  } else if (rtcStatus.state ==
             dental::rtc_recovery::State::kNeedsSync) {
    Serial.println(
        "Integrated workflow waiting for trusted desktop RTC synchronization");
    showRtcSynchronizationRequiredScreen();
  } else {
    Serial.println("Integrated dual-mode workflow initialization: SUCCESS");
    showIdleScreen();
  }

  initializeWiFi();
  if (dental::hardware::kAtmegaLinkEnabled) {
    atmegaSerial.begin(dental_link::kBaud, SERIAL_8N1,
                      dental::hardware::kAtmegaLinkRxGpio,
                      dental::hardware::kAtmegaLinkTxGpio);
    Serial.println("ATmega link: UART1 ready / 9600 8N1");
  } else {
    Serial.println("ATmega link: DISABLED - confirm ESP32 RX/TX GPIO mapping");
  }
}

void loop() {
  // Each service gets a fresh timestamp. The button or scanner service can
  // start a new timed state, so reusing an earlier sample would make unsigned
  // elapsed-time subtraction wrap and falsely expire that state immediately.
  serviceButtons(millis());
  serviceScanner(millis());
  serviceWorkflowTimeouts(millis());
  serviceWiFi(millis());
  serviceAtmegaLink();
  delay(1UL);
}
