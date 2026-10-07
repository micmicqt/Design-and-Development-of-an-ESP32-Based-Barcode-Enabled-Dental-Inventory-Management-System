#pragma once
#include <stdint.h>
#define _BV(bit) (1U << (bit))
static uint8_t DDRB, PORTB, SPCR, SPSR;
enum { SPIF = 7 };
uint8_t sdTestExchange(uint8_t byte);
struct SdDataRegister {
  uint8_t received = 0xFFU;
  void operator=(uint8_t byte) { received = sdTestExchange(byte); SPSR |= _BV(SPIF); }
  operator uint8_t() const { return received; }
};
static SdDataRegister SPDR;
