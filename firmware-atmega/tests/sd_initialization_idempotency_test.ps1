$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$source = Get-Content (Join-Path $project 'src/sd_card.cpp') -Raw
$config = Get-Content (Join-Path $project 'include/sd_spi_config.h') -Raw

$readyGuard = $source.IndexOf('if (state_ == State::kReady) return true;')
$powerSettle = $source.IndexOf('powerUpSettle_.beforeFirstInitialization(')
$spiSetup = $source.IndexOf('DDRB = spi_config::configuredDdrb(DDRB);')
$diagnosticReset = $source.IndexOf('memset(diagnostic_.bytes')
if ($readyGuard -lt 0 -or $diagnosticReset -lt 0 -or $readyGuard -gt $diagnosticReset) {
  throw 'READY fast path does not precede CMD0/full initialization'
}
if ($powerSettle -le $readyGuard -or $powerSettle -ge $diagnosticReset -or
    $powerSettle -ge $spiSetup) {
  throw 'The one-time SD power-up interval must precede the first SPI setup'
}
if ($config -notmatch 'sendStartupClocks' -or
    $config -notmatch 'commandTransaction' -or
    $config -notmatch 'kResponsePollBytes\s*=\s*20U' -or
    $config -notmatch 'kSdSpiClockHz\s*=\s*125000UL' -or
    $config -notmatch 'kCmd0MaximumAttempts\s*=\s*20U' -or
    $config -notmatch 'kCmd0RetryDelayMs\s*=\s*100U' -or
    $source -notmatch 'spi_config::sendStartupClocks' -or
    $source -notmatch 'spi_config::enterIdle' -or
    $source -notmatch 'cmd0EnteredIdle\(cmd0\)') {
  throw 'Physically proven initialization transaction is incomplete'
}
if ($config -match 'kCmd0ResetWindowMs|kCmd0RetrySpacingMs' -or
    $source -match 'waitMilliseconds|cmd0RetryAllowed') {
  throw 'Failed 100-attempt CMD0 experiment remains active'
}
if ($source -notmatch 'kCmd0AttemptCount\]\s*=\s*cmd0Attempts') {
  throw 'CMD0 diagnostics do not report the bounded attempt count'
}
if ($source -notmatch 'command\(8U,\s*0x1AAU\)' -or
    $source -notmatch 'command\(55U,\s*0U\)' -or
    $source -notmatch 'command\(41U,\s*1UL\s*<<\s*30U\)' -or
    $source -notmatch 'command\(58U,\s*0U\)' -or
    $source -notmatch 'command\(16U,\s*512UL\)' -or
    $source -notmatch 'command\(17U,\s*address\)' -or
    $source -notmatch 'command\(24U,\s*address\)') {
  throw 'Production SD commands do not share the proven transaction'
}
if ($source -match 'kDataSpcr|250 kHz data phase' -or
    $config -match '250000UL|kDataSpcr') {
  throw 'Production still changes SPI speed after initialization'
}
$commandBody = [regex]::Match(
    $source, '(?s)uint8_t RawCard::command\(.*?\) \{(?<body>.*?)\r?\nbool RawCard::initialize').Groups['body'].Value
if ($commandBody -notmatch 'spi_config::commandTransaction' -or
    $commandBody -match 'waitReady\(') {
  throw 'Production commands are not using the one proven command primitive'
}
$readAttemptBody = [regex]::Match(
    $source, '(?s)ReadAttempt RawCard::beginReadAttempt\(.*?\) \{(?<body>.*?)\r?\nbool RawCard::recoverRead').Groups['body'].Value
if (([regex]::Matches($readAttemptBody, 'deselect\(\)')).Count -lt 2 -or
    ([regex]::Matches($readAttemptBody, 'position_\s*=\s*0U')).Count -lt 3) {
  throw 'CMD17 failure paths do not cleanly deselect and reset local state'
}
if ($source -match 'Cmd0Path::kVerifyReady|initializedCardVerified|command\(13U, 0U\)') {
  throw 'Invalid CMD0=0x00/CMD58/CMD13 shortcut remains active'
}
$abortBody = [regex]::Match(
    $source, '(?s)void RawCard::abort\(\) \{(?<body>.*?)\r?\n\}').Groups['body'].Value
if ($abortBody -notmatch 'position_ = 0U' -or $abortBody -match 'state_\s*=') {
  throw 'SD:ABORT must preserve raw-card READY state'
}
if ($source -notmatch '(?s)void RawCard::fail\(\).*?state_ = State::kIoError') {
  throw 'Genuine raw transfer failure does not invalidate READY'
}
Write-Output 'ATmega unified SD command/idempotency: 20 active-source checks PASSED'
