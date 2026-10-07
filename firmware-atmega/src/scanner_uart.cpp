#include "scanner_uart.h"

// The scanner API and USART0 interrupt implementation are co-located with the
// controller transport in uart_link.cpp. Timer1/PCINT2 belong to the independent
// D6/D7 controller software UART.
