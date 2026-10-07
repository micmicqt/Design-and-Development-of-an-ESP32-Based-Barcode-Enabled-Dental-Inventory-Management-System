$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$source = Get-Content (Join-Path $project 'src/uart_link.cpp') -Raw
$config = Get-Content (Join-Path $project 'include/controller_uart_config.h') -Raw
$status = Get-Content (Join-Path $project 'src/status_outputs.cpp') -Raw

$required = @(
  'ISR\(PCINT2_vect\)', 'ISR\(TIMER1_COMPA_vect\)',
  'ISR\(TIMER1_COMPB_vect\)', 'PCINT22',
  'controllerSender', 'controllerReceiver',
  'controllerTxQueue\.push', 'controllerRxQueue\.push',
  'configuredDdr\(DDRD\)', 'configuredPort\(PORTD\)'
)
foreach ($pattern in $required) {
  if ($source -notmatch $pattern) { throw "Missing D6/D7 controller behavior: $pattern" }
}
if ($config -notmatch 'kBaud\s*=\s*9600UL' -or
    $config -notmatch 'kRxPortBit\s*=\s*6U' -or
    $config -notmatch 'kTxPortBit\s*=\s*7U') {
  throw 'D6/D7 controller ownership or 9600 baud is missing'
}
if ($source -match 'PCINT1_vect|PCINT8|kScannerRxPortBit|kScannerTxPortBit') {
  throw 'Temporary A0/A1 scanner software UART remains active'
}
if ($source -match 'Serial\.|printf\(|puts\(') {
  throw 'Controller transport writes debug text through application UART'
}
if ($status -notmatch 'ATOMIC_BLOCK\(ATOMIC_RESTORESTATE\)[\s\S]*?PORTD = replaceOwnedBits') {
  throw 'D4/D5 PORTD updates can overwrite an interrupt-driven D7 TX edge'
}
Write-Output 'ATmega D6/D7 controller ownership: 12 active-source checks PASSED'
