$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$implementation = Get-Content (Join-Path $project 'src/uart_link.cpp') -Raw
$scannerStub = Get-Content (Join-Path $project 'src/scanner_uart.cpp') -Raw
$header = Get-Content (Join-Path $project 'include/scanner_uart.h') -Raw
if ($implementation -notmatch 'ISR\(USART_RX_vect\)' -or
    $implementation -notmatch 'scannerRxQueue\.push') {
  throw 'Scanner USART0 receive path is missing'
}
if ($implementation -notmatch 'ISR\(USART_UDRE_vect\)' -or
    $implementation -notmatch 'scannerTxQueue\.push') {
  throw 'Scanner USART0 transmit path is missing'
}
$scannerInitialize = [regex]::Match($implementation, 'namespace scanner_uart \{(?s).*?void initialize\(\) \{(?<body>.*?)\n\}').Groups['body'].Value
if ($scannerInitialize -notmatch 'UBRR0H|UBRR0L' -or
    $scannerInitialize -notmatch 'RXCIE0|RXEN0|TXEN0|UCSZ01|UCSZ00') {
  throw 'Scanner USART0 9600 8N1 initialization is missing'
}
if ($scannerInitialize -match 'PORTC|DDRC|PCMSK1|PCIE1' -or
    $implementation -match 'PCINT1_vect|PCINT8') {
  throw 'Temporary A0/A1 scanner initialization remains active'
}
if ($scannerStub -notmatch 'USART0') {
  throw 'Scanner transport documentation is stale'
}
Write-Output 'ATmega scanner D0/D1 USART0 ownership: 7 active-source checks PASSED'
