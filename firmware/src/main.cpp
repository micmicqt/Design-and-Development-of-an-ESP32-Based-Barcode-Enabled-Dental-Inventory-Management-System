#include <Arduino.h>
#include <HardwareSerial.h>
#include <NimBLEDevice.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Preferences.h>
#include <bootloader_random.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "desktop_presence_lease.h"
#include "device_discovery_protocol.h"
#include "atmega_link.h"
#include "button_admission.h"
#include "foreground_storage_priority.h"
#include "forwarded_scan_routing.h"
#include "hardware_config.h"
#include "offline_inventory_cache.h"
#include "offline_cache_publication_job.h"
#include "offline_pending_journal.h"
#include "offline_event_sequence.h"
#include "offline_ack_job.h"
#include "online_storage_policy.h"
#include "protocol_config.h"
#include "registration_barcode_capture.h"
#include "rtc_recovery.h"
#include "remote_diskio.h"
#include "remote_storage_timing.h"
#include "runtime_sd_failure.h"
#include "runtime_sd_recovery.h"
#include "secrets.h"
#include "storage_rx_diagnostics.h"
#include "transaction_event_queue.h"
#include "../../firmware-common/include/rtc_link_protocol.h"
#include "../../firmware-common/include/storage_link_protocol.h"
#include "../../firmware-common/include/offline_display_feedback.h"
#include <ff.h>
#include <diskio.h>

namespace {

// Optional setup discovery only. Wi-Fi/HTTP remains the inventory transport.
constexpr char kDiscoveryServiceUuid[] = "4e6a1000-8eab-4c73-9c6e-1f749d86a0d1";
constexpr char kDiscoveryInfoUuid[] = "4e6a1001-8eab-4c73-9c6e-1f749d86a0d1";
char discoveryDeviceId[13] = {};
dental::discovery::UsbRequestParser usbRequestParser;
NimBLECharacteristic* discoveryInfo = nullptr;
bool discoveryWifiConnected = false;
uint32_t discoveryIpAddress = 0U;

class DiscoveryServerCallbacks : public NimBLEServerCallbacks {
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    NimBLEDevice::getAdvertising()->start();
  }
};
DiscoveryServerCallbacks discoveryServerCallbacks;

void formatDiscoveryFrame(char* output, size_t capacity, bool connected,
                          const IPAddress& address) {
  char ip[16] = "-";
  if (connected) {
    snprintf(ip, sizeof(ip), "%u.%u.%u.%u", address[0], address[1],
             address[2], address[3]);
  }
  dental::discovery::formatIdentity(output, capacity, discoveryDeviceId,
                                    connected, ip);
}

void serviceUsbDiscovery() {
  for (uint8_t count = 0U; count < 32U && Serial.available(); ++count) {
    const int received = Serial.read();
    if (received < 0) break;
    if (usbRequestParser.accept(static_cast<uint8_t>(received))) {
      char response[80];
      const bool connected = WiFi.status() == WL_CONNECTED;
      formatDiscoveryFrame(response, sizeof(response), connected,
                           connected ? WiFi.localIP() : IPAddress());
      Serial.println(response);
    }
  }
}

void initializeBleDiscovery() {
  if (!NimBLEDevice::init("AnyTimeDental-Inventory")) {
    Serial.println("Optional BLE discovery: unavailable");
    return;
  }
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&discoveryServerCallbacks, false);
  NimBLEService* service = server->createService(kDiscoveryServiceUuid);
  discoveryInfo = service->createCharacteristic(
      kDiscoveryInfoUuid, NIMBLE_PROPERTY::READ);
  char initialFrame[80];
  formatDiscoveryFrame(initialFrame, sizeof(initialFrame), false, IPAddress());
  discoveryInfo->setValue(initialFrame);
  service->start();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData advertisement;
  advertisement.setFlags(0x06);
  advertisement.addServiceUUID(kDiscoveryServiceUuid);
  NimBLEAdvertisementData scanResponse;
  scanResponse.setName("AnyTimeDental-Inventory");
  advertising->setAdvertisementData(advertisement);
  advertising->setScanResponseData(scanResponse);
  advertising->enableScanResponse(true);
  if (advertising->start()) Serial.println("Optional BLE discovery: READY");
  else Serial.println("Optional BLE discovery: unavailable");
}

void serviceDiscoveryIdentity() {
  serviceUsbDiscovery();
  if (discoveryInfo == nullptr) return;
  const bool connected = WiFi.status() == WL_CONNECTED;
  const IPAddress address = connected ? WiFi.localIP() : IPAddress();
  const uint32_t ip = static_cast<uint32_t>(address);
  if (connected == discoveryWifiConnected && ip == discoveryIpAddress) return;
  discoveryWifiConnected = connected;
  discoveryIpAddress = ip;
  char frame[80];
  formatDiscoveryFrame(frame, sizeof(frame), connected, address);
  discoveryInfo->setValue(frame);
}

constexpr uint32_t kMicroSdSpiFrequencyHz = 125000UL;
constexpr uint8_t kMicroSdMountAttempts = 3U;
constexpr uint32_t kMicroSdRetryDelayMs = 250UL;
constexpr uint32_t kBarcodeTimeoutMs = 10000UL;
constexpr uint32_t kBarcodeIdleTimeoutMs = 100UL;
constexpr uint32_t kIndicatorFeedbackMs = 1000UL;
constexpr uint32_t kWorkflowFeedbackMs = 2000UL;
constexpr uint32_t kCommittedResultFeedbackMs = 4000UL;
constexpr size_t kMaximumBarcodeLength = 256U;
constexpr uint16_t kHttpServerPort = 80U;
constexpr char kAccessPointSsid[] = "Design";
constexpr char kAccessPointPassword[] = DENTAL_AP_PASSWORD;
constexpr uint32_t kWiFiConnectionTimeoutMs = 15000UL;
constexpr uint32_t kWiFiRetryBackoffMs = 30000UL;
constexpr uint32_t kWiFiProgressIntervalMs = 2000UL;
constexpr uint32_t kDesktopPresenceLeaseMs = 12000UL;
constexpr uint32_t kRtcBridgeTimeoutMs = 1500UL;
constexpr uint32_t kRtcStatusPollMs = 5000UL;
constexpr uint32_t kUnixEpochAt2000 = 946684800UL;
constexpr size_t kAtmegaUartRxBufferBytes = 256U;
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
  const char* action;
  const char* modeTitle;
  const char* lcdQuantity;
  const char* serialQuantity;
  const char* rtcReadFailure;
};

constexpr TransactionProfile kRestockTransaction = {
    "RESTOCK",
    "RESTOCK MODE",
    "Qty: +1",
    "Quantity: +1",
    "RTC read failed; RESTOCK event was not saved",
};

constexpr TransactionProfile kCheckoutTransaction = {
    "CHECKOUT",
    "CHECKOUT MODE",
    "Qty: -1",
    "Quantity: -1",
    "RTC read failed; CHECKOUT event was not saved",
};

#ifndef ENABLE_VERBOSE_DIAGNOSTICS
#define ENABLE_VERBOSE_DIAGNOSTICS 0
#endif
constexpr bool kVerboseDiagnostics = ENABLE_VERBOSE_DIAGNOSTICS != 0;

// Opt-in, bounded timing evidence for diagnosing a shared HTTP outage. Leave
// disabled in normal firmware; no transaction or network behavior depends on it.
#ifndef ENABLE_HTTP_SERVICE_TIMING
#define ENABLE_HTTP_SERVICE_TIMING 0
#endif
#if ENABLE_HTTP_SERVICE_TIMING
constexpr uint32_t kSlowHttpServiceMs = 250UL;
constexpr uint32_t kHttpServiceGapMs = 500UL;
uint32_t previousHttpServiceMs = 0UL;
uint32_t maxHttpServiceGapMs = 0UL;
uint32_t lastHttpTimingSummaryMs = 0UL;
uint32_t statusHandlerCount = 0UL;
uint32_t eventHandlerCount = 0UL;
const char* lastSlowLoopOperation = "none";
uint32_t lastSlowLoopDurationMs = 0UL;
uint32_t lastSlowLoopFinishedMs = 0UL;

void noteSlowLoopOperation(const char* name, uint32_t durationMs) {
  if (durationMs < kSlowHttpServiceMs) return;
  lastSlowLoopOperation = name;
  lastSlowLoopDurationMs = durationMs;
  lastSlowLoopFinishedMs = millis();
}

void noteHttpServiceOpportunity(uint32_t nowMs) {
  if (previousHttpServiceMs != 0UL) {
    const uint32_t gapMs = nowMs - previousHttpServiceMs;
    if (gapMs > maxHttpServiceGapMs) maxHttpServiceGapMs = gapMs;
    if (gapMs >= kHttpServiceGapMs) {
      Serial.printf("HTTP service gap: nowMs=%lu gapMs=%lu maxGapMs=%lu "
                    "lastSlow=%s durationMs=%lu ageMs=%lu "
                    "statusHandled=%lu eventsHandled=%lu wifi=CONNECTED\n",
                    static_cast<unsigned long>(nowMs),
                    static_cast<unsigned long>(gapMs),
                    static_cast<unsigned long>(maxHttpServiceGapMs),
                    lastSlowLoopOperation,
                    static_cast<unsigned long>(lastSlowLoopDurationMs),
                    static_cast<unsigned long>(nowMs - lastSlowLoopFinishedMs),
                    static_cast<unsigned long>(statusHandlerCount),
                    static_cast<unsigned long>(eventHandlerCount));
    }
  }
  previousHttpServiceMs = nowMs;
  if (nowMs - lastHttpTimingSummaryMs >= 10000UL) {
    lastHttpTimingSummaryMs = nowMs;
    Serial.printf("HTTP service alive: nowMs=%lu maxGapMs=%lu "
                  "statusHandled=%lu eventsHandled=%lu wifi=CONNECTED\n",
                  static_cast<unsigned long>(nowMs),
                  static_cast<unsigned long>(maxHttpServiceGapMs),
                  static_cast<unsigned long>(statusHandlerCount),
                  static_cast<unsigned long>(eventHandlerCount));
    maxHttpServiceGapMs = 0UL;
  }
}

struct SlowHttpHandlerTrace {
  explicit SlowHttpHandlerTrace(const char* handlerName)
      : name(handlerName), startedMs(millis()) {}
  ~SlowHttpHandlerTrace() {
    const uint32_t durationMs = millis() - startedMs;
    if (durationMs >= kSlowHttpServiceMs) {
      Serial.printf("HTTP handler slow: name=%s durationMs=%lu\n", name,
                    static_cast<unsigned long>(durationMs));
    }
  }
  const char* name;
  uint32_t startedMs;
};

#define TRACE_LOOP_SERVICE(name, expression)                             \
  do {                                                                   \
    const uint32_t serviceStartedMs = millis();                          \
    expression;                                                          \
    noteSlowLoopOperation(name, millis() - serviceStartedMs);            \
  } while (false)
#else
#define TRACE_LOOP_SERVICE(name, expression) expression
#endif


enum class WorkflowState : uint8_t {
  kIdle,
  kWaitingForBarcode,
  kShowingFeedback,
  kShowingCommittedResult,
};


enum class WiFiConnectionState : uint8_t {
  kDisabled,
  kConnecting,
  kWaitingToRetry,
  kConnected,
};

static_assert(kMaximumBarcodeLength == dental::events::kMaximumBarcodeLength,
              "The delivery queue must preserve the complete scanner barcode.");

HardwareSerial atmegaSerial(1);
extern dental::offline::AcknowledgementJob offlineAckJob;
dental::controller_link::PingResponder atmegaResponder;
dental::cache::CachePublicationJob cachePublicationJob;
dental::storage::ForegroundStoragePriority storagePriority;
void foregroundStorageCheckpoint();
bool offlineTimingActive = false;
uint32_t offlineSectorReads = 0, offlineSectorWrites = 0, offlineFences = 0;
uint32_t offlineBarcodeReceivedMs = 0, offlineRtcMs = 0;
uint32_t offlineReadbackMs = 0, offlineReadbackStartedMs = 0;
uint32_t offlineRetryRequests = 0, offlineWaitMs = 0;
uint32_t offlineSectorReadMs = 0, offlineSectorWriteMs = 0, offlineSyncMs = 0, offlineFenceMs = 0;
bool recordOfflineReadbackTimingActive = false;
dental_link::Frame deferredCriticalMode = dental_link::Frame::kNone;
bool deferredCriticalOnline = false, useDeferredRoute = false;
bool journalPreviewActive = false;
uint32_t lastCriticalWaitReplyMs = 0U;
uint32_t cacheControllerTxBytes = 0U, cacheControllerRxBytes = 0U;
// Keep the JSON parser's ~2 KB request object off the loopTask stack while a
// FatFs cache operation is cooperatively serving other HTTP requests.
dental::cache::CacheRequest cacheIncomingRequest = {};
uint32_t lastCacheHttpPumpMs = 0UL;
struct CacheRemoteTiming {
  uint32_t calls = 0U;
  uint32_t totalMs = 0U;
  uint32_t longestMs = 0U;
};
CacheRemoteTiming cacheRemoteReads = {}, cacheRemoteWrites = {};
uint32_t cacheFatSectors = 0U, cacheRootDirectorySectors = 0U, cacheOtherSectors = 0U;
void recordCacheSectorProfile(uint32_t sector);
struct CacheRemoteTimingScope {
  explicit CacheRemoteTimingScope(CacheRemoteTiming& timing, uint32_t sector = 0U)
      : timing_(timing), startedMs_(millis()) {
    if (storagePriority.background()) recordCacheSectorProfile(sector);
  }
  ~CacheRemoteTimingScope() {
    if (!storagePriority.background() || cachePublicationJob.state() !=
        dental::cache::CachePublicationJob::State::kRunning) return;
    const uint32_t elapsed = millis() - startedMs_;
    ++timing_.calls;
    timing_.totalMs += elapsed;
    if (elapsed > timing_.longestMs) timing_.longestMs = elapsed;
  }
  CacheRemoteTiming& timing_;
  uint32_t startedMs_;
};
void serviceWiFi(uint32_t nowMs);
void pumpHttpDuringCachePublication() {
  if (cachePublicationJob.state() !=
      dental::cache::CachePublicationJob::State::kRunning) return;
  const uint32_t nowMs = millis();
  if (nowMs - lastCacheHttpPumpMs < 10UL) return;
  lastCacheHttpPumpMs = nowMs;
  // Called only from storage operations started *after* the POST handler has
  // returned. All HTTP routes that could touch FatFs/controller storage reject
  // while this job is active; status and online events remain RAM-backed.
  serviceWiFi(nowMs);
}
const char* pendingModeReply = nullptr;
const char* pendingLcdFeedback = nullptr;
const char* pendingStockFeedback = nullptr;
dental_link::display::Rows offlineDisplayRows;
uint8_t pendingDisplayStep = 5U;
const char* pendingDisplayHeader = nullptr;
bool offlineLcdProcessing = false;
void queueLcdFeedback(const char* line) {
  // Display feedback is advisory; the single latest complete result is kept
  // until the existing bounded controller transmitter can accept its frame.
  pendingLcdFeedback = line;
  pendingDisplayStep = 5U;
}
void queueOfflineDisplay(bool processing, bool restock) {
  pendingDisplayHeader = processing ? (restock ? "LCD:P:R\n" : "LCD:P:C\n") :
      (restock ? "LCD:S:R\n" : "LCD:S:C\n");
  pendingDisplayStep = 0U;
}
void queueStockFeedback(StockStatus status) {
  pendingStockFeedback = status == StockStatus::kHigh
      ? dental_link::kStockHighFeedback
      : status == StockStatus::kLow
          ? dental_link::kStockLowFeedback
          : dental_link::kStockEmptyFeedback;
}
bool storageRequestActive = false;
bool storageNeedsResynchronization = true;
bool initializationComplete = false;
// Complete SCAN lines received during storage waits are continued by the
// outer loop, never by a nested RTC/FatFs call inside a sector reconstruction.
char deferredControllerBarcode[dental_link::kMaximumBarcodeLength + 1U] = {};
dental_link::Frame deferredControllerScan = dental_link::Frame::kNone;
dental_link::storage::Parser atmegaStorageResponseParser;
dental_link::storage::ResponseMailbox atmegaStorageMailbox;
dental_link::storage::Frame& atmegaStorageResponse = atmegaStorageMailbox.frame;
bool& atmegaStorageResponseAvailable = atmegaStorageMailbox.available;
uint32_t lastAtmegaLinkByteMs = 0UL;
struct AtmegaRxMetrics {
  uint32_t bytes = 0UL;
  uint32_t lines = 0UL;
  uint32_t storageLines = 0UL;
  uint32_t malformedStorageLines = 0UL;
  uint32_t lineOverflows = 0UL;
  uint32_t hexFailures = 0UL;
};
AtmegaRxMetrics atmegaRxMetrics;
volatile uint32_t atmegaUartFifoOverflows = 0UL;
volatile uint32_t atmegaUartBufferOverflows = 0UL;
volatile uint32_t atmegaUartBreakErrors = 0UL;
volatile uint32_t atmegaUartFrameErrors = 0UL;
volatile uint32_t atmegaUartParityErrors = 0UL;
volatile uint32_t atmegaUartUnknownErrors = 0UL;
dental::storage_diagnostics::LineStructureTracker atmegaLineStructureTracker;
dental::storage_diagnostics::LineStructure firstMalformedStorageLine;
bool storageSectorRxActive = false;
bool firstMalformedStorageLineCaptured = false;

void handleAtmegaUartError(hardwareSerial_error_t error) {
  switch (error) {
    case UART_FIFO_OVF_ERROR: ++atmegaUartFifoOverflows; break;
    case UART_BUFFER_FULL_ERROR: ++atmegaUartBufferOverflows; break;
    case UART_BREAK_ERROR: ++atmegaUartBreakErrors; break;
    case UART_FRAME_ERROR: ++atmegaUartFrameErrors; break;
    case UART_PARITY_ERROR: ++atmegaUartParityErrors; break;
    default: ++atmegaUartUnknownErrors; break;
  }
}
struct AtmegaTransmitter {
  bool tryWrite(uint8_t byte) {
    if (atmegaSerial.availableForWrite() < 1) return false;
    const bool sent = atmegaSerial.write(byte) == 1U;
    if (sent && storagePriority.background()) ++cacheControllerTxBytes;
    return sent;
  }
} atmegaTransmitter;

dental::controller_link::ScanRoute handleControllerOperation(
    dental_link::Frame frame, const char* barcode, uint32_t nowMs);
void handleControllerRtcFrame(dental_link::Frame frame, const char* payload,
                              uint32_t nowMs);
void serviceWorkflowTimeouts(uint32_t nowMs);
bool offlineOperationIsReady();
extern dental::presence::DesktopPresenceLease desktopPresence;
extern dental::offline::TransactionRoute activeTransactionRoute;
extern const TransactionProfile* activeTransaction;
const char* lastModeRejectReason = "NONE";

void serviceAtmegaLink() {
  if (!dental::hardware::kAtmegaLinkEnabled) return;
  // A response belongs to its waiter until consumed. Nested controller service
  // must not overwrite this mailbox with the next SD:DATA/SD:OK line.
  if (storageRequestActive && atmegaStorageResponseAvailable) {
    atmegaResponder.service(atmegaTransmitter);
    return;
  }
  // Never parse a second button frame while its predecessor's explicit
  // response is still waiting for the bounded UART transmitter.
  if (pendingModeReply) {
    if (atmegaResponder.queueLine(pendingModeReply)) pendingModeReply = nullptr;
    atmegaResponder.service(atmegaTransmitter);
    if (pendingModeReply) return;
  }
  for (uint8_t processed = 0U; processed < 16U && atmegaSerial.available();
       ++processed) {
    const uint8_t receivedByte = static_cast<uint8_t>(atmegaSerial.read());
    ++atmegaRxMetrics.bytes;
    if (storagePriority.background()) ++cacheControllerRxBytes;
    lastAtmegaLinkByteMs = millis();
    const bool lineCompleted = atmegaLineStructureTracker.receive(receivedByte);
    const dental_link::storage::Frame storageFrame =
        atmegaStorageResponseParser.receive(receivedByte);
    if (receivedByte == '\n') {
      ++atmegaRxMetrics.lines;
      if (atmegaStorageResponseParser.lastLineWasStorage())
        ++atmegaRxMetrics.storageLines;
    }
    if (storageFrame.operation == dental_link::storage::Operation::kRejected &&
        atmegaStorageResponseParser.lastLineWasStorage()) {
      ++atmegaRxMetrics.malformedStorageLines;
      const auto reason = atmegaStorageResponseParser.lastRejectionReason();
      if (reason == dental_link::storage::RejectionReason::kLineOverflow)
        ++atmegaRxMetrics.lineOverflows;
      if (reason == dental_link::storage::RejectionReason::kInvalidHex)
        ++atmegaRxMetrics.hexFailures;
      if (lineCompleted && storageSectorRxActive &&
          !firstMalformedStorageLineCaptured) {
        firstMalformedStorageLine = atmegaLineStructureTracker.last();
        firstMalformedStorageLineCaptured = true;
      }
    }
    if (storageFrame.operation != dental_link::storage::Operation::kNone &&
        storageFrame.operation != dental_link::storage::Operation::kRejected) {
      if (storageRequestActive) {
        atmegaStorageMailbox.publish(storageFrame);
      }
    }
    const dental_link::Frame frame = atmegaResponder.receive(
        receivedByte, atmegaTransmitter);
    if (frame == dental_link::Frame::kRestockMode ||
        frame == dental_link::Frame::kCheckoutMode) {
      if (storagePriority.replacing() ||
          (storagePriority.background() && storageRequestActive)) {
        if (deferredCriticalMode == dental_link::Frame::kNone) {
          deferredCriticalMode = frame;
          deferredCriticalOnline = desktopPresence.desktopAvailable();
          Serial.println("Foreground mode recorded: current atomic cache I/O finishing");
        }
        pendingModeReply = deferredCriticalMode == frame ? dental_link::kModeWaiting :
                                                        dental_link::kModeBusy;
        lastCriticalWaitReplyMs = millis();
        break;
      }
      serviceWorkflowTimeouts(millis());
      const auto gate = dental::controller_link::buttonAdmissionGate(
          storageRequestActive && !storagePriority.preemptible() && !journalPreviewActive &&
              activeTransaction == nullptr,
          offlineAckJob.running());
      dental::controller_link::ScanRoute route =
          dental::controller_link::ScanRoute::kModeStorageUnavailable;
      const char* reason = dental::controller_link::buttonAdmissionGateReason(gate);
      if (!initializationComplete) {
        reason = "SYSTEM_INITIALIZING";
      } else if (gate == dental::controller_link::ButtonAdmissionGate::kProceed) {
        lastModeRejectReason = "NONE";
        route = handleControllerOperation(frame, nullptr, millis());
        reason = route == dental::controller_link::ScanRoute::kModeBusy ?
            (activeTransaction ? "ACTIVE_TRANSACTION" : "FEEDBACK_COOLDOWN") :
            route == dental::controller_link::ScanRoute::kModeRegistrationBusy ?
                "REGISTRATION_ACTIVE" : lastModeRejectReason;
      }
      pendingModeReply = !initializationComplete ? dental_link::kModeInitializing :
          dental::controller_link::modeReply(route, frame);
      if (route != dental::controller_link::ScanRoute::kModeDuplicate) {
        Serial.print("BTN RX: ");
        Serial.println(frame == dental_link::Frame::kRestockMode ?
                       "RESTOCK" : "CHECKOUT");
        Serial.print("admission: ");
        Serial.println(route == dental::controller_link::ScanRoute::kModeAccepted ?
                       "OK" :
                       route == dental::controller_link::ScanRoute::kModeBusy ||
                       route == dental::controller_link::ScanRoute::kModeRegistrationBusy ?
                           "BUSY" : "REJECT");
        Serial.print("reason: "); Serial.println(reason);
        Serial.print("route: ");
        Serial.println(route == dental::controller_link::ScanRoute::kModeAccepted ?
            activeTransactionRoute == dental::offline::TransactionRoute::kOnline ?
                "ONLINE" : "OFFLINE" : "NONE");
        Serial.print("desktopPresence: ");
        Serial.println(desktopPresence.desktopAvailable() ? "YES" : "NO");
        Serial.print("offlineReady: ");
        Serial.println(offlineOperationIsReady() ? "YES" : "NO");
      }
    } else if (frame == dental_link::Frame::kScan ||
               frame == dental_link::Frame::kRestock ||
               frame == dental_link::Frame::kCheckout) {
      // Retained temporary USB log; routing below is independent of the log.
      Serial.print(frame == dental_link::Frame::kRestock ? "ATmega RESTOCK RX: " :
                   frame == dental_link::Frame::kCheckout ? "ATmega CHECKOUT RX: " :
                   "ATmega scanner RX: ");
      Serial.println(atmegaResponder.barcode());
      offlineBarcodeReceivedMs = millis();
      if (storageRequestActive || storagePriority.background() || journalPreviewActive) {
        if (deferredControllerScan == dental_link::Frame::kNone) {
          snprintf(deferredControllerBarcode, sizeof(deferredControllerBarcode),
                   "%s", atmegaResponder.barcode());
          deferredControllerScan = frame;
        }
      } else {
        handleControllerOperation(frame, atmegaResponder.barcode(), millis());
      }
    } else if (frame == dental_link::Frame::kRtcStatus ||
               frame == dental_link::Frame::kRtcTime ||
               frame == dental_link::Frame::kRtcSyncResult) {
      handleControllerRtcFrame(frame, atmegaResponder.payload(), millis());
    }
    // The sector bridge has one response slot. Stop at a completed storage
    // frame so SD:DATA (particularly the final 8-byte chunk) cannot be
    // overwritten by the immediately following SD:OK in this same batch.
    // The caller consumes the frame before the next serviceAtmegaLink call.
    if (pendingModeReply ||
        (storageFrame.operation != dental_link::storage::Operation::kNone &&
         storageFrame.operation != dental_link::storage::Operation::kRejected))
      break;
  }
  if (pendingModeReply && atmegaResponder.queueLine(pendingModeReply))
    pendingModeReply = nullptr;
  if (!pendingModeReply && pendingLcdFeedback &&
      atmegaResponder.queueLine(pendingLcdFeedback))
    pendingLcdFeedback = nullptr;
  if (!pendingModeReply && !pendingLcdFeedback && pendingStockFeedback &&
      atmegaResponder.queueLine(pendingStockFeedback))
    pendingStockFeedback = nullptr;
  if (!pendingModeReply && !pendingLcdFeedback && pendingDisplayStep < 5U) {
    char displayLine[29] = {};
    if (pendingDisplayStep == 0U) snprintf(displayLine, sizeof(displayLine), "%s", pendingDisplayHeader);
    else snprintf(displayLine, sizeof(displayLine), "LCD:%u:%s\n",
        static_cast<unsigned>(pendingDisplayStep - 1U), offlineDisplayRows.text[pendingDisplayStep - 1U]);
    if (atmegaResponder.queueLine(displayLine)) ++pendingDisplayStep;
  }
  if (deferredCriticalMode != dental_link::Frame::kNone &&
      millis() - lastCriticalWaitReplyMs >= 500UL && !pendingModeReply) {
    if (atmegaResponder.queueLine(dental_link::kModeWaiting))
      lastCriticalWaitReplyMs = millis();
  }
  atmegaResponder.service(atmegaTransmitter);
}
WebServer httpServer(kHttpServerPort);

bool rtcAvailable = false;
bool microSdAvailable = false;
dental::storage::RuntimeSdRecovery sdRecovery;
bool storageProbeActive = false;
dental::storage::FirstRuntimeSdFailure firstRuntimeSdFailure;
dental::rtc_recovery::Status rtcStatus = {
    dental::rtc_recovery::State::kUnavailable,
    dental::rtc_recovery::Reason::kCommunicationFailure};

enum class RtcBridgeRequest : uint8_t { kNone, kStatus, kTime, kSync };
RtcBridgeRequest rtcBridgeRequest = RtcBridgeRequest::kNone;
uint32_t rtcBridgeStartedMs = 0UL;
uint32_t lastRtcStatusPollMs = 0UL;
bool rtcBridgeResponseSucceeded = false;
char rtcBridgeTimestamp[20] = {};

constexpr uint32_t kStorageBridgeTimeoutMs = 5000UL;
// STATUS may synchronously initialize a card: CMD0 (20 x 100 ms), ACMD41
// (300 x 10 ms), SPI command polling, and USART reply all share this budget.
// Do not extend ordinary sector/HTTP/controller timeouts.
enum class StorageRequestFailure : uint8_t {
  kNone, kBridgeBusy, kQueueFailed, kTimedOut, kUnavailable, kRejected
};
StorageRequestFailure lastStorageRequestFailure = StorageRequestFailure::kNone;
std::atomic<StorageRequestFailure> offlineAckFirstStorageFailure{
    StorageRequestFailure::kNone};
bool lastStorageWasReinitialized = false;

void recordStorageRequestFailure(StorageRequestFailure failure) {
  lastStorageRequestFailure = failure;
  if (offlineAckJob.running()) {
    StorageRequestFailure expected = StorageRequestFailure::kNone;
    offlineAckFirstStorageFailure.compare_exchange_strong(expected, failure);
  }
}

const char* storageRequestFailureName(StorageRequestFailure failure) {
  switch (failure) {
    case StorageRequestFailure::kNone: return "NONE";
    case StorageRequestFailure::kBridgeBusy: return "BRIDGE_BUSY";
    case StorageRequestFailure::kQueueFailed: return "QUEUE_FAILED";
    case StorageRequestFailure::kTimedOut: return "TIMEOUT";
    case StorageRequestFailure::kUnavailable: return "UNAVAILABLE";
    case StorageRequestFailure::kRejected: return "REJECTED";
  }
  return "UNKNOWN";
}

bool recoverStorageBridge();
bool storageRequest(const char* request,
                    dental_link::storage::Operation firstExpected,
                    dental_link::storage::Operation secondExpected =
                        dental_link::storage::Operation::kNone,
                    uint32_t timeoutMs = kStorageBridgeTimeoutMs) {
  if (!request || !dental::hardware::kAtmegaLinkEnabled ||
      storageRequestActive) return false;
  if (storageNeedsResynchronization && !recoverStorageBridge()) return false;
  struct RequestScope {
    explicit RequestScope(bool& active) : active_(active) { active_ = true; }
    ~RequestScope() { active_ = false; }
    bool& active_;
  } requestScope(storageRequestActive);
  lastStorageRequestFailure = StorageRequestFailure::kNone;
  lastStorageWasReinitialized = false;
  const uint32_t started = millis();
  while (atmegaResponder.busy() && millis() - started < timeoutMs) {
    serviceAtmegaLink();
    pumpHttpDuringCachePublication();
    delay(0);
  }
  if (offlineTimingActive) offlineWaitMs += millis() - started;
  if (atmegaResponder.busy()) {
    recordStorageRequestFailure(StorageRequestFailure::kBridgeBusy);
    return false;
  }
  atmegaStorageResponseAvailable = false;
  if (!atmegaResponder.queueLine(request)) {
    recordStorageRequestFailure(StorageRequestFailure::kQueueFailed);
    return false;
  }
  storageNeedsResynchronization = true;
  while (millis() - started < timeoutMs) {
    serviceAtmegaLink();
    pumpHttpDuringCachePublication();
    if (atmegaStorageResponseAvailable) {
      const auto operation = atmegaStorageResponse.operation;
      atmegaStorageResponseAvailable = false;
      if (operation == firstExpected || operation == secondExpected) {
        storageNeedsResynchronization = false;
        lastStorageWasReinitialized =
            operation == dental_link::storage::Operation::kReinitializedReady;
        return true;
      }
      if (operation == dental_link::storage::Operation::kError ||
          operation == dental_link::storage::Operation::kUnavailable) {
        storageNeedsResynchronization = false;
        recordStorageRequestFailure(
            operation == dental_link::storage::Operation::kUnavailable ?
            StorageRequestFailure::kUnavailable : StorageRequestFailure::kRejected);
        return false;
      }
      // Ignore bounded stale responses from an abandoned sector transfer.
    }
    delay(0);
  }
  recordStorageRequestFailure(StorageRequestFailure::kTimedOut);
  return false;
}

bool recoverStorageBridge() {
  if (offlineTimingActive) ++offlineFences;
  if (storageRequestActive) return false;
  struct FenceTiming {
    uint32_t started = millis();
    ~FenceTiming() { if (offlineTimingActive) offlineFenceMs += millis() - started; }
  } fenceTiming;
  storageRequestActive = true;
  storageNeedsResynchronization = true;
  bool recovered = false;
  static uint32_t fenceSequence = esp_random();
  // SD:IDLE is an abort-specific terminal fence. An old SD:OK cannot satisfy
  // it. UART FIFO ordering puts all old queued chunks before this boundary.
  // Never reset the parser in the middle of a trailing old frame.
  for (uint8_t attempt = 0U; attempt < 2U && !recovered; ++attempt) {
    if (offlineTimingActive && attempt > 0U) ++offlineRetryRequests;
    if (++fenceSequence == 0U) ++fenceSequence;
    const uint32_t expectedFence = fenceSequence;
    char abortCommand[20];
    snprintf(abortCommand, sizeof(abortCommand), "SD:ABORT:%08lX\n",
             static_cast<unsigned long>(expectedFence));
    const uint32_t started = millis();
    while (atmegaResponder.busy() && millis() - started < kStorageBridgeTimeoutMs) {
      serviceAtmegaLink(); atmegaStorageResponseAvailable = false; delay(0);
    }
    if (atmegaResponder.busy() || !atmegaResponder.queueLine(abortCommand)) continue;
    while (millis() - started < kStorageBridgeTimeoutMs) {
      serviceAtmegaLink();
      pumpHttpDuringCachePublication();
      if (atmegaStorageResponseAvailable) {
        recovered = dental_link::storage::matchesIdleFence(
            atmegaStorageResponse, expectedFence);
        atmegaStorageResponseAvailable = false;
        if (recovered) break;
      }
      delay(0);
    }
  }
  storageRequestActive = false;
  storageNeedsResynchronization = !recovered;
  if (!recovered) recordStorageRequestFailure(StorageRequestFailure::kTimedOut);
  Serial.print("MicroSD storage cleanup: ");
  Serial.println(recovered ? "SUCCESS" : "FAILED");
  return recovered;
}

bool remoteSdInitializeImpl() {
  const bool ready = storageRequest("SD:STATUS\n",
      dental_link::storage::Operation::kReady,
      dental_link::storage::Operation::kReinitializedReady,
      dental::storage::kInitializationRequestTimeoutMs);
  Serial.print("MicroSD controller status: ");
  if (ready) Serial.println(lastStorageWasReinitialized ?
      "READY (ATmega card reinitialization succeeded)" :
      "READY (ATmega card already initialized)");
  else switch (lastStorageRequestFailure) {
    case StorageRequestFailure::kBridgeBusy: Serial.println("BRIDGE_BUSY"); break;
    case StorageRequestFailure::kQueueFailed: Serial.println("REQUEST_NOT_QUEUED"); break;
    case StorageRequestFailure::kTimedOut: Serial.println("REQUEST_TIMEOUT"); break;
    case StorageRequestFailure::kUnavailable:
      Serial.println("ATMEGA_CARD_INITIALIZATION_FAILED"); break;
    case StorageRequestFailure::kRejected: Serial.println("CONTROLLER_REJECTED"); break;
    case StorageRequestFailure::kNone: Serial.println("NO_CONTROLLER"); break;
  }
  return ready;
}

bool remoteSdSyncImpl() {
  return storageRequest("SD:SYNC\n", dental_link::storage::Operation::kOk,
                        dental_link::storage::Operation::kNone,
                        dental::storage::kSyncTimeoutMs);
}

void printHexByte(uint8_t value) {
  if (value < 0x10U) Serial.print('0');
  Serial.print(value, HEX);
}

const char* rawReadFailureName(
    dental_link::storage::diagnostic::ReadFailureReason reason) {
  using dental_link::storage::diagnostic::ReadFailureReason;
  switch (reason) {
    case ReadFailureReason::kNotReady: return "NOT_READY";
    case ReadFailureReason::kTransferState: return "TRANSFER_STATE";
    case ReadFailureReason::kWaitReadyTimeout: return "WAIT_READY_TIMEOUT";
    case ReadFailureReason::kCmd17R1: return "CMD17_R1";
    case ReadFailureReason::kDataTokenTimeout: return "DATA_TOKEN_TIMEOUT";
    case ReadFailureReason::kDataTokenInvalid: return "DATA_TOKEN_INVALID";
    default: return "NONE";
  }
}

void printRawReadFailure(uint32_t sector) {
  using namespace dental_link::storage::diagnostic;
  if (!storageRequest("SD:DIAG\n",
                      dental_link::storage::Operation::kDiagnostic) ||
      atmegaStorageResponse.length != kLength ||
      atmegaStorageResponse.data[kVersion] != 3U) {
    Serial.print("MicroSD raw read failure: sector=");
    Serial.print(sector);
    Serial.println(" diagnostic=UNAVAILABLE");
    return;
  }
  const uint8_t* value = atmegaStorageResponse.data;
  const ReadFailureReason reason = readFailureReason(value[kReadFlags]);
  const uint8_t attempt = (value[kMoreFlags] & kRuntimeReadRetried) ? 2U : 1U;
  const char* cardState = reason == ReadFailureReason::kTransferState
      ? "READY"
      : reason == ReadFailureReason::kNotReady ? "NOT_READY" : "IO_ERROR";
  Serial.print("MicroSD raw read failure: sector="); Serial.print(sector);
  Serial.print(" attempt="); Serial.print(attempt);
  Serial.print(" reason="); Serial.print(rawReadFailureName(reason));
  Serial.print(" r1=0x"); printHexByte(value[kReadR1]);
  Serial.print(" token=0x"); printHexByte(value[kReadToken]);
  Serial.print(" cardInitialized="); Serial.print((value[kMoreFlags] & kRuntimeReadReady) ? "YES" : "NO");
  Serial.print(" r1Timeout="); Serial.print((value[kReadFlags] & kReadR1TimedOut) ? "YES" : "NO");
  Serial.print(" tokenTimeout="); Serial.print((value[kReadFlags] & kReadTokenTimedOut) ? "YES" : "NO");
  Serial.print(" readyTimeout="); Serial.print(reason == ReadFailureReason::kWaitReadyTimeout ? "YES" : "NO");
  Serial.print(" cardState="); Serial.println(cardState);
}

void printCmd17ReadTrace() {
  using namespace dental_link::storage::read_trace;
  if (!storageRequest("SD:TRACE\n",
                      dental_link::storage::Operation::kDiagnostic) ||
      atmegaStorageResponse.length != kLength ||
      atmegaStorageResponse.data[0] != kVersion ||
      (atmegaStorageResponse.data[1] & kValid) == 0U) {
    Serial.println("MicroSD CMD17 trace: UNAVAILABLE");
    return;
  }
  const uint8_t* value = atmegaStorageResponse.data;
  const uint32_t sector = (static_cast<uint32_t>(value[3]) << 24U) |
      (static_cast<uint32_t>(value[4]) << 16U) |
      (static_cast<uint32_t>(value[5]) << 8U) | value[6];
  Serial.print("MicroSD CMD17 trace: sector="); Serial.print(sector);
  Serial.print(" argument=0x");
  for (uint8_t index = 7U; index <= 10U; ++index) printHexByte(value[index]);
  Serial.print(" addressing=");
  Serial.print((value[1] & kBlockAddressed) != 0U ? "BLOCK" : "BYTE");
  Serial.print(" finalReason=");
  Serial.print(rawReadFailureName(static_cast<
      dental_link::storage::diagnostic::ReadFailureReason>(value[2])));
  Serial.print(" retryReady=0x"); printHexByte(value[11]);
  Serial.print(" retryFlags=0x"); printHexByte(value[12]);
  Serial.println();
  for (uint8_t attempt = 0U; attempt < 2U; ++attempt) {
    const uint8_t base = static_cast<uint8_t>(13U + attempt * 6U);
    Serial.print("MicroSD CMD17 attempt "); Serial.print(attempt + 1U);
    Serial.print(": pre=0x"); printHexByte(value[base]);
    Serial.print(" poll=");
    if (value[base + 1U] == 0xFFU) Serial.print("NONE");
    else Serial.print(value[base + 1U]);
    Serial.print(" prev=0x"); printHexByte(value[base + 2U]);
    Serial.print(" r1=0x"); printHexByte(value[base + 3U]);
    Serial.print(" token=0x"); printHexByte(value[base + 4U]);
    Serial.print(" flags=0x"); printHexByte(value[base + 5U]);
    Serial.println();
  }
}

void printStorageStreamDiagnostic() {
  using namespace dental_link::storage::stream_diagnostic;
  if (!storageRequest("SD:STREAM?\n",
                      dental_link::storage::Operation::kStreamDiagnostic) ||
      atmegaStorageResponse.length != kLength ||
      atmegaStorageResponse.data[kVersion] != 2U) {
    Serial.println("MicroSD stream metrics: unavailable");
    return;
  }
  const uint8_t* value = atmegaStorageResponse.data;
  const uint16_t deferred = static_cast<uint16_t>(value[kDeferredHigh]) << 8U |
                            value[kDeferredLow];
  const uint16_t generated =
      static_cast<uint16_t>(value[kFinalGeneratedHigh]) << 8U |
      value[kFinalGeneratedLow];
  const uint16_t accepted =
      static_cast<uint16_t>(value[kFinalAcceptedHigh]) << 8U |
      value[kFinalAcceptedLow];
  Serial.print("MicroSD stream metrics: attempted=");
  Serial.print(value[kFramesAttempted]);
  Serial.print(" accepted="); Serial.print(value[kFramesAccepted]);
  Serial.print(" deferred="); Serial.print(deferred);
  Serial.print(" rejected="); Serial.print(value[kFramesRejected]);
  Serial.print(" finalGenerated=");
  if (generated == 0xFFFFU) Serial.print("NONE"); else Serial.print(generated);
  Serial.print(" finalAccepted=");
  if (accepted == 0xFFFFU) Serial.print("NONE"); else Serial.print(accepted);
  Serial.print(" okAttempted="); Serial.print(value[kOkAttempted]);
  Serial.print(" okAccepted="); Serial.print(value[kOkAccepted]);
  Serial.print(" txQueueHighWater="); Serial.print(value[kQueueHighWater]);
  uint32_t sector = 0U;
  for (uint8_t index = 0U; index < 4U; ++index)
    sector = (sector << 8U) | value[kSector + index];
  Serial.print(" sector="); Serial.print(sector);
  Serial.print(" aborted="); Serial.print((value[kFlags] & 1U) ? "YES" : "NO");
  Serial.print(" errorGenerated="); Serial.print((value[kFlags] & 2U) ? "YES" : "NO");
  Serial.print(" errorAccepted="); Serial.print((value[kFlags] & 4U) ? "YES" : "NO");
  Serial.print(" queuedBytes="); Serial.print(value[kQueuedBytes]);
  Serial.print(" transferState="); Serial.println(value[kTransferState]);
}

void printStorageDiagnostic() {
  using namespace dental_link::storage::diagnostic;
  printStorageStreamDiagnostic();
  if (!storageRequest("SD:DIAG\n",
                      dental_link::storage::Operation::kDiagnostic) ||
      atmegaStorageResponse.length != kLength ||
      atmegaStorageResponse.data[kVersion] != 3U) {
    Serial.println("MicroSD raw diagnostic: unavailable");
    return;
  }
  const uint8_t* value = atmegaStorageResponse.data;
  Serial.print("MicroSD raw diagnostic stage: "); Serial.print(value[kStage]);
  Serial.print(" (");
  switch (value[kStage]) {
    case 1U: Serial.print("SPI setup"); break;
    case 2U: Serial.print("startup clocks"); break;
    case 3U: Serial.print("CMD0"); break;
    case 4U: Serial.print("CMD8/R7"); break;
    case 5U: Serial.print("ACMD41"); break;
    case 6U: Serial.print("CMD58/OCR"); break;
    case 7U: Serial.print("CMD16"); break;
    case 8U: Serial.print("raw card ready"); break;
    case 9U: Serial.print("first sector read"); break;
    default: Serial.print("not started"); break;
  }
  Serial.println(')');
  Serial.print("MicroSD SPI clock 125000 Hz configured: ");
  Serial.println((value[kFlags] & kSpiConfigured) != 0U ? "YES" : "NO");
  Serial.print("MicroSD CS idle command state HIGH: ");
  Serial.println((value[kFlags] & kChipSelectHigh) != 0U ? "YES" : "NO");
  Serial.print("MicroSD startup clocks with CS HIGH (80 clocks): ");
  Serial.println((value[kFlags] & kStartupClocksSent) != 0U ? "YES" : "NO");
  Serial.print("MicroSD pre-CMD0 registers: DDRB=0x"); printHexByte(value[kDdrb]);
  Serial.print(" PORTB=0x"); printHexByte(value[kPortb]);
  Serial.print(" SPCR=0x"); printHexByte(value[kSpcr]);
  Serial.print(" SPSR=0x"); printHexByte(value[kSpsr]); Serial.println();
  Serial.print("MicroSD SPI ownership: CS-out=");
  Serial.print((value[kDdrb] & 0x04U) != 0U ? "YES" : "NO");
  Serial.print(" MOSI-out=");
  Serial.print((value[kDdrb] & 0x08U) != 0U ? "YES" : "NO");
  Serial.print(" MISO-in=");
  Serial.print((value[kDdrb] & 0x10U) == 0U ? "YES" : "NO");
  Serial.print(" MISO-pullup=");
  Serial.print((value[kPortb] & 0x10U) == 0U ? "OFF" : "ON");
  Serial.print(" SCK-out=");
  Serial.println((value[kDdrb] & 0x20U) != 0U ? "YES" : "NO");
  Serial.print("MicroSD SPI mode: SPE=");
  Serial.print((value[kSpcr] & 0x40U) != 0U ? "1" : "0");
  Serial.print(" MSTR="); Serial.print((value[kSpcr] & 0x10U) != 0U ? "1" : "0");
  Serial.print(" DORD="); Serial.print((value[kSpcr] & 0x20U) != 0U ? "1" : "0");
  Serial.print(" CPOL="); Serial.print((value[kSpcr] & 0x08U) != 0U ? "1" : "0");
  Serial.print(" CPHA="); Serial.print((value[kSpcr] & 0x04U) != 0U ? "1" : "0");
  Serial.print(" SPI2X="); Serial.println((value[kSpsr] & 0x01U) != 0U ? "1" : "0");
  Serial.print("MicroSD CMD0: ");
  if (value[kStage] < 3U) Serial.println("not attempted");
  else {
    Serial.print("R1=0x"); printHexByte(value[kCmd0]); Serial.print(" timeout=");
    Serial.print((value[kFlags] & kCmd0TimedOut) != 0U ? "YES" : "NO");
    Serial.print(" packet=40 00 00 00 00 95 packet-sent=");
    Serial.print((value[kCmd0Trace] & kCommandPacketSent) != 0U ? "YES" : "NO");
    Serial.print(" ready-wait=");
    Serial.print((value[kCmd0Trace] & kCmd0ReadyWaitSkipped) != 0U ? "SKIPPED" : "USED");
    Serial.print(" ready-timeout=");
    Serial.print((value[kCmd0Trace] & kCommandReadyTimedOut) != 0U ? "YES" : "NO");
    Serial.print(" response-timeout=");
    Serial.println((value[kCmd0Trace] & kCommandResponseTimedOut) != 0U ? "YES" : "NO");
  }
  const uint16_t cmd0Elapsed =
      static_cast<uint16_t>(value[kCmd0ElapsedHigh]) << 8U |
      value[kCmd0ElapsedLow];
  Serial.print("MicroSD CMD0 reset: attempts=");
  Serial.print(value[kCmd0AttemptCount]);
  Serial.print(" firstR1=0x"); printHexByte(value[kCmd0FirstR1]);
  Serial.print(" lastR1=0x"); printHexByte(value[kCmd0LastR1]);
  Serial.print(" elapsedMs="); Serial.print(cmd0Elapsed);
  Serial.print(" result=");
  Serial.println(value[kCmd0] == 0x01U ? "IDLE" : "FAILED");
  Serial.print("MicroSD CMD8: ");
  if (value[kStage] < 4U) Serial.println("not attempted");
  else {
    Serial.print("R1=0x"); printHexByte(value[kCmd8]); Serial.print(" timeout=");
    Serial.print((value[kFlags] & kCmd8TimedOut) != 0U ? "YES" : "NO");
    Serial.print(" R7=");
    for (uint8_t index = 0U; index < 4U; ++index) printHexByte(value[kR7 + index]);
    Serial.print(" validation=");
    Serial.print((value[kMoreFlags] & kSdV2) != 0U ? "PASS" : "FAIL");
    Serial.println();
  }
  Serial.print("MicroSD ACMD41: ");
  if (value[kStage] < 5U) Serial.println("not attempted");
  else {
    Serial.print("last R1=0x"); printHexByte(value[kAcmd41]); Serial.print(" attempts=");
    Serial.print(static_cast<uint16_t>(value[kAcmd41AttemptsHigh]) << 8U |
                 value[kAcmd41AttemptsLow]);
    Serial.print(" timeout=");
    Serial.print((value[kFlags] & kAcmd41TimedOut) != 0U ? "YES" : "NO");
    Serial.print(" response-timeout=");
    Serial.println(value[kAcmd41] == 0xFFU ? "YES" : "NO");
  }
  Serial.print("MicroSD CMD58: ");
  if (value[kStage] < 6U) Serial.println("not attempted");
  else {
    Serial.print("R1=0x"); printHexByte(value[kCmd58]); Serial.print(" timeout=");
    Serial.print((value[kFlags] & kCmd58TimedOut) != 0U ? "YES" : "NO");
    Serial.print(" OCR=");
    for (uint8_t index = 0U; index < 4U; ++index) printHexByte(value[kOcr + index]);
    Serial.println();
  }
  Serial.print("MicroSD card type: ");
  if ((value[kMoreFlags] & kInitializationSucceeded) == 0U) Serial.println("UNAVAILABLE");
  else if ((value[kMoreFlags] & kBlockAddressing) != 0U) Serial.println("SDHC/SDXC block-addressed");
  else Serial.println("SD v2 standard-capacity byte-addressed");
  Serial.print("MicroSD CMD16: ");
  if ((value[kMoreFlags] & kCmd16Issued) == 0U) Serial.println("not applicable");
  else {
    Serial.print("R1=0x"); printHexByte(value[kCmd16]);
    Serial.print(" timeout=");
    Serial.println((value[kFlags] & kCmd16TimedOut) != 0U ? "YES" : "NO");
  }
  Serial.print("MicroSD first sector read: ");
  if ((value[kReadFlags] & kReadAttempted) == 0U) Serial.println("not attempted");
  else {
    Serial.print((value[kReadFlags] & kReadWasSectorZero) != 0U ? "sector 0 " : "nonzero sector ");
    Serial.print("R1=0x"); printHexByte(value[kReadR1]);
    Serial.print(" R1-timeout=");
    Serial.print((value[kReadFlags] & kReadR1TimedOut) != 0U ? "YES" : "NO");
    Serial.print(" token=0x"); printHexByte(value[kReadToken]);
    Serial.print(" token-timeout=");
    Serial.print((value[kReadFlags] & kReadTokenTimedOut) != 0U ? "YES" : "NO");
    Serial.print(" result=");
    Serial.println((value[kReadFlags] & kReadSucceeded) != 0U ? "SUCCESS" : "FAILED");
  }
}

bool remoteSdReadSectorImpl(uint32_t sector, uint8_t* destination) {
  CacheRemoteTimingScope cacheTiming(cacheRemoteReads, sector);
  if (!destination || storageRequestActive) return false;
  if (storageNeedsResynchronization && !recoverStorageBridge()) return false;
  struct ReadScope {
    ReadScope() { storageRequestActive = true; }
    ~ReadScope() { storageRequestActive = false; }
  } readScope;
  lastStorageRequestFailure = StorageRequestFailure::kNone;
  const AtmegaRxMetrics rxBefore = atmegaRxMetrics;
  const uint32_t fifoOverflowsBefore = atmegaUartFifoOverflows;
  const uint32_t bufferOverflowsBefore = atmegaUartBufferOverflows;
  const uint32_t breakErrorsBefore = atmegaUartBreakErrors;
  const uint32_t frameErrorsBefore = atmegaUartFrameErrors;
  const uint32_t parityErrorsBefore = atmegaUartParityErrors;
  const uint32_t unknownErrorsBefore = atmegaUartUnknownErrors;
  char command[16];
  if (!dental_link::storage::encodeSector(
          dental_link::storage::Operation::kReadSector, sector, command,
          sizeof(command))) return false;
  const uint32_t started = millis();
  while (atmegaResponder.busy() && millis() - started < kStorageBridgeTimeoutMs) {
    serviceAtmegaLink(); pumpHttpDuringCachePublication(); delay(0);
  }
  if (offlineTimingActive) offlineWaitMs += millis() - started;
  atmegaStorageResponseAvailable = false;
  const bool requestSent = !atmegaResponder.busy() && atmegaResponder.queueLine(command);
  if (requestSent) storageNeedsResynchronization = true;
  firstMalformedStorageLine = dental::storage_diagnostics::LineStructure{};
  firstMalformedStorageLineCaptured = false;
  storageSectorRxActive = requestSent;
  dental_link::storage::SectorAssembler assembler(destination);
  dental_link::storage::Operation finalOperation = dental_link::storage::Operation::kNone;
  uint16_t rejectedOffset = 0xFFFFU;
  uint8_t rejectedLength = 0U;
  bool success = false;
  if (!requestSent) finalOperation = dental_link::storage::Operation::kRejected;
  while (millis() - started < dental::storage::kReadSectorTimeoutMs) {
    if (!requestSent) break;
    serviceAtmegaLink();
    pumpHttpDuringCachePublication();
    if (!atmegaStorageResponseAvailable) { delay(0); continue; }
    const dental_link::storage::Frame frame = atmegaStorageResponse;
    atmegaStorageResponseAvailable = false;
    if (frame.operation == dental_link::storage::Operation::kData) {
      if (!assembler.accept(frame)) {
        rejectedOffset = frame.offset;
        rejectedLength = frame.length;
        finalOperation = dental_link::storage::Operation::kRejected;
        break;
      }
    } else if (frame.operation == dental_link::storage::Operation::kOk) {
      storageNeedsResynchronization = false;
      finalOperation = frame.operation;
      success = assembler.complete();
      break;
    } else if (frame.operation == dental_link::storage::Operation::kError ||
               frame.operation == dental_link::storage::Operation::kUnavailable) {
      storageNeedsResynchronization = false;
      finalOperation = frame.operation;
      break;
    }
  }
  storageSectorRxActive = false;
  if (kVerboseDiagnostics) {
  Serial.print("MicroSD remote read: sector="); Serial.print(sector);
  Serial.print(" request="); Serial.print(requestSent ? "SENT" : "NOT_SENT");
  Serial.print(" accepted="); Serial.print(assembler.chunks() != 0U ? "YES" : "NO");
  Serial.print(" chunks="); Serial.print(assembler.chunks());
  Serial.print(" expectedOffset="); Serial.print(assembler.expectedOffset());
  Serial.print(" lastOffset="); Serial.print(assembler.lastOffset());
  Serial.print(" lastLength="); Serial.print(assembler.lastLength());
  Serial.print(" bytes="); Serial.print(assembler.received());
  if (rejectedOffset != 0xFFFFU) {
    Serial.print(" rejectedOffset="); Serial.print(rejectedOffset);
    Serial.print(" rejectedLength="); Serial.print(rejectedLength);
  }
  Serial.print(" complete="); Serial.print(assembler.complete() ? "YES" : "NO");
  Serial.print(" elapsedMs="); Serial.print(millis() - started);
  Serial.print(" final=");
  if (finalOperation == dental_link::storage::Operation::kOk) Serial.println("SD:OK");
  else if (finalOperation == dental_link::storage::Operation::kError) Serial.println("SD:ERROR");
  else if (finalOperation == dental_link::storage::Operation::kUnavailable) Serial.println("SD:UNAVAILABLE");
  else if (finalOperation == dental_link::storage::Operation::kRejected) Serial.println("RECONSTRUCTION_REJECTED");
  else Serial.println("TIMEOUT");
  const uint32_t rxLines = atmegaRxMetrics.lines - rxBefore.lines;
  const uint32_t storageLines =
      atmegaRxMetrics.storageLines - rxBefore.storageLines;
  Serial.print("MicroSD controller RX: bytes=");
  Serial.print(atmegaRxMetrics.bytes - rxBefore.bytes);
  Serial.print(" lines="); Serial.print(rxLines);
  Serial.print(" storageLines="); Serial.print(storageLines);
  Serial.print(" nonStorageLines="); Serial.print(rxLines - storageLines);
  Serial.print(" malformed=");
  Serial.print(atmegaRxMetrics.malformedStorageLines -
               rxBefore.malformedStorageLines);
  Serial.print(" lineOverflow=");
  Serial.print(atmegaRxMetrics.lineOverflows - rxBefore.lineOverflows);
  Serial.print(" hexFailure=");
  Serial.print(atmegaRxMetrics.hexFailures - rxBefore.hexFailures);
  Serial.print(" uartFifoOverflow=");
  Serial.print(atmegaUartFifoOverflows - fifoOverflowsBefore);
  Serial.print(" uartBufferOverflow=");
  Serial.print(atmegaUartBufferOverflows - bufferOverflowsBefore);
  Serial.print(" uartBreak=");
  Serial.print(atmegaUartBreakErrors - breakErrorsBefore);
  Serial.print(" uartFrame=");
  Serial.print(atmegaUartFrameErrors - frameErrorsBefore);
  Serial.print(" uartParity=");
  Serial.print(atmegaUartParityErrors - parityErrorsBefore);
  Serial.print(" uartUnknown=");
  Serial.println(atmegaUartUnknownErrors - unknownErrorsBefore);
  if (firstMalformedStorageLineCaptured) {
    const auto& line = firstMalformedStorageLine;
    Serial.print("MicroSD first malformed line: length=");
    Serial.print(line.length);
    Serial.print(" dataPrefix="); Serial.print(line.dataPrefixIntact ? "YES" : "NO");
    Serial.print(" offset=");
    Serial.print(line.offsetTextAvailable ? line.offsetText : "UNAVAILABLE");
    Serial.print(" offsetHex="); Serial.print(line.offsetValidHex ? "YES" : "NO");
    Serial.print(" colon1="); Serial.print(line.firstColonPresent ? "YES" : "NO");
    Serial.print(" colon2="); Serial.print(line.secondColonPresent ? "YES" : "NO");
    Serial.print(" newline="); Serial.print(line.newlineTerminated ? "LF" : "MISSING");
    Serial.print(" printable=");
    Serial.print(line.printableValidationFailed ? "FAIL" : "PASS");
    Serial.print(" unexpectedBytes="); Serial.print(line.unexpectedBytes);
    Serial.print(" shape=");
    Serial.println(dental::storage_diagnostics::lineShapeName(line.shape));
  } else {
    Serial.println("MicroSD first malformed line: NONE");
  }
  }
  if (!success) {
    Serial.print("MicroSD READ failed: sector="); Serial.print(sector);
    Serial.print(" result=");
    if (finalOperation == dental_link::storage::Operation::kError)
      Serial.print("SD:ERROR");
    else if (finalOperation == dental_link::storage::Operation::kUnavailable)
      Serial.print("SD:UNAVAILABLE");
    else if (!requestSent)
      Serial.print("REQUEST_NOT_SENT");
    else if (finalOperation == dental_link::storage::Operation::kRejected)
      Serial.print("RECONSTRUCTION_REJECTED");
    else if (finalOperation == dental_link::storage::Operation::kOk)
      Serial.print("INCOMPLETE_SECTOR");
    else Serial.print("TIMEOUT");
    Serial.print(" elapsedMs="); Serial.print(millis() - started);
    // Failure-only evidence distinguishes a missing/malformed UART chunk
    // from a rejected local request without enabling byte-by-byte logging.
    Serial.print(" expectedOffset="); Serial.print(assembler.expectedOffset());
    if (rejectedOffset != 0xFFFFU) {
      Serial.print(" receivedOffset="); Serial.print(rejectedOffset);
      Serial.print(" receivedLength="); Serial.print(rejectedLength);
    }
    Serial.print(" chunks="); Serial.print(assembler.chunks());
    Serial.print(" malformed=");
    Serial.print(atmegaRxMetrics.malformedStorageLines - rxBefore.malformedStorageLines);
    Serial.print(" uartFrame="); Serial.print(atmegaUartFrameErrors - frameErrorsBefore);
    Serial.print(" uartOverflow=");
    Serial.print((atmegaUartFifoOverflows - fifoOverflowsBefore) +
                 (atmegaUartBufferOverflows - bufferOverflowsBefore));
    Serial.print(" controller=");
    Serial.print(storageRequestFailureName(lastStorageRequestFailure));
    Serial.println(" recovery=PENDING");
  }
  if (!success &&
      finalOperation == dental_link::storage::Operation::kError &&
      assembler.chunks() == 0U) {
    storageRequestActive = false; // terminal received; diagnostics are new requests
    printRawReadFailure(sector);
    printCmd17ReadTrace();
  } else if (!success && requestSent) {
    storageRequestActive = false;
    Serial.print("MicroSD runtime read failure: sector="); Serial.print(sector);
    Serial.println(assembler.chunks() != 0U ? " stage=DATA_STREAM (bootstrap delivered DATA)" :
                                  " stage=CONTROLLER_STREAM (no terminal raw-card evidence)");
    if (recoverStorageBridge()) printStorageStreamDiagnostic();
  }
  return success;
}

bool remoteSdWriteSectorImpl(uint32_t sector, const uint8_t* source) {
  CacheRemoteTimingScope cacheTiming(cacheRemoteWrites, sector);
  if (!source) return false;
  const uint32_t sectorStarted = millis();
  char command[16];
  if (!dental_link::storage::encodeSector(
          dental_link::storage::Operation::kWriteSector, sector, command,
          sizeof(command)) ||
      !storageRequest(command, dental_link::storage::Operation::kOk,
                      dental_link::storage::Operation::kNone,
                      dental::storage::kWriteSectorTimeoutMs)) return false;
  char frame[dental_link::storage::kMaximumFrameLength + 2U];
  uint16_t sent = 0U;
  while (sent < dental_link::storage::kSectorBytes) {
    const uint32_t elapsed = millis() - sectorStarted;
    if (elapsed >= dental::storage::kWriteSectorTimeoutMs) {
      storageNeedsResynchronization = true;
      return false;
    }
    const uint8_t count = static_cast<uint8_t>(min(
        static_cast<uint16_t>(dental_link::storage::kChunkBytes),
        static_cast<uint16_t>(dental_link::storage::kSectorBytes - sent)));
    if (!dental_link::storage::encodeData(sent, source + sent, count, frame,
                                          sizeof(frame)) ||
        !storageRequest(frame, dental_link::storage::Operation::kOk,
                        dental_link::storage::Operation::kNone,
                        dental::storage::kWriteSectorTimeoutMs - elapsed)) return false;
    sent = static_cast<uint16_t>(sent + count);
  }
  return true;
}

FATFS remoteFileSystem = {};
void recordCacheSectorProfile(uint32_t sector) {
  const auto& fs = remoteFileSystem;
  if (sector >= fs.fatbase && sector < fs.fatbase + fs.fsize * fs.n_fats)
    ++cacheFatSectors;
  else if (fs.fs_type == FS_FAT32 && fs.dirbase >= 2U &&
           sector >= fs.database + (fs.dirbase - 2U) * fs.csize &&
           sector < fs.database + (fs.dirbase - 1U) * fs.csize)
    ++cacheRootDirectorySectors;
  else if (fs.fs_type != FS_FAT32 && sector >= fs.dirbase && sector < fs.database)
    ++cacheRootDirectorySectors;
  else ++cacheOtherSectors; // Includes data and any extended directory chain.
}

enum class OfflineAckFatFsOperation : uint8_t {
  kNone, kStat, kOpenRead, kRead, kOpenWrite, kWrite, kSync, kClose,
  kUnlink, kRename
};
// Aggregate timings are diagnostic-only and never log inside a sector transfer.
struct CacheFatFsTiming {
  uint32_t calls = 0U;
  uint32_t totalMs = 0U;
  uint32_t longestMs = 0U;
  uint8_t lastResult = 0U;
};
CacheFatFsTiming cacheFatFsTiming[10] = {};
CacheFatFsTiming offlineFatFsTiming[10] = {};
OfflineAckFatFsOperation cacheLastFatFsOperation = OfflineAckFatFsOperation::kNone;
void recordCacheFatFsTiming(OfflineAckFatFsOperation operation,
                            uint32_t startedMs, FRESULT result) {
  if (offlineTimingActive) {
    const uint8_t index = static_cast<uint8_t>(operation);
    if (index < 10U) {
      ++offlineFatFsTiming[index].calls;
      offlineFatFsTiming[index].totalMs += millis() - startedMs;
    }
  }
#if ENABLE_HTTP_SERVICE_TIMING
  if (!storagePriority.background() || cachePublicationJob.state() !=
      dental::cache::CachePublicationJob::State::kRunning) return;
  const uint8_t index = static_cast<uint8_t>(operation);
  if (index >= sizeof(cacheFatFsTiming) / sizeof(cacheFatFsTiming[0])) return;
  CacheFatFsTiming& timing = cacheFatFsTiming[index];
  const uint32_t elapsed = millis() - startedMs;
  ++timing.calls;
  timing.totalMs += elapsed;
  if (elapsed > timing.longestMs) timing.longestMs = elapsed;
  timing.lastResult = static_cast<uint8_t>(result);
  cacheLastFatFsOperation = operation;
#else
  (void)operation; (void)startedMs; (void)result;
#endif
}
std::atomic<OfflineAckFatFsOperation> offlineAckFirstFatFsOperation{
    OfflineAckFatFsOperation::kNone};
std::atomic<uint8_t> offlineAckFirstFatFsResult{0U};
void recordOfflineAckFatFsFailure(OfflineAckFatFsOperation operation,
                                  FRESULT result) {
  if (!offlineAckJob.running() || result == FR_OK) return;
  OfflineAckFatFsOperation expected = OfflineAckFatFsOperation::kNone;
  if (offlineAckFirstFatFsOperation.compare_exchange_strong(expected, operation))
    offlineAckFirstFatFsResult.store(static_cast<uint8_t>(result));
}
const char* offlineAckFatFsOperationName(OfflineAckFatFsOperation operation) {
  switch (operation) {
    case OfflineAckFatFsOperation::kNone: return "NONE";
    case OfflineAckFatFsOperation::kStat: return "STAT";
    case OfflineAckFatFsOperation::kOpenRead: return "OPEN_READ";
    case OfflineAckFatFsOperation::kRead: return "READ";
    case OfflineAckFatFsOperation::kOpenWrite: return "OPEN_WRITE";
    case OfflineAckFatFsOperation::kWrite: return "WRITE";
    case OfflineAckFatFsOperation::kSync: return "SYNC";
    case OfflineAckFatFsOperation::kClose: return "CLOSE";
    case OfflineAckFatFsOperation::kUnlink: return "UNLINK";
    case OfflineAckFatFsOperation::kRename: return "RENAME";
  }
  return "UNKNOWN";
}

class NvsEventSequenceStorage : public dental::offline::EventSequenceStorage {
 public:
  bool read(uint64_t& value, bool& present) override {
    Preferences preferences;
    if (!preferences.begin("offline-id", false)) return false;
    present = preferences.isKey("high-water");
    const bool valid = !present || preferences.getType("high-water") == PT_U64;
    value = present && valid ? preferences.getULong64("high-water") : 0ULL;
    preferences.end(); return valid;
  }
  bool write(uint64_t value) override {
    Preferences preferences;
    if (!preferences.begin("offline-id", false)) return false;
    const bool result = preferences.putULong64("high-water", value) == sizeof(value);
    preferences.end(); return result;
  }
} eventSequenceStorage;
dental::offline::DurableEventSequence eventSequence(eventSequenceStorage);
bool reserveOfflineSequence(uint64_t floor, uint64_t& sequence) {
  return eventSequence.reserve(floor, sequence);
}
void recordOfflineReadbackTiming(bool begin) {
  if (!offlineTimingActive) return;
  if (begin) { offlineReadbackStartedMs = millis(); recordOfflineReadbackTimingActive = true; }
  else if (recordOfflineReadbackTimingActive) {
    offlineReadbackMs += millis() - offlineReadbackStartedMs;
    recordOfflineReadbackTimingActive = false;
  }
}

class FatFsFileStorage {
 public:
  bool ioFailed() const { return ioFailed_; }
  void clearIoFailure() { ioFailed_ = false; }
  bool reading() const { return reading_; }
  uint64_t readPosition() const { return reading_ ? f_tell(&file_) : UINT64_MAX; }
  bool beginReadAt(const char* path, uint64_t position) {
    if (!beginRead(path) || position > f_size(&file_)) { endRead(); return false; }
    const uint32_t started = millis();
    const FRESULT result = f_lseek(&file_, static_cast<FSIZE_t>(position));
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kRead, started, result);
    if (result != FR_OK) { ioFailed_ = true; endRead(); return false; }
    return true;
  }
  bool exists(const char* path) {
    FILINFO information = {};
    if (!path) return false;
    const uint32_t started = millis();
    const FRESULT result = f_stat(path, &information);
    if (result != FR_OK && result != FR_NO_FILE && result != FR_NO_PATH) ioFailed_ = true;
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kStat, started, result);
    if (result != FR_NO_FILE)
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kStat, result);
    foregroundStorageCheckpoint();
    return result == FR_OK && (information.fattrib & AM_DIR) == 0U;
  }
  bool remove(const char* path) {
    if (!path) return false;
    const uint32_t started = millis();
    const FRESULT result = f_unlink(path);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kUnlink, started, result);
    if (result != FR_NO_FILE)
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kUnlink, result);
    foregroundStorageCheckpoint();
    return result == FR_OK || result == FR_NO_FILE;
  }
  bool rename(const char* from, const char* to) {
    if (!from || !to) return false;
    const uint32_t started = millis();
    const FRESULT result = f_rename(from, to);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kRename, started, result);
    recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kRename, result);
    foregroundStorageCheckpoint();
    return result == FR_OK;
  }
  bool writeFile(const char* path, const char* data, size_t length) {
    return write(path, data, length, FA_WRITE | FA_CREATE_ALWAYS);
  }
  bool appendFile(const char* path, const char* data, size_t length) {
    return write(path, data, length, FA_WRITE | FA_OPEN_APPEND);
  }
  bool beginRead(const char* path) {
    endRead();
    if (!path) return false;
    const uint32_t started = millis();
    const FRESULT result = f_open(&file_, path, FA_READ);
    if (result != FR_OK && result != FR_NO_FILE && result != FR_NO_PATH) ioFailed_ = true;
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kOpenRead, started, result);
    recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kOpenRead, result);
    reading_ = result == FR_OK;
    foregroundStorageCheckpoint();
    return reading_;
  }
  bool readByte(uint8_t& value) {
    if (!reading_) return false;
    UINT count = 0U;
    const uint32_t started = millis();
    const FRESULT result = f_read(&file_, &value, 1U, &count);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kRead, started, result);
    foregroundStorageCheckpoint();
    if (result != FR_OK) {
      ioFailed_ = true;
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kRead, result);
      readError_ = true; return false;
    }
    if (count == 0U) eof_ = true;
    return count == 1U;
  }
  bool eof() const { return eof_; }
  bool error() const { return readError_; }
  void endRead() {
    if (reading_) {
      const uint32_t started = millis();
      const FRESULT result = f_close(&file_);
      recordCacheFatFsTiming(OfflineAckFatFsOperation::kClose, started, result);
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kClose, result);
    }
    reading_ = eof_ = readError_ = false;
    foregroundStorageCheckpoint();
  }
 private:
  bool write(const char* path, const char* data, size_t length, BYTE mode) {
    if (!path || (!data && length != 0U)) return false;
    FIL file = {};
    uint32_t started = millis();
    const FRESULT openResult = f_open(&file, path, mode);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kOpenWrite, started,
                           openResult);
    foregroundStorageCheckpoint();
    if (openResult != FR_OK) {
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kOpenWrite,
                                   openResult);
      return false;
    }
    UINT written = 0U;
    started = millis();
    const FRESULT writeResult = f_write(&file, data, length, &written);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kWrite, started,
                           writeResult);
    foregroundStorageCheckpoint();
    started = millis();
    const FRESULT syncResult = writeResult == FR_OK ? f_sync(&file) : writeResult;
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kSync, started, syncResult);
    foregroundStorageCheckpoint();
    started = millis();
    const FRESULT closeResult = f_close(&file);
    recordCacheFatFsTiming(OfflineAckFatFsOperation::kClose, started,
                           closeResult);
    recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kWrite, writeResult);
    if (writeResult == FR_OK && written != length)
      recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kWrite, FR_INT_ERR);
    recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kSync, syncResult);
    recordOfflineAckFatFsFailure(OfflineAckFatFsOperation::kClose, closeResult);
    foregroundStorageCheckpoint();
    return writeResult == FR_OK && syncResult == FR_OK && closeResult == FR_OK &&
           written == length;
  }
  FIL file_ = {};
  bool reading_ = false, eof_ = false, readError_ = false;
  bool ioFailed_ = false;
};

FatFsFileStorage remoteStorage;
// A suspended .tmp reader must not be closed by the foreground cache lookup.
// These are separate FIL cursors on the same serialized FatFs volume, not
// simultaneous/reentrant FatFs calls.
FatFsFileStorage publicationStorage;
bool beginCacheReplacement();

class SdCacheStorage : public dental::cache::CacheStorage {
 public:
  bool trustedRuntimeReads() const override { return true; }
  FatFsFileStorage& fileStorage() const {
    return storagePriority.background() ? publicationStorage : remoteStorage;
  }
  bool beginReplacement() override { return beginCacheReplacement(); }
  void endReplacement() override {
    storagePriority.endReplacement(); foregroundStorageCheckpoint();
  }
  bool available() const override { return microSdAvailable || storageProbeActive; }

  bool exists(const char* path) override { return fileStorage().exists(path); }

  bool remove(const char* path) override { return fileStorage().remove(path); }

  bool rename(const char* from, const char* to) override {
    return fileStorage().rename(from, to);
  }

  bool writeFile(const char* path, const char* data, size_t length) override {
    return fileStorage().writeFile(path, data, length);
  }

  bool appendFile(const char* path, const char* data, size_t length) override {
    return fileStorage().appendFile(path, data, length);
  }

  bool beginRead(const char* path) override {
    return fileStorage().beginRead(path);
  }

  dental::cache::ReadLineResult readLine(char* line,
                                          size_t capacity) override {
    if (capacity == 0U) {
      return dental::cache::ReadLineResult::kError;
    }
    size_t written = 0U;
    bool tooLong = false;
    uint8_t input = 0U;
    FatFsFileStorage& file = fileStorage();
    while (file.readByte(input)) {
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
    if (file.error()) return dental::cache::ReadLineResult::kError;
    if (written == 0U && file.eof())
      return dental::cache::ReadLineResult::kEnd;
    return tooLong ? dental::cache::ReadLineResult::kTooLong
                   : dental::cache::ReadLineResult::kLine;
  }

  void endRead() override { fileStorage().endRead(); }
};

class SdPendingJournalStorage
    : public dental::offline::PendingJournalStorage {
 public:
  bool trustedRuntimeReads() const override { return true; }
  bool reserveEventSequence(uint64_t floor, uint64_t& sequence) override {
    return reserveOfflineSequence(floor, sequence);
  }
  void appendReadbackTiming(bool begin) override { recordOfflineReadbackTiming(begin); }
  uint64_t readPosition() const override { return remoteStorage.readPosition(); }
  bool beginReadAt(const char* path, uint64_t offset) override { return remoteStorage.beginReadAt(path, offset); }
  bool ioFailed() const override { return remoteStorage.ioFailed(); }
  void clearIoFailure() override { remoteStorage.clearIoFailure(); }
  bool available() const override { return microSdAvailable || storageProbeActive; }

  bool exists(const char* path) override { return remoteStorage.exists(path); }

  bool remove(const char* path) override { return remoteStorage.remove(path); }

  bool rename(const char* from, const char* to) override {
    return remoteStorage.rename(from, to);
  }

  bool writeFile(const char* path, const char* data, size_t length) override {
    return remoteStorage.writeFile(path, data, length);
  }

  bool appendFile(const char* path, const char* data, size_t length) override {
    return remoteStorage.appendFile(path, data, length);
  }

  bool beginRead(const char* path) override {
    return remoteStorage.beginRead(path);
  }

  dental::offline::JournalReadLineResult readLine(
      char* line, size_t capacity) override {
    using dental::offline::JournalReadLineResult;
    if (journalPreviewActive && activeTransaction) return JournalReadLineResult::kYielded;
    if (capacity == 0U) {
      return JournalReadLineResult::kError;
    }
    size_t written = 0U;
    bool tooLong = false;
    bool terminated = false;
    uint8_t input = 0U;
    while (remoteStorage.readByte(input)) {
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
    if (remoteStorage.error()) return JournalReadLineResult::kError;
    if (written == 0U && !terminated && remoteStorage.eof())
      return JournalReadLineResult::kEnd;
    if (tooLong) {
      return terminated ? JournalReadLineResult::kTooLongTerminated
                        : JournalReadLineResult::kTooLongUnterminated;
    }
    return terminated ? JournalReadLineResult::kTerminatedLine
                      : JournalReadLineResult::kUnterminatedLine;
  }

  void endRead() override { remoteStorage.endRead(); }
};

SdCacheStorage cacheStorage;
dental::cache::OfflineInventoryCache offlineInventoryCache(cacheStorage);
SdPendingJournalStorage pendingJournalStorage;
dental::offline::OfflineCacheLookup offlineCacheLookup(cacheStorage);
dental::offline::PendingJournal offlinePendingJournal(pendingJournalStorage);
dental::offline::AcknowledgementJob offlineAckJob;
uint32_t offlineAckPreflightMs = 0U;

void reportOfflineAckProgress(dental::offline::JournalAcknowledgementStage stage,
                              void*) {
  using JobStage = dental::offline::AcknowledgementJob::Stage;
  JobStage mapped = JobStage::kNone;
  switch (stage) {
    case dental::offline::JournalAcknowledgementStage::kSourceScan:
      mapped = JobStage::kSourceScan; break;
    case dental::offline::JournalAcknowledgementStage::kTempCleanup:
      mapped = JobStage::kTempCleanup; break;
    case dental::offline::JournalAcknowledgementStage::kTempHeader:
      mapped = JobStage::kTempHeader; break;
    case dental::offline::JournalAcknowledgementStage::kCopyRows:
      mapped = JobStage::kCopyRows; break;
    case dental::offline::JournalAcknowledgementStage::kTempVerify:
      mapped = JobStage::kTempVerify; break;
    case dental::offline::JournalAcknowledgementStage::kPromote:
      mapped = JobStage::kPromote; break;
    case dental::offline::JournalAcknowledgementStage::kInstalledVerify:
      mapped = JobStage::kInstalledVerify; break;
  }
  offlineAckJob.setStage(mapped);
  offlineAckJob.recordStackHighWater(uxTaskGetStackHighWaterMark(nullptr));
  Serial.printf("Offline ACK stage: %s elapsedMs=%lu stackHighWater=%lu\n",
                dental::offline::AcknowledgementJob::stageName(mapped),
                static_cast<unsigned long>(offlineAckJob.elapsedMs(millis())),
                static_cast<unsigned long>(offlineAckJob.stackHighWater()));
}

// The lower-priority worker is pinned to loopTask's core. The HTTP loop can
// preempt it; only the worker services the ATmega link and FatFs while active.
void retireOfflineHeadTask(void*) {
  offlineAckJob.markRunning(static_cast<int8_t>(xPortGetCoreID()));
  offlineAckJob.recordStackHighWater(uxTaskGetStackHighWaterMark(nullptr));
  Serial.printf("Offline ACK worker started: core=%d stackHighWater=%lu\n",
                static_cast<int>(offlineAckJob.workerCore()),
                static_cast<unsigned long>(offlineAckJob.stackHighWater()));
  offlinePendingJournal.setAcknowledgementProgress(reportOfflineAckProgress,
                                                    nullptr);
  const dental::offline::JournalAcknowledgementResult result =
      offlinePendingJournal.acknowledgeOldest(offlineAckJob.eventId());
  offlinePendingJournal.setAcknowledgementProgress(nullptr, nullptr);
  offlineAckJob.recordStackHighWater(uxTaskGetStackHighWaterMark(nullptr));
  using Failure = dental::offline::AcknowledgementJob::Failure;
  Failure failure = Failure::kUnexpectedResult;
  switch (result) {
    case dental::offline::JournalAcknowledgementResult::kJournalUnavailable:
      failure = Failure::kJournalUnavailable; break;
    case dental::offline::JournalAcknowledgementResult::kInvalidJournal:
      failure = Failure::kInvalidJournal; break;
    case dental::offline::JournalAcknowledgementResult::kWriteFailed:
      failure = Failure::kWriteFailed; break;
    default: break;
  }
  const StorageRequestFailure storageFailure =
      offlineAckFirstStorageFailure.load();
  if (result != dental::offline::JournalAcknowledgementResult::kAcknowledged &&
      result != dental::offline::JournalAcknowledgementResult::kAlreadyAcknowledged) {
    if (storageFailure == StorageRequestFailure::kTimedOut)
      failure = Failure::kStorageTimeout;
    else if (storageFailure == StorageRequestFailure::kUnavailable)
      failure = Failure::kStorageUnavailable;
    else if (storageFailure != StorageRequestFailure::kNone)
      failure = Failure::kStorageRejected;
  }
  offlineAckJob.finish(
      result == dental::offline::JournalAcknowledgementResult::kAcknowledged ||
      result == dental::offline::JournalAcknowledgementResult::kAlreadyAcknowledged,
      millis(), failure);
  Serial.printf("Offline ACK: state=%s stage=%s failure=%s storage=%s fatfs=%s:%u elapsedMs=%lu stackHighWater=%lu core=%d\n",
                dental::offline::AcknowledgementJob::stateName(offlineAckJob.state()),
                dental::offline::AcknowledgementJob::stageName(offlineAckJob.stage()),
                dental::offline::AcknowledgementJob::failureName(offlineAckJob.failure()),
                storageRequestFailureName(storageFailure),
                offlineAckFatFsOperationName(offlineAckFirstFatFsOperation.load()),
                static_cast<unsigned>(offlineAckFirstFatFsResult.load()),
                static_cast<unsigned long>(offlineAckJob.elapsedMs(millis())),
                static_cast<unsigned long>(offlineAckJob.stackHighWater()),
                static_cast<int>(offlineAckJob.workerCore()));
  vTaskDelete(nullptr);
}
// These bounded records are reused by the single-threaded transaction state
// machine. Keeping them in static storage prevents maximum-size desktop fields
// from exhausting the Arduino loop task stack during nested SD validation.
dental::cache::CacheProduct offlineProductBuffer = {};
dental::offline::OfflineJournalRecord offlineCommittedRecordBuffer = {};
dental::offline::OfflineJournalRecord offlinePendingReadBuffer = {};


WorkflowState workflowState = WorkflowState::kIdle;
uint32_t workflowStateStartedMs = 0UL;
bool feedbackIndicatorIsOn = false;
const TransactionProfile* activeTransaction = nullptr;
dental::offline::TransactionRoute activeTransactionRoute =
    dental::offline::TransactionRoute::kOnline;
bool transactionRouteCaptured = false;
char capturedCacheGeneration[dental::cache::kGenerationCapacity] = {};
uint32_t capturedCacheItemCount = 0U;

WiFiConnectionState wiFiConnectionState = WiFiConnectionState::kDisabled;
uint32_t wiFiStateStartedMs = 0UL;
uint32_t lastWiFiProgressMs = 0UL;
bool httpServerRunning = false;
bool accessPointReady = false;
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

String barcodeBuffer;
bool barcodeIsInvalid = false;
uint32_t lastBarcodeByteMs = 0UL;
dental::registration::BarcodeCapture registrationBarcodeCapture;
bool registrationCaptureOutcomeReported = false;
dental::controller_link::ForwardedOperationRouter controllerOperationRouter;

void setStockStatusIndicator(StockStatus status);
void startNextCommittedResultFeedback(uint32_t nowMs);
void drainScannerInput();

StockStatus toEventStockStatus(dental::cache::StockStatus status) {
  switch (status) {
    case dental::cache::StockStatus::kHigh: return StockStatus::kHigh;
    case dental::cache::StockStatus::kLow: return StockStatus::kLow;
    case dental::cache::StockStatus::kEmpty: return StockStatus::kEmpty;
  }
  return StockStatus::kEmpty;
}

// LCD belongs to ATmega PC4/PC5. Existing display call sites retain their
// transaction behavior; compact result/error frames below deliver the final
// outcome without letting the ESP32 write I2C or gate storage on the display.
void showLcdScreen(const String&, const String&, const String&, const String&) {
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

dental::rtc_recovery::State recoveryState(dental_link::rtc::State state) {
  return state == dental_link::rtc::State::kReady
             ? dental::rtc_recovery::State::kReady
             : state == dental_link::rtc::State::kNeedsSync
                   ? dental::rtc_recovery::State::kNeedsSync
                   : dental::rtc_recovery::State::kUnavailable;
}

dental::rtc_recovery::Reason recoveryReason(dental_link::rtc::Reason reason) {
  switch (reason) {
    case dental_link::rtc::Reason::kNone:
      return dental::rtc_recovery::Reason::kNone;
    case dental_link::rtc::Reason::kLostPower:
      return dental::rtc_recovery::Reason::kLostPower;
    case dental_link::rtc::Reason::kInvalidTime:
      return dental::rtc_recovery::Reason::kInvalidTime;
    case dental_link::rtc::Reason::kVerificationFailed:
      return dental::rtc_recovery::Reason::kVerificationFailed;
    case dental_link::rtc::Reason::kCommunicationFailure:
      return dental::rtc_recovery::Reason::kCommunicationFailure;
  }
  return dental::rtc_recovery::Reason::kCommunicationFailure;
}

void failRtcBridgeRequest() {
  rtcBridgeRequest = RtcBridgeRequest::kNone;
  rtcBridgeResponseSucceeded = false;
  setRtcStatus({dental::rtc_recovery::State::kUnavailable,
                dental::rtc_recovery::Reason::kCommunicationFailure});
}

void handleControllerRtcFrame(dental_link::Frame frame, const char* payload,
                              uint32_t nowMs) {
  if (frame == dental_link::Frame::kRtcTime) {
    dental_link::rtc::DateTime value;
    if (rtcBridgeRequest != RtcBridgeRequest::kTime ||
        !dental_link::rtc::parseDateTime(payload, value)) return;
    snprintf(rtcBridgeTimestamp, sizeof(rtcBridgeTimestamp), "%s", payload);
    setRtcStatus({dental::rtc_recovery::State::kReady,
                  dental::rtc_recovery::Reason::kNone});
    rtcBridgeResponseSucceeded = true;
    rtcBridgeRequest = RtcBridgeRequest::kNone;
    lastRtcStatusPollMs = nowMs;
    return;
  }

  dental_link::rtc::State state;
  dental_link::rtc::Reason reason;
  if (!dental_link::rtc::parseState(payload, state, reason)) return;
  setRtcStatus({recoveryState(state), recoveryReason(reason)});
  lastRtcStatusPollMs = nowMs;
  if ((frame == dental_link::Frame::kRtcStatus &&
       (rtcBridgeRequest == RtcBridgeRequest::kStatus ||
        rtcBridgeRequest == RtcBridgeRequest::kTime)) ||
      (frame == dental_link::Frame::kRtcSyncResult &&
       rtcBridgeRequest == RtcBridgeRequest::kSync)) {
    rtcBridgeResponseSucceeded =
        frame == dental_link::Frame::kRtcStatus
            ? rtcBridgeRequest == RtcBridgeRequest::kStatus
            : state == dental_link::rtc::State::kReady;
    rtcBridgeRequest = RtcBridgeRequest::kNone;
  }
}

bool waitForRtcBridgeIdle(uint32_t timeoutMs) {
  const uint32_t started = millis();
  while ((rtcBridgeRequest != RtcBridgeRequest::kNone ||
          atmegaResponder.busy()) && millis() - started < timeoutMs) {
    serviceAtmegaLink();
    delay(1UL);
  }
  return rtcBridgeRequest == RtcBridgeRequest::kNone &&
         !atmegaResponder.busy();
}

bool requestRtcBridge(const char* line, RtcBridgeRequest request) {
  if (!dental::hardware::kAtmegaLinkEnabled ||
      rtcBridgeRequest != RtcBridgeRequest::kNone ||
      !atmegaResponder.queueLine(line)) return false;
  rtcBridgeRequest = request;
  rtcBridgeStartedMs = millis();
  rtcBridgeResponseSucceeded = false;
  return true;
}

bool requestRtcBridgeAndWait(const char* line, RtcBridgeRequest request) {
  if (!waitForRtcBridgeIdle(kRtcBridgeTimeoutMs) ||
      !requestRtcBridge(line, request)) {
    failRtcBridgeRequest(); return false;
  }
  while (rtcBridgeRequest != RtcBridgeRequest::kNone &&
         millis() - rtcBridgeStartedMs < kRtcBridgeTimeoutMs) {
    serviceAtmegaLink();
    delay(1UL);
  }
  if (rtcBridgeRequest != RtcBridgeRequest::kNone) {
    failRtcBridgeRequest(); return false;
  }
  return rtcBridgeResponseSucceeded;
}

void serviceRtcBridge(uint32_t nowMs) {
  if (rtcBridgeRequest != RtcBridgeRequest::kNone) {
    if (nowMs - rtcBridgeStartedMs >= kRtcBridgeTimeoutMs)
      failRtcBridgeRequest();
    return;
  }
  if (nowMs - lastRtcStatusPollMs >= kRtcStatusPollMs &&
      !atmegaResponder.busy()) {
    requestRtcBridge(dental_link::kRtcStatusRequest,
                     RtcBridgeRequest::kStatus);
  }
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
  return rtcAvailable && microSdAvailable &&
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
  snprintf(discoveryDeviceId, sizeof(discoveryDeviceId), "ATD-%08lX",
           static_cast<unsigned long>(chipIdentifier & 0xFFFFFFFFULL));
  if (!dental::offline::formatDeviceIdentifier(chipIdentifier,
                                                offlineDeviceIdentifier)) {
    offlineDeviceIdentifier[0] = '\0';
  }
  // setup calls this before peripherals/Wi-Fi start. Enable true hardware
  // entropy while RF is off, then disable it before any normal initialization.
  bootloader_random_enable();
  const uint32_t sessionRandomHigh = esp_random();
  const uint32_t sessionRandomLow = esp_random();
  cachePublicationJob.seedJobId(sessionRandomLow);
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
    Serial.println("WARNING: Hardware event queue full; online scan rejected");
    return false;
  }

  PendingTransactionEvent event = {};
  if (!dental::events::formatEventId(event.eventId, bootSessionIdentifier,
                                    nextEventSequence)) {
    Serial.println("WARNING: Hardware event ID generation failed; online scan rejected");
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

bool onlineDeliveryAvailable() {
  return !pendingEvents.full() && nextEventSequence != 0ULL;
}

void handleHealthRequest() {
  httpServer.send(
      200, "application/json",
      "{\"status\":\"ok\",\"device\":\"dental-inventory-esp32\",\"phase\":4}");
}

void handleStatusRequest() {
#if ENABLE_HTTP_SERVICE_TIMING
  ++statusHandlerCount;
  SlowHttpHandlerTrace timing("/status");
#endif
  String response;
  response.reserve(704U);
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
  const char* journalState = sdRecovery.state() ==
          dental::storage::RuntimeSdRecovery::State::kRecovering ? "recovering" :
      offlinePendingJournal.stateName(cacheMetadata.available ? cacheMetadata.generation : nullptr);
  response += ",\"offlineJournalState\":";
  appendJsonString(response, journalState);
  response += ",\"offlineJournalReason\":";
  appendJsonString(response, strcmp(journalState, "full") == 0 ? "capacity_reached" :
      strcmp(journalState, "generation_mismatch") == 0 ? "cache_generation_mismatch" :
      offlinePendingJournal.reasonName());
  if (microSdAvailable && journalMetadata.available &&
      !offlinePendingJournal.uncertain() &&
      !offlinePendingJournal.temporarilyUnavailable()) {
    response += ",\"pendingSyncItems\":";
    response += String(offlineAckJob.running()
                           ? offlineAckJob.pendingCountBefore()
                           : journalMetadata.pendingCount);
    response += ",\"offlineReady\":";
    response += offlineOperationIsReady() ? "true" : "false";
  }
  response += ",\"offlineAckState\":\"";
  response += dental::offline::AcknowledgementJob::stateName(offlineAckJob.state());
  response += "\",\"offlineAckEventId\":";
  if (offlineAckJob.state() == dental::offline::AcknowledgementJob::State::kIdle)
    response += "null";
  else
    appendJsonString(response, offlineAckJob.eventId());
  response += ",\"offlineAckStage\":\"";
  response += dental::offline::AcknowledgementJob::stageName(offlineAckJob.stage());
  response += "\",\"offlineAckFailureReason\":\"";
  response += dental::offline::AcknowledgementJob::failureName(offlineAckJob.failure());
  response += "\",\"offlineAckStartedMs\":";
  response += String(offlineAckJob.startedMs());
  response += ",\"offlineAckElapsedMs\":";
  response += String(offlineAckJob.elapsedMs(millis()));
  response += ",\"offlineAckAttempts\":";
  response += String(offlineAckJob.attempts());
  response += ",\"offlineAckStackHighWater\":";
  response += String(offlineAckJob.stackHighWater());
  response += ",\"offlineAckWorkerCore\":";
  response += String(offlineAckJob.workerCore());
  response += ",\"offlineAckPreflightMs\":";
  response += String(offlineAckPreflightMs);
  response += ",\"offlineAckStorageFailure\":\"";
  response += storageRequestFailureName(offlineAckFirstStorageFailure.load());
  response += "\",\"offlineAckFatFsOperation\":\"";
  response += offlineAckFatFsOperationName(offlineAckFirstFatFsOperation.load());
  response += "\",\"offlineAckFatFsResult\":";
  response += String(offlineAckFirstFatFsResult.load());
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
  if (cachePublicationJob.active()) {
    sendRtcSyncError(409, "cache_publication_in_progress");
    return;
  }
  if (offlineAckJob.running()) {
    sendRtcSyncError(409, "offline_ack_in_progress");
    return;
  }
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

  dental_link::rtc::DateTime localTime;
  char timestamp[20];
  char frame[40];
  if (request.localEpochSeconds < kUnixEpochAt2000 ||
      !dental_link::rtc::fromSecondsSince2000(
          request.localEpochSeconds - kUnixEpochAt2000, localTime) ||
      !dental_link::rtc::formatDateTime(localTime, timestamp,
                                        sizeof(timestamp))) {
    sendRtcSyncError(400, "invalid_timestamp");
    return;
  }
  const int frameLength = snprintf(frame, sizeof(frame), "%s%s\n",
                                   dental_link::kRtcSyncPrefix, timestamp);
  if (frameLength <= 0 || frameLength >= static_cast<int>(sizeof(frame)) ||
      !requestRtcBridgeAndWait(frame, RtcBridgeRequest::kSync)) {
    Serial.println("RTC synchronization: FAILED - ATmega verification failed");
    sendRtcSyncError(
        rtcStatus.state == dental::rtc_recovery::State::kUnavailable ? 503 : 500,
        rtcStatus.state == dental::rtc_recovery::State::kUnavailable
            ? "rtc_unavailable"
            : "verification_failed");
    return;
  }

  Serial.println("RTC synchronization: SUCCESS - desktop time verified");
  if (workflowState == WorkflowState::kIdle) {
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
  if (cachePublicationJob.active()) {
    sendBarcodeCaptureError(409, "cache_publication_in_progress");
    return;
  }
  if (offlineAckJob.running()) {
    sendBarcodeCaptureError(409, "offline_ack_in_progress");
    return;
  }
  if (!deviceTokenIsConfigured()) {
    sendBarcodeCaptureError(503, "authentication_unconfigured");
    return;
  }
  if (!deviceRequestIsAuthenticated()) {
    sendBarcodeCaptureError(401, "unauthorized");
    return;
  }
  if (!dental::hardware::kAtmegaLinkEnabled) {
    sendBarcodeCaptureError(503, "scanner_unavailable");
    return;
  }
  if (workflowState != WorkflowState::kIdle ||
      registrationBarcodeCapture.active()) {
    sendBarcodeCaptureError(409, "scanner_busy");
    return;
  }

  drainScannerInput();
  if (!registrationBarcodeCapture.start(millis(), false)) {
    sendBarcodeCaptureError(409, "scanner_busy");
    return;
  }
  registrationCaptureOutcomeReported = false;
  showLcdScreen("REGISTER PRODUCT", "ATmega scanner ready", "Scan barcode",
                "Please wait");
  Serial.println("Registration barcode capture started");
  httpServer.send(200, "application/json", "{\"started\":true}");
}

void handleReadBarcodeCaptureRequest() {
  if (offlineAckJob.running()) {
    sendBarcodeCaptureError(409, "offline_ack_in_progress");
    return;
  }
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

const char* compactAcknowledgedJournalAfterCacheRefresh() {
  foregroundStorageCheckpoint();
  const dental::offline::PendingJournalMetadata& metadata =
      offlinePendingJournal.metadata();
  if (!metadata.available || offlinePendingJournal.uncertain() ||
      metadata.pendingCount != 0U || metadata.storedCount == 0U) {
    return nullptr;
  }
  const bool background = storagePriority.background();
  if (background) storagePriority.beginReplacement(false, false);
  struct CompactionScope {
    bool background;
    ~CompactionScope() {
      if (background) {
        storagePriority.endReplacement(); foregroundStorageCheckpoint();
      }
    }
  } compactionScope{background};
  const dental::offline::JournalCompactionResult result =
      offlinePendingJournal.compactAcknowledgedPrefix();
  if (result ==
          dental::offline::JournalCompactionResult::kCompacted ||
      result ==
          dental::offline::JournalCompactionResult::kAlreadyCompacted) {
    Serial.println(
        "Pending offline journal: acknowledged prefix compacted");
    return nullptr;
  }
  if (result ==
      dental::offline::JournalCompactionResult::kJournalUnavailable) {
    return "pending_journal_unavailable";
  } else {
    return "pending_journal_compaction_failed";
  }
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

using CacheJob = dental::cache::CachePublicationJob;
CacheJob::Outcome cacheFailure(uint16_t status, const char* error) {
  CacheJob::Outcome outcome;
  outcome.httpStatus = status;
  outcome.error = error;
  return outcome;
}

CacheJob::Outcome executeCacheOperation(const CacheRequest& request) {
  // This executes only from loop(), never from WebServer::handleClient().
  // A request queued just before an offline transaction may run only after
  // that transaction finishes. Recheck the journal interlock at execution
  // time: the transaction may have appended a durable pending record meanwhile.
  if (offlinePendingJournal.blocksCacheReplacement() &&
      !requestIsInstalledCacheNoOp(request))
    return cacheFailure(409, "pending_sync_interlock");
  if (request.operation == CacheOperation::kBegin) {
    const BeginResult result = offlineInventoryCache.begin(
        request.generation, request.itemCount);
    if (result == BeginResult::kStorageUnavailable)
      return cacheFailure(503, "storage_unavailable");
    if (result == BeginResult::kWriteFailed)
      return cacheFailure(500, "cache_write_failed");
    const bool alreadyCurrent = result == BeginResult::kAlreadyCurrent;
    // An already-current begin is the complete cache-install handshake. The
    // desktop intentionally sends no item/commit requests in this case, which
    // also covers a drained offline batch whose net stock delta is zero.
    if (alreadyCurrent) {
      const char* error = compactAcknowledgedJournalAfterCacheRefresh();
      if (error != nullptr) return cacheFailure(
          strcmp(error, "pending_journal_unavailable") == 0 ? 503 : 500, error);
    }
    return {200U, nullptr, offlineInventoryCache.receivedItems(),
            alreadyCurrent};
  }

  if (request.operation == CacheOperation::kItem) {
    const ItemResult result = offlineInventoryCache.item(
        request.generation, request.index, request.product);
    if (result == ItemResult::kNoTransfer)
      return cacheFailure(409, "no_active_transfer");
    if (result == ItemResult::kGenerationMismatch)
      return cacheFailure(409, "generation_mismatch");
    if (result == ItemResult::kUnexpectedIndex)
      return cacheFailure(409, "unexpected_index");
    if (result == ItemResult::kConflictingItem)
      return cacheFailure(409, "conflicting_item");
    if (result == ItemResult::kWriteFailed)
      return cacheFailure(500, "cache_write_failed");
    return {200U, nullptr, offlineInventoryCache.receivedItems(), false};
  }

  const CommitResult result = offlineInventoryCache.commit(
      request.generation, request.itemCount);
  if (result == CommitResult::kStorageUnavailable)
    return cacheFailure(503, "storage_unavailable");
  if (result == CommitResult::kInterlocked)
    return cacheFailure(409, "pending_sync_interlock");
  if (result == CommitResult::kNoTransfer)
    return cacheFailure(409, "no_active_transfer");
  if (result == CommitResult::kGenerationMismatch)
    return cacheFailure(409, "generation_mismatch");
  if (result == CommitResult::kCountMismatch)
    return cacheFailure(409, "item_count_mismatch");
  if (result == CommitResult::kValidationFailed)
    return cacheFailure(422, "cache_validation_failed");
  if (result == CommitResult::kReplacementFailed)
    return cacheFailure(500, "cache_replacement_failed");
  const bool alreadyCurrent = result == CommitResult::kAlreadyCurrent;
  if (!alreadyCurrent) {
    offlineCacheLookup.invalidate();
    offlineCacheLookup.find(offlineInventoryCache.metadata(), "~", offlineProductBuffer);
  }
  const char* error = compactAcknowledgedJournalAfterCacheRefresh();
  if (error != nullptr) return cacheFailure(
      strcmp(error, "pending_journal_unavailable") == 0 ? 503 : 500, error);
  if (!alreadyCurrent) {
    Serial.print("Offline inventory cache installed: ");
    Serial.print(request.generation);
    Serial.print(" / items: ");
    Serial.println(request.itemCount);
  }
  return {200U, nullptr, request.itemCount, alreadyCurrent};
}

void sendCacheProcessing() {
  String response;
  response.reserve(280U);
  response = "{\"processing\":true,\"jobId\":";
  response += String(cachePublicationJob.jobId());
  response += ",\"operation\":";
  appendJsonString(response,
                   cacheOperationName(cachePublicationJob.request().operation));
  response += ",\"generation\":";
  appendJsonString(response, cachePublicationJob.request().generation);
  response += ",\"stage\":";
  appendJsonString(response, CacheJob::stateName(cachePublicationJob.state()));
  response += ",\"elapsedMs\":";
  response += String(millis() - cachePublicationJob.startedMs());
  response += ",\"storageOwner\":\"CACHE\",\"lastFatFsOperation\":";
  appendJsonString(response,
                   offlineAckFatFsOperationName(cacheLastFatFsOperation));
  response += ",\"lastFatFsResult\":";
  response += String(cacheFatFsTiming[static_cast<uint8_t>(
      cacheLastFatFsOperation)].lastResult);
  response += ",\"failureReason\":\"NONE\"";
  response += '}';
  httpServer.send(202, "application/json", response);
}

void handleOfflineCacheProgressRequest() {
  const String id = httpServer.arg("jobId");
  if (id.length() == 0U || id.length() > 10U) {
    sendCacheError(400, "invalid_job_id"); return;
  }
  uint64_t parsed = 0ULL;
  for (size_t i = 0U; i < id.length(); ++i) {
    if (id[i] < '0' || id[i] > '9') {
      sendCacheError(400, "invalid_job_id"); return;
    }
    parsed = parsed * 10ULL + static_cast<uint8_t>(id[i] - '0');
    if (parsed > 0xFFFFFFFFULL) {
      sendCacheError(400, "invalid_job_id"); return;
    }
  }
  if (parsed == 0ULL || parsed != cachePublicationJob.jobId()) {
    sendCacheError(404, "unknown_job_id"); return;
  }
  if (cachePublicationJob.active()) { sendCacheProcessing(); return; }
  if (cachePublicationJob.state() == CacheJob::State::kSucceeded) {
    const auto& outcome = cachePublicationJob.outcome();
    sendCacheSuccess(cachePublicationJob.request(), outcome.receivedItems,
                     outcome.alreadyCurrent);
    return;
  }
  if (cachePublicationJob.state() == CacheJob::State::kFailed) {
    const auto& outcome = cachePublicationJob.outcome();
    sendCacheError(outcome.httpStatus, outcome.error);
    return;
  }
  sendCacheError(404, "unknown_job_id");
}

void handleOfflineCacheRequest() {
#if ENABLE_HTTP_SERVICE_TIMING
  SlowHttpHandlerTrace timing("/offline/cache");
#endif
  const String body = httpServer.arg("plain");
  if (!dental::cache::parseCacheRequest(body.c_str(), body.length(),
                                        cacheIncomingRequest)) {
    sendCacheError(400, "invalid_request"); return;
  }
  const CacheJob::Submission classification = cachePublicationJob.submit(
      cacheIncomingRequest, millis());
  if (classification == CacheJob::Submission::kBusy) {
    sendCacheError(409, "cache_publication_in_progress"); return;
  }
  if (classification == CacheJob::Submission::kProcessing) {
    sendCacheProcessing(); return;
  }
  if (classification == CacheJob::Submission::kCompleted) {
    const auto& outcome = cachePublicationJob.outcome();
    sendCacheSuccess(cachePublicationJob.request(), outcome.receivedItems,
                     outcome.alreadyCurrent);
    return;
  }
  // Only the just-queued request may be canceled without touching FatFs.
  const char* interlock = nullptr;
  if (offlineAckJob.running()) interlock = "offline_ack_in_progress";
  else if (!microSdAvailable) interlock = "storage_unavailable";
  else if (offlineTransactionIsActive() &&
           !requestIsInstalledCacheNoOp(cacheIncomingRequest))
    interlock = "offline_transaction_active";
  else if (offlinePendingJournal.blocksCacheReplacement() &&
           !requestIsInstalledCacheNoOp(cacheIncomingRequest))
    interlock = "pending_sync_interlock";
  if (interlock != nullptr) {
    cachePublicationJob.cancelQueued();
    sendCacheError(strcmp(interlock, "storage_unavailable") == 0 ? 503 : 409,
                   interlock);
    return;
  }
  cacheLastFatFsOperation = OfflineAckFatFsOperation::kNone;
  sendCacheProcessing();
}

void serviceCachePublication() {
  if (cachePublicationJob.state() != CacheJob::State::kQueued) return;
  // A cache request may have been queued just before a button frame. Keep its
  // job ID/progress alive until barcode processing releases the transaction.
  // This preserves the offline generation and prevents an online SCAN from
  // nesting a synchronous RTC request inside a cache sector wait.
  if (activeTransaction != nullptr) return;
#if ENABLE_HTTP_SERVICE_TIMING
  memset(cacheFatFsTiming, 0, sizeof(cacheFatFsTiming));
  cacheLastFatFsOperation = OfflineAckFatFsOperation::kNone;
#endif
  cacheRemoteReads = CacheRemoteTiming{};
  cacheRemoteWrites = CacheRemoteTiming{};
  const uint32_t started = millis();
  cacheControllerTxBytes = cacheControllerRxBytes = 0U;
  cacheFatSectors = cacheRootDirectorySectors = cacheOtherSectors = 0U;
  storagePriority.beginBackground();
  cachePublicationJob.run(executeCacheOperation, []() { return millis(); });
  storagePriority.endBackground();
  Serial.printf("Cache I/O profile: operation=%s reads=%lu writes=%lu FAT=%lu rootDirectory=%lu other=%lu TX=%lu RX=%lu\n",
      cacheOperationName(cachePublicationJob.request().operation),
      static_cast<unsigned long>(cacheRemoteReads.calls),
      static_cast<unsigned long>(cacheRemoteWrites.calls),
      static_cast<unsigned long>(cacheFatSectors),
      static_cast<unsigned long>(cacheRootDirectorySectors),
      static_cast<unsigned long>(cacheOtherSectors),
      static_cast<unsigned long>(cacheControllerTxBytes),
      static_cast<unsigned long>(cacheControllerRxBytes));
  Serial.printf("Cache controller bytes: TX=%lu RX=%lu\n",
                static_cast<unsigned long>(cacheControllerTxBytes),
                static_cast<unsigned long>(cacheControllerRxBytes));
  Serial.printf("Offline cache %s: operation=%s elapsedMs=%lu status=%u owner=CACHE error=%s\n",
                CacheJob::stateName(cachePublicationJob.state()),
                cacheOperationName(cachePublicationJob.request().operation),
                static_cast<unsigned long>(millis() - started),
                cachePublicationJob.outcome().httpStatus,
                cachePublicationJob.outcome().error == nullptr ? "NONE" :
                    cachePublicationJob.outcome().error);
#if ENABLE_HTTP_SERVICE_TIMING
  Serial.printf("Offline cache loopTask stack high water: %lu bytes\n",
                static_cast<unsigned long>(uxTaskGetStackHighWaterMark(nullptr)));
  for (uint8_t i = 1U; i < sizeof(cacheFatFsTiming) / sizeof(cacheFatFsTiming[0]); ++i) {
    const CacheFatFsTiming& item = cacheFatFsTiming[i];
    if (item.calls == 0U) continue;
    Serial.printf("Cache FatFs %s: calls=%lu totalMs=%lu longestMs=%lu lastResult=%u\n",
                  offlineAckFatFsOperationName(static_cast<OfflineAckFatFsOperation>(i)),
                  static_cast<unsigned long>(item.calls),
                  static_cast<unsigned long>(item.totalMs),
                  static_cast<unsigned long>(item.longestMs), item.lastResult);
  }
  Serial.printf("Cache remote sectors: reads=%lu readTotalMs=%lu readMaxMs=%lu writes=%lu writeTotalMs=%lu writeMaxMs=%lu\n",
                static_cast<unsigned long>(cacheRemoteReads.calls),
                static_cast<unsigned long>(cacheRemoteReads.totalMs),
                static_cast<unsigned long>(cacheRemoteReads.longestMs),
                static_cast<unsigned long>(cacheRemoteWrites.calls),
                static_cast<unsigned long>(cacheRemoteWrites.totalMs),
                static_cast<unsigned long>(cacheRemoteWrites.longestMs));
#endif
}

void handleNextEventRequest() {
#if ENABLE_HTTP_SERVICE_TIMING
  ++eventHandlerCount;
  SlowHttpHandlerTrace timing("/events/next");
#endif
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
  // Journal reads pump the controller link. A SCAN received during that read
  // must not recursively enter RTC/FatFs transaction work on the same owner.
  if (activeTransaction != nullptr) {
    sendOfflinePendingReadError(409, "transaction_active");
    return;
  }
  if (cachePublicationJob.active()) {
    sendOfflinePendingReadError(409, "cache_publication_in_progress");
    return;
  }
  if (offlineAckJob.running()) {
    sendOfflinePendingReadError(409, "offline_ack_in_progress");
    return;
  }
  if (!microSdAvailable || offlinePendingJournal.temporarilyUnavailable()) {
    sendOfflinePendingReadError(503, sdRecovery.state() ==
        dental::storage::RuntimeSdRecovery::State::kRecovering ?
        "storage_recovering" : "storage_transport_unavailable");
    return;
  }
  const dental::offline::JournalPeekResult result =
      [&]() {
        journalPreviewActive = true;
        const auto value = offlinePendingJournal.peekOldest(offlinePendingReadBuffer);
        journalPreviewActive = false;
        return value;
      }();
  if (result == dental::offline::JournalPeekResult::kYielded) {
    sendOfflinePendingReadError(409, "transaction_active");
    return;
  }
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
  if (cachePublicationJob.active()) {
    sendAcknowledgementError(409, "cache_publication_in_progress");
    return;
  }
  char requestedEventId[dental::events::kEventIdCapacity] = {};
  const String body = httpServer.arg("plain");
  if (!dental::events::parseAcknowledgementBody(
          body.c_str(), body.length(), requestedEventId)) {
    sendAcknowledgementError(400, "invalid_request");
    return;
  }

  const auto request = offlineAckJob.classify(requestedEventId);
  if (request == dental::offline::AcknowledgementJob::Request::kInProgress) {
    String response = "{\"acknowledged\":false,\"processing\":true,\"eventId\":";
    appendJsonString(response, requestedEventId);
    response += '}';
    httpServer.send(202, "application/json", response);
    return;
  }
  if (request == dental::offline::AcknowledgementJob::Request::kBusy) {
    sendAcknowledgementError(409, "offline_ack_in_progress");
    return;
  }
  if (request == dental::offline::AcknowledgementJob::Request::kAlreadyDone) {
    String response;
    dental::offline::appendOfflineAcknowledgementJson(
        response, requestedEventId,
        offlinePendingJournal.metadata().pendingCount, true);
    httpServer.send(200, "application/json", response);
    return;
  }
  if (workflowState != WorkflowState::kIdle ||
      registrationBarcodeCapture.active() || storageRequestActive ||
      rtcBridgeRequest != RtcBridgeRequest::kNone) {
    sendAcknowledgementError(409, "controller_busy");
    return;
  }

  // Preserve the journal's durable replay receipt across ESP32 reboot. The
  // in-RAM worker state only covers the current boot.
  const auto& journalMetadata = offlinePendingJournal.metadata();
  char lastAcknowledgedEventId[dental::offline::kOfflineEventIdCapacity] = {};
  if (journalMetadata.available && !offlinePendingJournal.uncertain() &&
      journalMetadata.acknowledgedSequence > 0ULL &&
      dental::offline::formatOfflineEventId(
          offlineDeviceIdentifier, journalMetadata.acknowledgedSequence,
          lastAcknowledgedEventId) &&
      strcmp(lastAcknowledgedEventId, requestedEventId) == 0) {
    String response;
    dental::offline::appendOfflineAcknowledgementJson(
        response, requestedEventId, journalMetadata.pendingCount, true);
    httpServer.send(200, "application/json", response);
    return;
  }

  // Validation is read-only and still performed against the authoritative
  // journal. Scheduling alone is NEVER reported as durable acknowledgement.
  const uint32_t preflightStartedMs = millis();
  const dental::offline::JournalPeekResult peek =
      offlinePendingJournal.peekOldest(offlinePendingReadBuffer);
  offlineAckPreflightMs = millis() - preflightStartedMs;
  if (peek == dental::offline::JournalPeekResult::kEmpty) {
    sendAcknowledgementError(404, "no_pending_event");
    return;
  }
  if (peek == dental::offline::JournalPeekResult::kJournalUnavailable) {
    sendAcknowledgementError(503, "pending_journal_unavailable");
    return;
  }
  if (peek != dental::offline::JournalPeekResult::kFound) {
    sendAcknowledgementError(500, "pending_journal_invalid");
    return;
  }
  if (strcmp(offlinePendingReadBuffer.eventId, requestedEventId) != 0) {
    sendAcknowledgementError(409, "event_id_mismatch");
    return;
  }
  offlineAckFirstStorageFailure.store(StorageRequestFailure::kNone);
  offlineAckFirstFatFsOperation.store(OfflineAckFatFsOperation::kNone);
  offlineAckFirstFatFsResult.store(0U);
  if (!offlineAckJob.start(requestedEventId,
                           offlinePendingJournal.metadata().pendingCount,
                           millis())) {
    sendAcknowledgementError(409, "offline_ack_in_progress");
    return;
  }
  Serial.printf("Offline ACK queued: eventId=%s pendingBefore=%lu preflightMs=%lu\n",
                offlineAckJob.eventId(),
                static_cast<unsigned long>(offlineAckJob.pendingCountBefore()),
                static_cast<unsigned long>(offlineAckPreflightMs));
  const BaseType_t created = xTaskCreatePinnedToCore(
      retireOfflineHeadTask, "offline-journal-ack", 12288U, nullptr, 0,
      nullptr, xPortGetCoreID());
  if (created != pdPASS) {
    offlineAckJob.cancelStart(millis());
    sendAcknowledgementError(503, "offline_ack_worker_unavailable");
    return;
  }
  String response = "{\"acknowledged\":false,\"processing\":true,\"eventId\":";
  appendJsonString(response, requestedEventId);
  response += '}';
  httpServer.send(202, "application/json", response);
}

void sendResultError(int statusCode, const char* errorCode) {
  String response = "{\"accepted\":false,\"error\":";
  appendJsonString(response, errorCode);
  response += '}';
  httpServer.send(statusCode, "application/json", response);
}

void handleEventResultRequest() {
  if (offlineAckJob.running()) {
    sendResultError(409, "offline_ack_in_progress");
    return;
  }
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
    queueStockFeedback(requestedResult.stockStatus);
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
    // Replaying an identical result may repair a lost advisory LED frame,
    // without replaying SQLite or re-pulsing transaction success.
    queueStockFeedback(requestedResult.stockStatus);
    Serial.print("Identical committed transaction result already applied: ");
    Serial.println(requestedResult.eventId);
  }

  String response = "{\"accepted\":true,\"eventId\":";
  appendJsonString(response, requestedResult.eventId);
  response += '}';
  httpServer.send(200, "application/json", response);
}

void handleEventAcknowledgementRequest() {
  if (offlineAckJob.running()) {
    sendAcknowledgementError(409, "offline_ack_in_progress");
    return;
  }
  char requestedEventId[dental::events::kEventIdCapacity] = {};
  bool unknownBarcode = false;
  const String body = httpServer.arg("plain");
  if (!dental::events::parseAcknowledgementBody(
          body.c_str(), body.length(), requestedEventId, &unknownBarcode)) {
    sendAcknowledgementError(400, "invalid_request");
    return;
  }

  const PendingTransactionEvent* head = pendingEvents.oldest();
  const bool dismissedWithoutResult = head != nullptr &&
      strcmp(head->eventId, requestedEventId) == 0 &&
      pendingEvents.oldestAppliedResult() == nullptr;
  const AcknowledgementResult result = pendingEvents.acknowledge(requestedEventId);
  if (result == AcknowledgementResult::kEmpty) {
    sendAcknowledgementError(404, "no_pending_event");
    return;
  }
  if (result == AcknowledgementResult::kMismatch) {
    sendAcknowledgementError(409, "event_id_mismatch");
    return;
  }
  if (result == AcknowledgementResult::kAcknowledged &&
      dismissedWithoutResult)
    queueLcdFeedback(unknownBarcode ? dental_link::kUnknownBarcodeFeedback
                                   : dental_link::kScanDismissedFeedback);

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
  httpServer.on("/offline/cache/progress", HTTP_GET,
                handleOfflineCacheProgressRequest);
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

bool wiFiNetworkAvailable() {
  return accessPointReady || WiFi.status() == WL_CONNECTED;
}

void startHttpServerIfNeeded() {
  if (httpServerRunning) return;
  httpServer.begin();
  httpServerRunning = true;
  Serial.println("HTTP server started on port 80");
}

void handleWiFiConnected() {
  wiFiConnectionState = WiFiConnectionState::kConnected;
  Serial.println("WiFi connected");
  Serial.print("STA IP address: ");
  Serial.println(WiFi.localIP());

  startHttpServerIfNeeded();
}

void initializeWiFi() {
  configureHttpRoutes();
  httpServer.collectHeaders(kCollectedHttpHeaders,
                            sizeof(kCollectedHttpHeaders) /
                                sizeof(kCollectedHttpHeaders[0]));

  const bool stationConfigured = wiFiCredentialsAreConfigured();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  const bool modeReady = WiFi.mode(stationConfigured ? WIFI_AP_STA : WIFI_AP);
  const IPAddress apIp(192, 168, 4, 1);
  const IPAddress apGateway(192, 168, 4, 1);
  const IPAddress apSubnet(255, 255, 255, 0);
  accessPointReady = modeReady &&
      WiFi.softAPConfig(apIp, apGateway, apSubnet) &&
      WiFi.softAP(kAccessPointSsid, kAccessPointPassword);
  if (accessPointReady) {
    Serial.println("WiFi access point: READY");
    Serial.print("WiFi AP SSID: "); Serial.println(kAccessPointSsid);
    Serial.print("WiFi AP IP: "); Serial.println(WiFi.softAPIP());
    startHttpServerIfNeeded();
  } else {
    Serial.println("WiFi access point: FAILED");
  }
  desktopPresence.setNetworkConnected(wiFiNetworkAvailable());

  if (!stationConfigured) {
    wiFiConnectionState = WiFiConnectionState::kDisabled;
    Serial.println(
        "WiFi credentials are not configured; hardware workflow remains available");
    return;
  }

  beginWiFiConnectionAttempt(millis());
}

void serviceWiFi(uint32_t nowMs) {
  const int observedWiFiStatus = WiFi.status();
  const bool wiFiConnected = observedWiFiStatus == WL_CONNECTED;
#if ENABLE_HTTP_SERVICE_TIMING
  static int lastObservedWiFiStatus = -1;
  if (observedWiFiStatus != lastObservedWiFiStatus) {
    Serial.printf("HTTP WiFi state: nowMs=%lu status=%d\n",
                  static_cast<unsigned long>(millis()), observedWiFiStatus);
    lastObservedWiFiStatus = observedWiFiStatus;
  }
#endif
  const bool networkAvailable = accessPointReady || wiFiConnected;
  desktopPresence.setNetworkConnected(networkAvailable);
  desktopPresence.service(nowMs);

  if (wiFiConnected) {
    if (wiFiConnectionState != WiFiConnectionState::kConnected) {
      handleWiFiConnected();
    }
  }
  if (networkAvailable) {
    startHttpServerIfNeeded();
  } else if (httpServerRunning) {
    httpServer.stop();
    httpServerRunning = false;
  }
  if (httpServerRunning) {
#if ENABLE_HTTP_SERVICE_TIMING
    noteHttpServiceOpportunity(millis());
    const uint32_t httpStartedMs = millis();
#endif
    httpServer.handleClient();
#if ENABLE_HTTP_SERVICE_TIMING
    noteSlowLoopOperation("httpServer.handleClient",
                          millis() - httpStartedMs);
    if (millis() - httpStartedMs >= kSlowHttpServiceMs) {
      Serial.printf("HTTP handleClient slow: durationMs=%lu\n",
                    static_cast<unsigned long>(millis() - httpStartedMs));
    }
#endif
  }
  if (wiFiConnected || wiFiConnectionState == WiFiConnectionState::kDisabled)
    return;

  if (wiFiConnectionState == WiFiConnectionState::kConnected) {
#if ENABLE_HTTP_SERVICE_TIMING
    previousHttpServiceMs = 0UL;
#endif
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

  queueLcdFeedback(strcmp(activeCommittedResultFeedback.mode, "restock") == 0
      ? dental_link::kRestockCommittedFeedback
      : dental_link::kCheckoutCommittedFeedback);

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
  barcodeBuffer = "";
  barcodeIsInvalid = false;
  lastBarcodeByteMs = 0UL;
}

void drainScannerInput() {
  if (!dental::hardware::kAtmegaLinkEnabled) return;
  // Never discard complete controller frames here: a BTN arriving during a
  // workflow transition still needs an explicit OK/BUSY/REJECT response.
  // The ATmega will not transmit its barcode until it receives OK. Preserve
  // any frame already in progress so that it can receive a protocol reply.
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
  if (workflowState == WorkflowState::kWaitingForBarcode)
    queueLcdFeedback(dental_link::kScanErrorFeedback);
  if (offlineLcdProcessing) {
    dental_link::display::fit("TRANSACTION ERROR", offlineDisplayRows.text[0]);
    dental_link::display::fit(lcdReason, offlineDisplayRows.text[1]);
    dental_link::display::fit("NOT SAVED", offlineDisplayRows.text[2]);
    dental_link::display::fit(barcodeBuffer.c_str(), offlineDisplayRows.text[3]);
    queueOfflineDisplay(false, activeTransaction == &kRestockTransaction); offlineLcdProcessing = false;
  }
  Serial.print("ERROR: ");
  Serial.println(serialReason);
  showLcdScreen("ERROR", lcdReason, "Try again", "Returning idle");
  setErrorIndicator();
  feedbackIndicatorIsOn = true;
  workflowState = WorkflowState::kShowingFeedback;
  workflowStateStartedMs = millis();
  resetScannerWorkflowBuffers();
  // Feedback is not transaction ownership. A terminal failure must release
  // the frozen route/cache and any deferred barcode immediately.
  activeTransaction = nullptr;
  transactionRouteCaptured = false;
  activeTransactionRoute = dental::offline::TransactionRoute::kOnline;
  capturedCacheGeneration[0] = '\0';
  capturedCacheItemCount = 0U;
  deferredControllerScan = dental_link::Frame::kNone;
  deferredControllerBarcode[0] = '\0';
}

void beginOnlineQueuedFeedback(const char* timestamp, const String& barcode) {
  Serial.print(activeTransaction->action);
  Serial.println(" ONLINE SCAN QUEUED - awaiting desktop confirmation");
  Serial.print("Timestamp: ");
  Serial.println(timestamp);
  Serial.print("Barcode: ");
  Serial.println(barcode);
  Serial.println(activeTransaction->serialQuantity);

  showLcdScreen(activeTransaction->modeTitle, barcode,
                "Pending desktop", "No stock changed");
  // D1 and the success screen belong to the later committed SQLite result.
  feedbackIndicatorIsOn = false;
  workflowState = WorkflowState::kShowingFeedback;
  workflowStateStartedMs = millis();
  resetScannerWorkflowBuffers();
}

void beginOfflineSuccessFeedback(
    const dental::offline::OfflineJournalRecord& record) {
  queueLcdFeedback(activeTransaction == &kRestockTransaction
      ? dental_link::kRestockOfflineFeedback
      : dental_link::kCheckoutOfflineFeedback);
  dental_link::display::saved(activeTransaction == &kRestockTransaction,
      offlineProductBuffer.name, record.barcode, record.resultingStock,
      dental::cache::stockStatusName(record.resultingStatus), offlineDisplayRows);
  queueOfflineDisplay(false, activeTransaction == &kRestockTransaction); offlineLcdProcessing = false;
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
  queueStockFeedback(toEventStockStatus(record.resultingStatus));
  setSuccessIndicator();
  feedbackIndicatorIsOn = true;
  workflowState = WorkflowState::kShowingFeedback;
  workflowStateStartedMs = millis();
  resetScannerWorkflowBuffers();
}

const char* fatFsResultName(FRESULT result) {
  switch (result) {
    case FR_OK: return "FR_OK";
    case FR_DISK_ERR: return "FR_DISK_ERR";
    case FR_INT_ERR: return "FR_INT_ERR";
    case FR_NOT_READY: return "FR_NOT_READY";
    case FR_NO_FILE: return "FR_NO_FILE";
    case FR_NO_PATH: return "FR_NO_PATH";
    case FR_INVALID_NAME: return "FR_INVALID_NAME";
    case FR_DENIED: return "FR_DENIED";
    case FR_EXIST: return "FR_EXIST";
    case FR_INVALID_OBJECT: return "FR_INVALID_OBJECT";
    case FR_WRITE_PROTECTED: return "FR_WRITE_PROTECTED";
    case FR_INVALID_DRIVE: return "FR_INVALID_DRIVE";
    case FR_NOT_ENABLED: return "FR_NOT_ENABLED";
    case FR_NO_FILESYSTEM: return "FR_NO_FILESYSTEM";
    case FR_MKFS_ABORTED: return "FR_MKFS_ABORTED";
    case FR_TIMEOUT: return "FR_TIMEOUT";
    case FR_LOCKED: return "FR_LOCKED";
    case FR_NOT_ENOUGH_CORE: return "FR_NOT_ENOUGH_CORE";
    case FR_TOO_MANY_OPEN_FILES: return "FR_TOO_MANY_OPEN_FILES";
    case FR_INVALID_PARAMETER: return "FR_INVALID_PARAMETER";
    default: return "FR_UNKNOWN";
  }
}

bool initializeMicroSd() {
  for (uint8_t attempt = 1U; attempt <= kMicroSdMountAttempts; ++attempt) {
    Serial.print("MicroSD mount attempt ");
    Serial.print(attempt);
    Serial.print('/');
    Serial.print(kMicroSdMountAttempts);
    Serial.print(" at ");
    Serial.print(kMicroSdSpiFrequencyHz);
    Serial.println(" Hz");

    // Establish readiness through the same disk adapter used by ChanFatFS.
    // The previous direct call proved the card but left adapter-local
    // remoteStatus at STA_NOINIT, causing f_mount() to return FR_NOT_READY.
    const DSTATUS rawStatus = disk_initialize(0U);
    const bool rawReady = (rawStatus & STA_NOINIT) == 0U;
    Serial.print("Raw SD/SPI initialization: ");
    Serial.println(rawReady ? "SUCCESS" : "FAILED");
    if (!rawReady) {
      Serial.println("RAW SD/SPI INITIALIZATION FAILURE");
      recoverStorageBridge();
      if (kVerboseDiagnostics) printStorageDiagnostic();
      if (attempt < kMicroSdMountAttempts) delay(kMicroSdRetryDelayMs);
      continue;
    }

    uint8_t sectorZero[dental_link::storage::kSectorBytes] = {};
    const bool sectorZeroReady =
        disk_read(0U, sectorZero, 0UL, 1U) == RES_OK;
    Serial.print("REMOTE SECTOR 0 READ: ");
    Serial.println(sectorZeroReady ? "SUCCESS" : "FAILED");
    if (sectorZeroReady) {
      if (kVerboseDiagnostics) {
        Serial.print("REMOTE SECTOR 0 SIGNATURE: byte510=0x");
        printHexByte(sectorZero[510U]);
        Serial.print(" byte511=0x"); printHexByte(sectorZero[511U]);
        Serial.print(" MBR-signature=");
        Serial.println(sectorZero[510U] == 0x55U && sectorZero[511U] == 0xAAU
                           ? "55AA" : "OTHER");
      }
    }
    if (!sectorZeroReady) {
      recoverStorageBridge();
      if (kVerboseDiagnostics) printStorageDiagnostic();
      Serial.println("MicroSD mount skipped: remote sector 0 read failed");
      if (attempt < kMicroSdMountAttempts) delay(kMicroSdRetryDelayMs);
      continue;
    }
    if (kVerboseDiagnostics) printStorageDiagnostic();

    const FRESULT mountResult = f_mount(&remoteFileSystem, "", 1U);
    Serial.print("ChanFatFS mount result: ");
    Serial.print(fatFsResultName(mountResult));
    Serial.print(" (");
    Serial.print(static_cast<unsigned>(mountResult));
    Serial.println(')');
    if (mountResult != FR_OK) recoverStorageBridge();
    if (kVerboseDiagnostics) printStorageDiagnostic();
    if (mountResult == FR_OK) {
      Serial.println("RAW CARD OK / FAT FILESYSTEM MOUNT SUCCESS");
      Serial.print("ChanFatFS filesystem type: ");
      switch (remoteFileSystem.fs_type) {
        case FS_FAT12: Serial.println("FAT12"); break;
        case FS_FAT16: Serial.println("FAT16"); break;
        case FS_FAT32: Serial.println("FAT32"); break;
#if FF_FS_EXFAT
        case FS_EXFAT: Serial.println("exFAT"); break;
#endif
        default: Serial.println("UNKNOWN"); break;
      }
      Serial.println("MicroSD initialization: SUCCESS - ATmega owned");
      return true;
    }

    Serial.println("RAW CARD OK / FAT FILESYSTEM MOUNT FAILURE");
    Serial.println("MicroSD mount attempt FAILED");
    if (attempt < kMicroSdMountAttempts) {
      delay(kMicroSdRetryDelayMs);
    }
  }

  Serial.println("MicroSD initialization: FAILED after retries");
  return false;
}

bool readRtcTimestamp(char* destination, size_t destinationSize) {
  // Never gate a transaction solely on ESP32's volatile cached status. Ask the
  // ATmega/DS3231 directly so a valid retained clock recovers after either
  // controller/link restart without requiring Electron to reconnect.
  if (!destination || destinationSize < 20U ||
      !requestRtcBridgeAndWait(dental_link::kRtcTimeRequest,
                               RtcBridgeRequest::kTime)) return false;
  const size_t length = strlen(rtcBridgeTimestamp);
  if (length != 19U || length + 1U > destinationSize) return false;
  memcpy(destination, rtcBridgeTimestamp, length + 1U);
  return true;
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
  const uint32_t cacheStarted = millis();
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
  const uint32_t cacheMs = millis() - cacheStarted;
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
  const uint32_t overlayStarted = millis();
  const dental::offline::OverlayResult overlayResult =
      offlinePendingJournal.deriveCurrentStock(
          product, capturedCacheGeneration, currentStock);
  const uint32_t overlayMs = millis() - overlayStarted;
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
    Serial.print("Pending journal state: "); Serial.println(offlinePendingJournal.stateName());
    Serial.print("Pending journal reason: "); Serial.println(offlinePendingJournal.reasonName());
    beginErrorFeedback("Pending offline journal unavailable",
                       "Journal unavailable");
    return;
  }

  const dental::offline::OfflineAction action =
      activeTransaction == &kRestockTransaction
          ? dental::offline::OfflineAction::kRestock
          : dental::offline::OfflineAction::kCheckout;
  const uint32_t calculationStarted = millis();
  uint64_t resultingStock = currentStock;
  dental::cache::StockStatus resultingStatus =
      dental::offline::deriveStockStatus(currentStock,
                                         product.lowStockThreshold);
  const dental::offline::OfflineStockResult stockResult =
      dental::offline::calculateOfflineStock(
          action, currentStock, product.lowStockThreshold, resultingStock,
          resultingStatus);
  const uint32_t calculationMs = millis() - calculationStarted;
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
  const uint32_t appendStarted = millis();
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

  const uint32_t total = millis() - offlineBarcodeReceivedMs;
  Serial.printf("OFFLINE TX TIMING: rtc=%lu cacheLookup=%lu overlay=%lu calculation=%lu journalAppend=%lu readback=%lu sectorReads=%lu sectorWrites=%lu fences=%lu retries=%lu waitMs=%lu total=%lu ms\n",
      (unsigned long)offlineRtcMs, (unsigned long)cacheMs, (unsigned long)overlayMs,
      (unsigned long)calculationMs, (unsigned long)(millis() - appendStarted),
      (unsigned long)offlineReadbackMs, (unsigned long)offlineSectorReads, (unsigned long)offlineSectorWrites,
      (unsigned long)offlineFences, (unsigned long)offlineRetryRequests,
      (unsigned long)offlineWaitMs, (unsigned long)total);
  Serial.printf("OFFLINE TX TRANSPORT: readMs=%lu writeMs=%lu syncMs=%lu fenceMs=%lu rawRetries=not_reported\n",
      (unsigned long)offlineSectorReadMs, (unsigned long)offlineSectorWriteMs,
      (unsigned long)offlineSyncMs, (unsigned long)offlineFenceMs);
  for (uint8_t i = 0U; i < 10U; ++i) if (offlineFatFsTiming[i].calls)
    Serial.printf("OFFLINE TX I/O: operation=%s calls=%lu elapsedMs=%lu\n",
        offlineAckFatFsOperationName(static_cast<OfflineAckFatFsOperation>(i)),
        (unsigned long)offlineFatFsTiming[i].calls, (unsigned long)offlineFatFsTiming[i].totalMs);
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
  const bool offline = transactionRouteCaptured &&
      activeTransactionRoute == dental::offline::TransactionRoute::kOffline;
  if (offline) {
    dental_link::display::processing(activeTransaction == &kRestockTransaction,
        barcodeBuffer.c_str(), offlineDisplayRows);
    queueOfflineDisplay(true, activeTransaction == &kRestockTransaction); offlineLcdProcessing = true;
    // Queue advisory output before RTC/FatFs. Never wait for an LCD ACK.
    serviceAtmegaLink();
  }
  struct OfflineTimingScope {
    explicit OfflineTimingScope(bool active) {
      offlineTimingActive = active;
      if (active) {
        offlineSectorReads = offlineSectorWrites = offlineFences = 0;
        offlineReadbackMs = offlineRetryRequests = 0;
        offlineWaitMs = millis() - offlineBarcodeReceivedMs; // deferred foreground admission/initial advisory TX
        offlineSectorReadMs = offlineSectorWriteMs = offlineSyncMs = offlineFenceMs = 0;
        recordOfflineReadbackTimingActive = false;
        for (auto& timing : offlineFatFsTiming) timing = {};
        remoteDiskBeginForegroundCache();
      }
    }
    ~OfflineTimingScope() { if (offlineTimingActive) remoteDiskEndForegroundCache(); offlineTimingActive = false; }
  } timingScope(offline);
  const uint32_t rtcStarted = millis();
  if (!readRtcTimestamp(timestamp, sizeof(timestamp))) {
    beginErrorFeedback(activeTransaction->rtcReadFailure,
                       "RTC read failed");
    return;
  }
  offlineRtcMs = millis() - rtcStarted;

  if (transactionRouteCaptured &&
      activeTransactionRoute == dental::offline::TransactionRoute::kOffline) {
    completeOfflineBarcode(timestamp);
    return;
  }

  // Online delivery is RAM FIFO -> Electron -> authoritative SQLite. The
  // historical integration-test CSV must never delay or gate this path.
  if (!onlineDeliveryAvailable()) {
    beginErrorFeedback("Online delivery queue is full; event was not saved",
                       "Controller busy");
    return;
  }

  if (!enqueuePendingEvent(*activeTransaction, timestamp, barcodeBuffer)) {
    beginErrorFeedback("Online event delivery failed",
                       "Delivery failed");
    return;
  }
  beginOnlineQueuedFeedback(timestamp, barcodeBuffer);
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
  Serial.println("Waiting for barcode scan");
  barcodeBuffer = "";
  barcodeIsInvalid = false;
  lastBarcodeByteMs = 0UL;
  workflowState = WorkflowState::kWaitingForBarcode;
  workflowStateStartedMs = nowMs;
}


void serviceScanner(uint32_t nowMs) {
  if (registrationBarcodeCapture.active()) {
    registrationBarcodeCapture.service(nowMs);
    reportRegistrationCaptureOutcome();
  }
}

bool lastModeStorageUnavailable = false;
void beginTransactionWorkflow(const TransactionProfile& transaction) {
  lastModeStorageUnavailable = false;
  lastModeRejectReason = "NONE";
  activeTransaction = &transaction;
  const uint32_t acceptedAtMs = millis();
  const bool networkConnected = wiFiNetworkAvailable();
  desktopPresence.setNetworkConnected(networkConnected);
  desktopPresence.service(acceptedAtMs);
  activeTransactionRoute = dental::offline::selectTransactionRoute(
      useDeferredRoute ? deferredCriticalOnline : desktopPresence.desktopAvailable());
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
  if (!dental::hardware::kAtmegaLinkEnabled) {
    lastModeRejectReason = "CONTROLLER_LINK_UNAVAILABLE";
    beginErrorFeedback("ATmega scanner link unavailable",
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

  if (!rtcAvailable) {
    if (rtcStatus.state == dental::rtc_recovery::State::kNeedsSync) {
      lastModeRejectReason = "RTC_UNTRUSTED";
      beginErrorFeedback("RTC time is untrusted; event was not started",
                         "RTC needs sync");
    } else {
      lastModeRejectReason = "RTC_UNAVAILABLE";
      beginErrorFeedback("RTC is unavailable; event was not started",
                         "RTC unavailable");
    }
    return;
  }
  if (!dental::storage_policy::modeMayStart(
          activeTransactionRoute == dental::offline::TransactionRoute::kOffline,
          microSdAvailable)) {
    lastModeStorageUnavailable = true;
    lastModeRejectReason = "SD_UNAVAILABLE";
    beginErrorFeedback("MicroSD is unavailable; event was not started",
                       "SD unavailable");
    return;
  }
  if (activeTransactionRoute ==
          dental::offline::TransactionRoute::kOffline &&
      !offlineOperationIsReady()) {
    if (!offlineInventoryCache.metadata().available) {
      lastModeRejectReason = "CACHE_UNAVAILABLE";
      beginErrorFeedback("Offline inventory cache is unavailable",
                         "Cache unavailable");
    } else if (offlinePendingJournal.metadata().available &&
               offlinePendingJournal.metadata().storedCount >=
                   dental::offline::kMaximumPendingRecords) {
      lastModeRejectReason = "JOURNAL_FULL";
      beginErrorFeedback("Pending offline journal is full", "Journal full");
    } else if (!offlinePendingJournal.metadata().available ||
               offlinePendingJournal.uncertain()) {
      lastModeRejectReason = "JOURNAL_UNAVAILABLE";
      if (offlinePendingJournal.uncertain() &&
          !offlinePendingJournal.temporarilyUnavailable())
        lastModeRejectReason = "JOURNAL_CORRUPT";
      beginErrorFeedback("Pending offline journal is unavailable",
                         "Journal unavailable");
    } else {
      lastModeRejectReason = "CACHE_GENERATION_MISMATCH";
      beginErrorFeedback("Offline cache and journal are incompatible",
                         "Cache mismatch");
    }
    return;
  }
  if (activeTransactionRoute == dental::offline::TransactionRoute::kOnline &&
      !onlineDeliveryAvailable()) {
    lastModeRejectReason = "EVENT_QUEUE_FULL";
    beginErrorFeedback("Online event delivery queue is unavailable",
                       "Controller busy");
    return;
  }

  resetScannerWorkflowBuffers();
  beginBarcodeWait(millis());
}


void serviceWorkflowTimeouts(uint32_t nowMs) {
  if (workflowState == WorkflowState::kShowingCommittedResult) {
    const uint32_t elapsedMs = nowMs - workflowStateStartedMs;
    if (committedResultIndicatorIsOn &&
        elapsedMs >= kIndicatorFeedbackMs) {
      setTransactionIndicatorOff();
      committedResultIndicatorIsOn = false;
    }

    if (elapsedMs >= kCommittedResultFeedbackMs) {
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

    if (elapsedMs >= kWorkflowFeedbackMs) {
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

dental::controller_link::ScanRoute handleControllerOperation(
    dental_link::Frame frame, const char* barcode, uint32_t nowMs) {
  // Preserve barcode storage while workflow servicing may consume more UART.
  char text[dental_link::kMaximumBarcodeLength + 1U] = {};
  if (barcode != nullptr) snprintf(text, sizeof(text), "%s", barcode);
  serviceWorkflowTimeouts(nowMs);
  struct ExistingScannerWorkflow {
    bool readyForTransaction() const { return workflowState == WorkflowState::kIdle; }
    bool beginTransactionMode(dental_link::Frame operation, uint32_t) {
      const TransactionProfile& profile = operation == dental_link::Frame::kRestock ?
          kRestockTransaction : kCheckoutTransaction;
      Serial.print(profile.action);
      Serial.println(" button pressed");
      beginTransactionWorkflow(profile);
      return workflowState == WorkflowState::kWaitingForBarcode &&
             activeTransaction == &profile;
    }
    bool modeStorageUnavailable() const { return lastModeStorageUnavailable; }
    bool readyForBarcode(dental_link::Frame operation) const {
      const TransactionProfile& profile = operation == dental_link::Frame::kRestock ?
          kRestockTransaction : kCheckoutTransaction;
      return workflowState == WorkflowState::kWaitingForBarcode &&
             activeTransaction == &profile;
    }
    void handleTransactionBarcode(dental_link::Frame operation, const char* value, uint32_t now) {
      const TransactionProfile& profile = operation == dental_link::Frame::kRestock ?
          kRestockTransaction : kCheckoutTransaction;
      // Compatibility for a previously deployed combined RESTOCK:/CHECKOUT:
      // frame. New firmware reaches this point only after BTN mode + SCAN.
      if (!readyForBarcode(operation) && !beginTransactionMode(operation, now))
        return;
      // Reuse the original validation and completeBarcode() business path.
      for (const char* byte = value; *byte; ++byte)
        processBarcodeByte(static_cast<uint8_t>(*byte), now);
      processBarcodeByte('\n', now);
    }
  } workflow;
  const auto route = controllerOperationRouter.route(
      frame, barcode == nullptr ? nullptr : text, nowMs,
      registrationBarcodeCapture, workflow);
  reportRegistrationCaptureOutcome();
  return route;
}

void foregroundStorageCheckpoint() {
  // Never called from a FatFs disk callback: its API has fully returned.
  if (!storagePriority.preemptible() || storageRequestActive) return;
  serviceAtmegaLink();
  if (deferredCriticalMode != dental_link::Frame::kNone) {
    const auto mode = deferredCriticalMode;
    deferredCriticalMode = dental_link::Frame::kNone;
    useDeferredRoute = true;
    const auto result = handleControllerOperation(mode, nullptr, millis());
    useDeferredRoute = false;
    pendingModeReply = dental::controller_link::modeReply(result, mode);
  }
  if (!activeTransaction && deferredControllerScan == dental_link::Frame::kNone &&
      pendingEvents.size() == 0U) return;
  Serial.println("Cache publication: YIELD -> FOREGROUND (FatFs boundary)");
  storagePriority.pause();
  do {
    serviceAtmegaLink();
    if (deferredControllerScan != dental_link::Frame::kNone) {
      const auto scan = deferredControllerScan;
      deferredControllerScan = dental_link::Frame::kNone;
      handleControllerOperation(scan, deferredControllerBarcode, millis());
      deferredControllerBarcode[0] = '\0';
    }
    serviceScanner(millis());
    serviceWorkflowTimeouts(millis());
    serviceRtcBridge(millis());
    serviceWiFi(millis());
    delay(1UL);
  } while (activeTransaction || pendingEvents.size() != 0U ||
           deferredControllerScan != dental_link::Frame::kNone ||
           workflowState != WorkflowState::kIdle);
  storagePriority.resume();
  Serial.println("Cache publication: RESUME (foreground completed; interlock rechecked at commit)");
}

bool beginCacheReplacement() {
  foregroundStorageCheckpoint();
  const bool allowed = storagePriority.beginReplacement(
      activeTransaction != nullptr, offlinePendingJournal.blocksCacheReplacement());
  if (!allowed) Serial.println("Cache COMMIT deferred: pending_sync_interlock");
  return allowed;
}

}  // namespace

void markMicroSdUnavailable(dental::storage::RuntimeSdFailure operation,
                            uint32_t sector = 0U) {
  const bool wasReady = microSdAvailable;
  microSdAvailable = false;
  offlineCacheLookup.invalidate();
  if (wasReady) sdRecovery.unavailable(millis());
  if (!wasReady || !firstRuntimeSdFailure.capture(operation, sector)) return;
  Serial.print("MicroSD runtime state: READY -> UNAVAILABLE reason=");
  switch (operation) {
    case dental::storage::RuntimeSdFailure::kStatus:
      Serial.print("REMOTE_STATUS_FAILED operation=STATUS"); break;
    case dental::storage::RuntimeSdFailure::kRead:
      Serial.print("REMOTE_SECTOR_READ_FAILED operation=READ sector=");
      Serial.print(sector); break;
    case dental::storage::RuntimeSdFailure::kWrite:
      Serial.print("REMOTE_SECTOR_WRITE_FAILED operation=WRITE sector=");
      Serial.print(sector); break;
    case dental::storage::RuntimeSdFailure::kSync:
      Serial.print("REMOTE_SYNC_FAILED operation=SYNC"); break;
    case dental::storage::RuntimeSdFailure::kNone:
      return;
  }
  Serial.println(" disk=STA_NOINIT_ON_RETURN fatfs=NOT_YET_RETURNED");
}

bool atmegaSdInitialize() {
  const bool ready = remoteSdInitializeImpl();
  // SD:READY proves only the raw card. Mount and read-only cache/journal
  // validation must complete before publishing workflow storage as ready.
  if (!ready) markMicroSdUnavailable(dental::storage::RuntimeSdFailure::kStatus);
  return ready;
}
bool atmegaSdReadSector(uint32_t sector, uint8_t* destination) {
  if (offlineTimingActive) ++offlineSectorReads;
  const uint32_t started = millis();
  const bool ready = remoteSdReadSectorImpl(sector, destination);
  if (offlineTimingActive) offlineSectorReadMs += millis() - started;
  if (!ready) markMicroSdUnavailable(dental::storage::RuntimeSdFailure::kRead,
                                     sector);
  return ready;
}
bool atmegaSdWriteSector(uint32_t sector, const uint8_t* source) {
  if (offlineTimingActive) ++offlineSectorWrites;
  const uint32_t started = millis();
  const bool ready = remoteSdWriteSectorImpl(sector, source);
  if (offlineTimingActive) offlineSectorWriteMs += millis() - started;
  if (!ready) markMicroSdUnavailable(dental::storage::RuntimeSdFailure::kWrite,
                                     sector);
  return ready;
}
bool atmegaSdSync() {
  const uint32_t started = millis();
  const bool ready = remoteSdSyncImpl();
  if (offlineTimingActive) offlineSyncMs += millis() - started;
  if (!ready) markMicroSdUnavailable(dental::storage::RuntimeSdFailure::kSync);
  return ready;
}
void atmegaSdReportDiskRead(uint32_t sector, uint32_t count, uint8_t result) {
  if (!dental::storage_policy::emitSectorTrace(
          result == RES_OK, kVerboseDiagnostics)) return;
  Serial.print("ChanFatFS disk_read: sector="); Serial.print(sector);
  Serial.print(" count="); Serial.print(count);
  Serial.print(" DRESULT="); Serial.println(result);
}

void serviceMicroSdRecovery(uint32_t nowMs) {
  // Called only from the outer loop after all HTTP/FatFs handlers returned.
  // No recovery is initiated from disk_read, disk_write, or disk_ioctl.
  const bool safe = workflowState == WorkflowState::kIdle &&
      !cachePublicationJob.active() &&
      !registrationBarcodeCapture.active() &&
      !offlineInventoryCache.transferActive() &&
      !remoteStorage.reading() && !storageProbeActive &&
      dental::storage_policy::mayRecover(
          desktopPresence.desktopAvailable(), pendingEvents.size(),
          committedResultFeedbacks.size());
  if (!sdRecovery.due(nowMs, safe)) return;
  sdRecovery.begin();
  Serial.print("MicroSD runtime state: UNAVAILABLE -> RECOVERING attempt ");
  Serial.println(sdRecovery.attempts());

  bool ready = recoverStorageBridge();
  if (ready) {
    remoteDiskInvalidate();
    ready = (disk_initialize(0U) & STA_NOINIT) == 0U;
  }
  if (ready) {
    const FRESULT mounted = f_mount(&remoteFileSystem, "", 1U);
    ready = mounted == FR_OK;
    if (!ready) {
      Serial.print("MicroSD recovery mount: ");
      Serial.println(fatFsResultName(mounted));
    }
  }
  if (ready) {
    storageProbeActive = true;
    remoteStorage.clearIoFailure();
    const bool cacheValid = offlineInventoryCache.validateActiveReadOnly();
    if (cacheValid) offlineCacheLookup.find(offlineInventoryCache.metadata(), "~", offlineProductBuffer);
    const bool journalChecked = cacheValid;
    const bool journalValid = journalChecked &&
        offlinePendingJournal.validateActiveReadOnly(offlineDeviceIdentifier);
    // FULL/generation mismatch are admission states, not failed hardware.
    ready = cacheValid && journalValid;
    storageProbeActive = false;
    Serial.print("MicroSD recovery read-only validation: cache=");
    Serial.print(cacheValid ? "VALID" : "INVALID");
    Serial.print(" journal=");
    Serial.println(!journalChecked ? "NOT_CHECKED" :
                   journalValid ? "VALID" : offlinePendingJournal.stateName());
    if (!journalValid) {
      Serial.print("Pending journal reason: ");
      Serial.println(offlinePendingJournal.reasonName());
    }
  }
  if (ready) {
    microSdAvailable = true;
    firstRuntimeSdFailure.clear();
    sdRecovery.finish(millis(), true);
    Serial.println("MicroSD runtime state: RECOVERING -> READY");
  } else {
    microSdAvailable = false;
    remoteDiskInvalidate();
    sdRecovery.finish(millis(), false);
    Serial.print("MicroSD runtime state: RECOVERING -> UNAVAILABLE attempts=");
    Serial.println(sdRecovery.attempts());
  }
}

void setup() {
  Serial.begin(dental::firmware::kSerialBaud);
  Serial.println();
  Serial.println("Dental Inventory System");
  Serial.println("Final Dual-Mode Integrated Hardware Diagnostic");
  initializeEventSession();

  configureLedOutputs();
  Serial.println("LED initialization: SUCCESS - all indicators off");

  if (dental::hardware::kAtmegaLinkEnabled) {
    atmegaSerial.setRxBufferSize(kAtmegaUartRxBufferBytes);
    atmegaSerial.begin(dental_link::kBaud, SERIAL_8N1,
                      dental::hardware::kAtmegaLinkRxGpio,
                      dental::hardware::kAtmegaLinkTxGpio);
    atmegaSerial.onReceiveError(handleAtmegaUartError);
    Serial.print("ATmega link: UART1 ready / 9600 8N1 / RX buffer ");
    Serial.print(kAtmegaUartRxBufferBytes);
    Serial.println(" bytes");
  } else {
    Serial.println("ATmega link: DISABLED - confirm ESP32 RX/TX GPIO mapping");
  }

  Serial.println("LCD/RTC ownership: ATmega A4/A5 shared 100000 Hz I2C bus");
  if (requestRtcBridgeAndWait(dental_link::kRtcStatusRequest,
                              RtcBridgeRequest::kStatus)) {
    Serial.print("ATmega RTC state: ");
    Serial.println(dental::rtc_recovery::stateName(rtcStatus.state));
  } else {
    Serial.println("ATmega RTC state: unavailable - controller response timeout");
  }

  microSdAvailable = initializeMicroSd();
  if (microSdAvailable) firstRuntimeSdFailure.clear();
  else sdRecovery.unavailable(millis());
  if (!microSdAvailable) {
    Serial.println("MicroSD workflow storage: UNAVAILABLE");
  } else {
    Serial.println("MicroSD workflow storage: READY");
    if (offlineInventoryCache.loadAtBoot()) {
      offlineCacheLookup.find(offlineInventoryCache.metadata(), "~", offlineProductBuffer);
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
  // GM65 is physically ATmega-owned on A0/A1; direct ESP32 UART stays off.
  barcodeBuffer.reserve(kMaximumBarcodeLength);
  Serial.println(
      "GM65 direct ESP32 UART: DISABLED - scanner is ATmega-owned");

  if (rtcStatus.state ==
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
  initializeBleDiscovery();
  initializationComplete = true;
  Serial.println("System initialization: RESOLVED - button admission enabled");
}

void loop() {
  serviceDiscoveryIdentity();
  if (offlineAckJob.running()) {
    // The worker exclusively owns FatFs and the ATmega storage UART. Keep the
    // synchronous WebServer pumping status/heartbeat on this higher-priority
    // loop task; never enter a second filesystem/controller operation.
    TRACE_LOOP_SERVICE("serviceWiFi", serviceWiFi(millis()));
    delay(1UL);
    return;
  }
  // Each service gets a fresh timestamp. Controller or scanner services can
  // start a new timed state, so reusing an earlier sample would make unsigned
  // elapsed-time subtraction wrap and falsely expire that state immediately.
  TRACE_LOOP_SERVICE("serviceScanner", serviceScanner(millis()));
  TRACE_LOOP_SERVICE("serviceWorkflowTimeouts", serviceWorkflowTimeouts(millis()));
  TRACE_LOOP_SERVICE("serviceWiFi", serviceWiFi(millis()));
  TRACE_LOOP_SERVICE("serviceAtmegaLink", serviceAtmegaLink());
  if (deferredControllerScan != dental_link::Frame::kNone) {
    const auto frame = deferredControllerScan;
    deferredControllerScan = dental_link::Frame::kNone;
    handleControllerOperation(frame, deferredControllerBarcode, millis());
    deferredControllerBarcode[0] = '\0';
  }
  TRACE_LOOP_SERVICE("serviceRtcBridge", serviceRtcBridge(millis()));
  TRACE_LOOP_SERVICE("serviceCachePublication", serviceCachePublication());
  TRACE_LOOP_SERVICE("serviceMicroSdRecovery", serviceMicroSdRecovery(millis()));
  delay(1UL);
}
