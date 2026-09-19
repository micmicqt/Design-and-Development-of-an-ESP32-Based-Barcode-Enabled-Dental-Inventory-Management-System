#include "scanner_uart.h"

// The scanner API and PC0/PC1 interrupt implementation are co-located with the
// controller software UART in uart_link.cpp. Both channels share Timer1's two
// compare vectors through one earliest-deadline scheduler; separate vector
// definitions here would be unsafe.
