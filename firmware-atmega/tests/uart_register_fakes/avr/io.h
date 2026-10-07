#pragma once
#include <stdint.h>

#define _BV(bit) (1U << (bit))
// Host register model for compiling the actual uart_link.cpp. In particular,
// AVR interrupt flags are write-one-to-clear, not ordinary RAM variables.
struct InterruptFlags {
  uint8_t pending = 0U;
  unsigned writes = 0U;
  void operator=(uint8_t mask) { pending &= static_cast<uint8_t>(~mask); ++writes; }
};
static uint8_t DDRD, PORTD, PIND, TCCR1A, TCCR1B, TIMSK1;
static uint16_t TCNT1, OCR1A, OCR1B;
static InterruptFlags TIFR1, TIFR0, PCIFR;
static uint8_t PCMSK2, PCICR, TCCR0A, TCCR0B, TCNT0, OCR0A, TIMSK0;
static uint8_t UCSR0A, UCSR0B, UCSR0C, UBRR0H, UBRR0L, UDR0;
enum {
  OCIE1A = 1, OCIE1B = 2, OCF1A = 1, OCF1B = 2,
  PCIF2 = 2, PCIE2 = 2, PCINT22 = 6, CS11 = 1,
  WGM01 = 1, OCF0A = 1, OCIE0A = 1, CS01 = 1, CS00 = 0,
  FE0 = 4, DOR0 = 3, UPE0 = 2, UDRIE0 = 5,
  UCSZ01 = 2, UCSZ00 = 1, RXCIE0 = 7, RXEN0 = 4, TXEN0 = 3
};
