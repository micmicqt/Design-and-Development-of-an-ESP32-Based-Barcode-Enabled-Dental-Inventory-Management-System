#include <Arduino.h>

#include "hardware_config.h"
#include "protocol_config.h"

void setup() {
  // The only interface initialized in Phase 1 is the required development
  // Serial log. On ESP32-DevKitC this uses UART0/GPIO1 and GPIO3; do not attach
  // the unverified scanner connection while running this build.
  Serial.begin(dental::firmware::kSerialBaud);
  Serial.println();
  Serial.print(dental::firmware::kName);
  Serial.print(" firmware ");
  Serial.println(dental::firmware::kVersion);
  Serial.print("Protocol version: ");
  Serial.println(dental::protocol::kVersion);
  Serial.println("Hardware activation disabled pending verification.");
}

void loop() {
  // Yield to the Arduino runtime without initializing or touching peripherals.
  delay(1000UL);
}

