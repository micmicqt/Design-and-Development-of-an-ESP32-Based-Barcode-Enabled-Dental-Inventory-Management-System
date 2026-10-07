#include "lcd_display.h"
#include "ping_client.h"
#include "../../firmware-common/include/offline_display_feedback.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <initializer_list>

struct Lcd {
  char rows[4][21] = {}; uint8_t row = 0;
  void service(uint32_t) {} bool available() const { return true; } bool busy() const { return false; }
  bool setCursor(uint32_t, uint8_t, uint8_t next) { row = next; return true; }
  bool write(uint32_t, const char* data, uint8_t length) { assert(length == 20); memcpy(rows[row], data, 20); return true; }
};
static void deliver(dental_atmega::lcd::WorkflowScreen& screen, uint32_t now, const char* payload) {
  dental_atmega::PingClient link;
  char frame[30]; snprintf(frame, sizeof(frame), "LCD:%s\n", payload);
  dental_link::Frame kind = dental_link::Frame::kNone;
  for (const char* p = frame; *p; ++p) kind = link.receive(now, *p);
  assert(kind == dental_link::Frame::kLcdDisplay);
  screen.displayFrame(now, link.payload());
}
static void render(dental_atmega::lcd::WorkflowScreen& screen, uint32_t now, Lcd& lcd) {
  dental_link::rtc::DateTime time = {};
  for (unsigned i = 0; i < 12; ++i) screen.service(now, dental_atmega::PhysicalState::kIdle,
      dental_link::rtc::State::kReady, time, lcd);
}
int main() {
  using namespace dental_link::display;
  Rows rows;
  for (bool restock : {true, false}) for (const char* name : {"Resin", "12345678901234567890", "Very long product name longer than LCD"})
    for (const char* status : {"HIGH", "LOW", "EMPTY"}) {
      saved(restock, name, "0000123456789012345678901234567890123456789012345678901234567890123",
          !strcmp(status, "EMPTY") ? 0U : 9007199254740991ULL, status, rows);
      for (const auto& row : rows.text) assert(strlen(row) <= 20U);
    }
  dental_atmega::lcd::WorkflowScreen screen(false); Lcd lcd;
  processing(true, "00001234", rows); deliver(screen, 1, "P:R");
  render(screen, 1, lcd); assert(!strncmp(lcd.rows[1], "PROCESSING...", 13)); // header, before storage/rows
  for (unsigned i = 0; i < 4; ++i) { char payload[23]; snprintf(payload, sizeof(payload), "%u:%s", i, rows.text[i]); deliver(screen, 1, payload); }
  render(screen, 60000, lcd); assert(!strncmp(lcd.rows[1], "PROCESSING...", 13));
  saved(false, "Composite Resin", "00001234", 10, "HIGH", rows); deliver(screen, 60001, "S:C");
  for (unsigned i = 0; i < 4; ++i) { char payload[23]; snprintf(payload, sizeof(payload), "%u:%s", i, rows.text[i]); deliver(screen, 60001, payload); }
  render(screen, 60002, lcd); assert(!strncmp(lcd.rows[0], "CHECKOUT SAVED", 14));
  assert(!strncmp(lcd.rows[2], "STOCK: 10 HIGH", 14));
  screen.feedback(60003, dental_link::Frame::kScanErrorFeedback); render(screen, 60003, lcd);
  assert(!strncmp(lcd.rows[1], "TRANSACTION ERROR", 17));
  render(screen, 64000, lcd); assert(strncmp(lcd.rows[1], "TRANSACTION ERROR", 17));
  deliver(screen, 64001, "P:R"); deliver(screen, 64001, "1:PROCESSING...");
  screen.displayFrame(64001, "4:BAD ROW"); screen.displayFrame(64001, "1:123456789012345678901");
  screen.displayFrame(64001, "1:BAD\x01");
  render(screen, 64002, lcd); assert(!strncmp(lcd.rows[1], "PROCESSING...", 13));
  deliver(screen, 65000, "S:R"); deliver(screen, 65001, "0:RESTOCK SAVED");
  render(screen, 68000, lcd); assert(strncmp(lcd.rows[0], "RESTOCK SAVED", 13)); // incomplete result never sticks forever
  char utf8[21]; fit("Cr\xC3\xA8me", utf8); assert(!strcmp(utf8, "Cr?me"));
  fit("123456789012345678901", utf8); assert(!strcmp(utf8, "1234567890123456789~"));
  // Maximum parser frame is exactly 26 chars; an oversized frame is discarded
  // through LF and must not poison the following PONG or BTN response.
  dental_atmega::PingClient parser;
  const char* sequence = "LCD:1:123456789012345678901\nPONG\nBTN:OK:CHECKOUT\n";
  dental_link::Frame last = dental_link::Frame::kNone;
  for (const char* p = sequence; *p; ++p) last = parser.receive(68001, *p);
  assert(last == dental_link::Frame::kCheckoutAccepted);
  puts("Offline LCD: 18 bounded layouts + processing hold/result/error transitions PASSED");
}
