#include "twi_master.h"
#include "hardware_config.h"
#include <avr/io.h>

namespace dental_atmega {
namespace twi {
static_assert(F_CPU == 16000000UL, "TWI timing assumes 16 MHz");
void AvrHardware::initialize() {
  DDRC &= static_cast<uint8_t>(~hardware::kTwiMask);
  PORTC |= hardware::kTwiMask; // Weak pulls; backpack external pull-ups required.
  TWSR = 0U; // Prescaler one.
  TWBR = bitRate(F_CPU);
  TWCR = _BV(TWEN); // Polled, TWIE disabled; UART/timer interrupts stay enabled.
}
void AvrHardware::start() { TWCR = _BV(TWINT) | _BV(TWEN) | _BV(TWSTA); }
void AvrHardware::send(uint8_t value) { TWDR = value; TWCR = _BV(TWINT) | _BV(TWEN); }
void AvrHardware::stop() { TWCR = _BV(TWINT) | _BV(TWEN) | _BV(TWSTO); }
void AvrHardware::reset() { TWCR = 0U; TWCR = _BV(TWEN); }
bool AvrHardware::ready() const { return (TWCR & _BV(TWINT)) != 0U; }
bool AvrHardware::stopping() const { return (TWCR & _BV(TWSTO)) != 0U; }
uint8_t AvrHardware::status() const { return TWSR & 0xF8U; }
} // namespace twi
} // namespace dental_atmega
