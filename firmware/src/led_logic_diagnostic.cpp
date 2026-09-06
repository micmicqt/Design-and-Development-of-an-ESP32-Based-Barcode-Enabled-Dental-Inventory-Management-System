#include <Arduino.h>

#include "hardware_config.h"

namespace {

struct LedState {
  char command;
  const char* label;
  bool transactionA;
  bool transactionB;
  bool stockA;
  bool stockB;
};

constexpr LedState kStates[] = {
    {'0', "ALL OFF", false, false, false, false},
    {'1', "SUCCESS - D1 GREEN", true, true, false, false},
    {'2', "ERROR - D2 RED", true, false, false, false},
    {'3', "HIGH STOCK - D3 GREEN", false, false, true, false},
    {'4', "LOW STOCK - D4 YELLOW", false, false, false, true},
    {'5', "EMPTY STOCK - D5 RED", false, false, true, true},
};

void writeOutput(uint8_t gpio, bool high) {
  digitalWrite(gpio, high ? HIGH : LOW);
}

void applyState(const LedState& state) {
  // Pass through the all-off state so a prior indication does not remain on
  // while the four diagnostic outputs are being changed.
  writeOutput(dental::hardware::kTwoIndicatorControlAGpio, false);
  writeOutput(dental::hardware::kTwoIndicatorControlBGpio, false);
  writeOutput(dental::hardware::kThreeIndicatorControlAGpio, false);
  writeOutput(dental::hardware::kThreeIndicatorControlBGpio, false);

  writeOutput(dental::hardware::kTwoIndicatorControlAGpio, state.transactionA);
  writeOutput(dental::hardware::kTwoIndicatorControlBGpio, state.transactionB);
  writeOutput(dental::hardware::kThreeIndicatorControlAGpio, state.stockA);
  writeOutput(dental::hardware::kThreeIndicatorControlBGpio, state.stockB);

  Serial.print("STATE ");
  Serial.print(state.command);
  Serial.print(": ");
  Serial.println(state.label);
  Serial.print("GPIO32=");
  Serial.print(state.transactionA ? "HIGH" : "LOW");
  Serial.print(" GPIO33=");
  Serial.print(state.transactionB ? "HIGH" : "LOW");
  Serial.print(" GPIO26=");
  Serial.print(state.stockA ? "HIGH" : "LOW");
  Serial.print(" GPIO27=");
  Serial.println(state.stockB ? "HIGH" : "LOW");
}

void printMenu() {
  Serial.println();
  Serial.println("Enter one state number and press Send:");
  Serial.println("0 = ALL OFF");
  Serial.println("1 = SUCCESS (D1 only)");
  Serial.println("2 = ERROR (D2 only)");
  Serial.println("3 = HIGH STOCK (D3 only)");
  Serial.println("4 = LOW STOCK (D4 only)");
  Serial.println("5 = EMPTY STOCK (D5 only)");
}

}  // namespace

void setup() {
  Serial.begin(115200);

  pinMode(dental::hardware::kTwoIndicatorControlAGpio, OUTPUT);
  pinMode(dental::hardware::kTwoIndicatorControlBGpio, OUTPUT);
  pinMode(dental::hardware::kThreeIndicatorControlAGpio, OUTPUT);
  pinMode(dental::hardware::kThreeIndicatorControlBGpio, OUTPUT);

  Serial.println();
  Serial.println("Dental Inventory System");
  Serial.println("D1-D5 LED Logic State Test");
  Serial.println("Outputs remain held until another state is selected");
  applyState(kStates[0]);
  printMenu();
}

void loop() {
  while (Serial.available() > 0) {
    const char command = static_cast<char>(Serial.read());
    for (const LedState& state : kStates) {
      if (command == state.command) {
        applyState(state);
        return;
      }
    }
  }
  delay(1UL);
}
