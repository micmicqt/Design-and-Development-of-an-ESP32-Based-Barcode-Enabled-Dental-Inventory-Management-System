$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sd = Get-Content -Raw -LiteralPath (Join-Path $root 'src/sd_card.cpp')
$status = Get-Content -Raw -LiteralPath (Join-Path $root 'src/status_outputs.cpp')

if ($status -notmatch 'PORTB\s*=\s*replaceOwnedBits\(PORTB,\s*hardware::kBigMask' -or
    [regex]::Matches($status, 'PORTB\s*=').Count -ne 1) {
  throw 'Big-status output no longer preserves unrelated PORTB bits.'
}
$abort = [regex]::Match($sd, 'void RawCard::abort\(\)\s*\{(?<body>[\s\S]*?)\n\}')
if (-not $abort.Success -or $abort.Groups['body'].Value -match '\b(?:DDRB|PORTB|SPCR|SPSR)\s*=') {
  throw 'SD:ABORT mutates physical SPI configuration.'
}
if ($sd -notmatch 'diagnostic_\.bytes\[kDdrb\]\s*=\s*DDRB' -or
    $sd -notmatch 'diagnostic_\.bytes\[kSpcr\]\s*=\s*SPCR') {
  throw 'The pre-CMD0 register snapshot is missing.'
}
if ($sd -notmatch 'kCmd0ReadyWaitSkipped' -or
    $sd -notmatch 'spi_config::sendStartupClocks' -or
    $sd -notmatch 'spi_config::commandTransaction') {
  throw 'The unified physically proven SD command path is missing.'
}

Write-Output 'ATmega SD SPI ownership: 4 focused source checks PASSED'
