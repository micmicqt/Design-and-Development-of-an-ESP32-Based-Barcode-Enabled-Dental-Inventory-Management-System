$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$implementation = Get-Content (Join-Path $project 'src/uart_link.cpp') -Raw
$scannerStub = Get-Content (Join-Path $project 'src/scanner_uart.cpp') -Raw
$header = Get-Content (Join-Path $project 'include/scanner_uart.h') -Raw
if (($implementation + $scannerStub + $header) -match 'USART_RX_vect|RXEN0|TXEN0|UDR0|UBRR0') {
  throw 'Scanner still depends on USART0/D0/D1'
}
if ($implementation -notmatch 'UCSR0B\s*=\s*0U') { throw 'USART0 is not explicitly left disabled' }
if ($implementation -notmatch 'PCINT1_vect' -or $implementation -notmatch 'PCINT8') {
  throw 'Scanner A0/PC0 receive interrupt is missing'
}
if ($implementation -notmatch 'kScannerTxPortBit' -or $implementation -notmatch 'startScannerTx') {
  throw 'Scanner A1/PC1 transmit path is missing'
}
Write-Output 'ATmega scanner A0/A1 ownership: 5 active-source checks PASSED'
