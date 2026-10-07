// The runner extracts the real production network functions into this include.
// Only Arduino/WiFi/WebServer hardware calls are replaced with host fakes.
#include "desktop_presence_lease.h"
#include "offline_pending_journal.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>

struct IPAddress {
  uint8_t bytes[4];
  IPAddress(uint8_t a = 0, uint8_t b = 0, uint8_t c = 0, uint8_t d = 0)
      : bytes{a, b, c, d} {}
  bool operator==(const IPAddress& other) const {
    return memcmp(bytes, other.bytes, sizeof(bytes)) == 0;
  }
};
enum { WL_DISCONNECTED, WL_CONNECTED, WIFI_AP, WIFI_AP_STA };
struct FakeWiFi {
  int connection = WL_DISCONNECTED;
  int selectedMode = -1;
  bool modeResult = true, configResult = true, apResult = true;
  bool persistence = true, autoReconnect = true, apRunning = false;
  unsigned beginCalls = 0, disconnectCalls = 0, apCalls = 0;
  IPAddress ip, gateway, subnet;
  std::string ssid, password;
  void persistent(bool enabled) { persistence = enabled; }
  void setAutoReconnect(bool enabled) { autoReconnect = enabled; }
  bool mode(int value) { selectedMode = value; return modeResult; }
  bool softAPConfig(IPAddress a, IPAddress b, IPAddress c) {
    ip = a; gateway = b; subnet = c; return configResult;
  }
  bool softAP(const char* name, const char* pass) {
    ++apCalls; ssid = name; password = pass; apRunning = apResult;
    return apResult;
  }
  IPAddress softAPIP() { return ip; }
  IPAddress localIP() { return IPAddress(192, 168, 8, 100); }
  int status() { return connection; }
  void begin(const char*, const char*) { ++beginCalls; }
  void disconnect(bool radioOff, bool eraseCredentials) {
    assert(!radioOff && !eraseCredentials);
    ++disconnectCalls; connection = WL_DISCONNECTED;
  }
} WiFi;
struct FakeSerial {
  std::string output;
  void print(const char* value) { output += value; }
  void println(const char* value) { output += value; output += '\n'; }
  void println(const IPAddress&) {}
} Serial;
struct FakeServer {
  unsigned begins = 0, stops = 0, clients = 0, headers = 0;
  void begin() { ++begins; }
  void stop() { ++stops; }
  void handleClient() { ++clients; }
  void collectHeaders(const char* const*, size_t) { ++headers; }
} httpServer;
const char* kCollectedHttpHeaders[] = {"test-token-header"};
const char* WIFI_SSID = "test-router";
const char* WIFI_PASSWORD = "test-password";
#define DENTAL_AP_PASSWORD "synthetic-ap-password"
uint32_t clockMs = 0;
uint32_t millis() { return clockMs; }
unsigned routeConfigurations = 0;
void configureHttpRoutes() { ++routeConfigurations; }
#define ENABLE_HTTP_SERVICE_TIMING 0
#include "wifi_production.inc"

void reset(bool credentials = true) {
  WiFi = FakeWiFi{}; Serial = FakeSerial{}; httpServer = FakeServer{};
  WIFI_SSID = credentials ? "test-router" : "";
  WIFI_PASSWORD = "test-password";
  clockMs = 0; routeConfigurations = 0;
  accessPointReady = httpServerRunning = false;
  wiFiConnectionState = WiFiConnectionState::kDisabled;
  wiFiStateStartedMs = lastWiFiProgressMs = 0;
  desktopPresence.setNetworkConnected(false);
}
void tick(uint32_t time) { clockMs = time; serviceWiFi(time); }

void apOnlyServesHttpAndHeartbeats() {
  reset(false); initializeWiFi();
  assert(WiFi.selectedMode == WIFI_AP && accessPointReady);
  assert(WiFi.ssid == "Design" && WiFi.password == "synthetic-ap-password");
  assert(WiFi.ip == IPAddress(192,168,4,1) && WiFi.gateway == WiFi.ip);
  assert(WiFi.subnet == IPAddress(255,255,255,0));
  assert(!WiFi.persistence && !WiFi.autoReconnect && WiFi.beginCalls == 0);
  assert(routeConfigurations == 1 && httpServer.headers == 1);
  assert(httpServer.begins == 1 && wiFiNetworkAvailable());
  assert(Serial.output.find("WiFi access point: READY") != std::string::npos);
  assert(!desktopPresence.desktopAvailable()); // An AP alone is not a desktop.
  tick(1); desktopPresence.recordHeartbeat(1); tick(2);
  assert(desktopPresence.desktopAvailable() && httpServer.clients == 2);
  tick(12001);
  assert(!desktopPresence.desktopAvailable() && httpServerRunning);
}
void stationConnectDisconnectAndReconnectKeepAp() {
  reset(); initializeWiFi();
  assert(WiFi.selectedMode == WIFI_AP_STA && WiFi.beginCalls == 1);
  WiFi.connection = WL_CONNECTED; tick(100);
  desktopPresence.recordHeartbeat(100);
  assert(httpServer.begins == 1 && WiFi.apRunning);
  WiFi.connection = WL_DISCONNECTED; tick(101);
  assert(httpServerRunning && httpServer.stops == 0);
  assert(desktopPresence.desktopAvailable());
  assert(wiFiConnectionState == WiFiConnectionState::kWaitingToRetry);
  tick(30100); assert(WiFi.beginCalls == 1);
  tick(30101); assert(WiFi.beginCalls == 2 && WiFi.apRunning);
  desktopPresence.recordHeartbeat(30101);
  WiFi.connection = WL_CONNECTED; tick(30102);
  assert(desktopPresence.desktopAvailable() && httpServer.begins == 1);
  assert(WiFi.apCalls == 1);
}
void routerTimeoutDoesNotStopApHttp() {
  reset(); initializeWiFi(); tick(15000);
  assert(WiFi.disconnectCalls == 1 && WiFi.apRunning);
  assert(httpServerRunning && httpServer.stops == 0 && httpServer.clients == 1);
  tick(45000);
  assert(WiFi.beginCalls == 2 && httpServer.clients == 2);
}
void apFailureAllowsStationAndTotalLossClearsLease() {
  reset(); WiFi.apResult = false; initializeWiFi();
  assert(!accessPointReady && !httpServerRunning && WiFi.beginCalls == 1);
  assert(Serial.output.find("WiFi access point: FAILED") != std::string::npos);
  WiFi.connection = WL_CONNECTED; tick(1);
  assert(httpServerRunning && httpServer.begins == 1);
  desktopPresence.recordHeartbeat(1);
  WiFi.connection = WL_DISCONNECTED; tick(2);
  assert(!httpServerRunning && httpServer.stops == 1);
  assert(!desktopPresence.desktopAvailable());
  WiFi.connection = WL_CONNECTED; tick(3);
  assert(httpServer.begins == 2 && !desktopPresence.desktopAvailable());
}
void setupFailuresDoNotAdvertiseReady() {
  for (bool failMode : {false, true}) {
    reset(false);
    if (failMode) WiFi.modeResult = false;
    else WiFi.configResult = false;
    initializeWiFi(); tick(1);
    assert(!accessPointReady && !httpServerRunning && WiFi.apCalls == 0);
    desktopPresence.recordHeartbeat(1);
    assert(!desktopPresence.desktopAvailable());
  }
}
void retryTimingWrapsSafely() {
  reset(); clockMs = 0xFFFFFF00U; initializeWiFi();
  tick(static_cast<uint32_t>(0xFFFFFF00U + 15000U));
  assert(WiFi.disconnectCalls == 1 && httpServerRunning);
  tick(static_cast<uint32_t>(0xFFFFFF00U + 45000U));
  assert(WiFi.beginCalls == 2 && httpServer.begins == 1);
}
void apPresenceControlsFrozenRoutesAcrossRepeatedTransitions() {
  reset(); initializeWiFi();
  assert(accessPointReady && WiFi.connection == WL_DISCONNECTED);
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    const uint32_t start = 1U + cycle * 26000U;
    tick(start);
    assert(dental::offline::selectTransactionRoute(
               desktopPresence.desktopAvailable()) ==
           dental::offline::TransactionRoute::kOffline);
    desktopPresence.recordHeartbeat(start);
    tick(start + 1U);
    const auto acceptedOnline = dental::offline::selectTransactionRoute(
        desktopPresence.desktopAvailable());
    assert(acceptedOnline == dental::offline::TransactionRoute::kOnline);
    // Losing STA does not revoke an AP-delivered desktop heartbeat.
    WiFi.connection = WL_CONNECTED;
    tick(start + 2U);
    WiFi.connection = WL_DISCONNECTED;
    tick(start + 3U);
    assert(desktopPresence.desktopAvailable());
    tick(start + 12001U);
    assert(!desktopPresence.desktopAvailable());
    assert(acceptedOnline == dental::offline::TransactionRoute::kOnline);
    const auto acceptedOffline = dental::offline::selectTransactionRoute(
        desktopPresence.desktopAvailable());
    desktopPresence.recordHeartbeat(start + 12002U);
    tick(start + 12003U);
    assert(acceptedOffline == dental::offline::TransactionRoute::kOffline);
  }
}
int main() {
  apOnlyServesHttpAndHeartbeats();
  stationConnectDisconnectAndReconnectKeepAp();
  routerTimeoutDoesNotStopApHttp();
  apFailureAllowsStationAndTotalLossClearsLease();
  setupFailuresDoNotAdvertiseReady();
  retryTimingWrapsSafely();
  apPresenceControlsFrozenRoutesAcrossRepeatedTransitions();
  puts("Production AP/STA HTTP lifecycle: 7 scenarios, 100 transition cycles PASSED");
}
