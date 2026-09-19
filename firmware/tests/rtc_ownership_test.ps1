$ErrorActionPreference = 'Stop'

$firmwareRoot = Split-Path -Parent $PSScriptRoot
$main = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'src/main.cpp')
$config = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'include/hardware_config.h')
$platform = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'platformio.ini')

if ($main -match '#include\s*[<"](?:RTClib|Wire)\.h[>"]' -or
    $main -match '\bRTC_DS3231\b' -or $main -match '\bWire\s*\.') {
  throw 'ESP32 active source still contains direct DS3231/Wire ownership.'
}
if ($platform -match 'RTClib') {
  throw 'ESP32 PlatformIO dependencies still include RTClib.'
}
if ($config -notmatch 'kEsp32RtcEnabled\s*=\s*false' -or
    $config -notmatch 'RTC is ATmega-owned') {
  throw 'ESP32 hardware configuration does not enforce ATmega RTC ownership.'
}
if ($main -notmatch 'RTC_STATUS\?' -and
    $main -notmatch 'kRtcStatusRequest') {
  throw 'ESP32 active source does not contain the bounded RTC controller bridge.'
}
if ($main -match 'bool readRtcTimestamp\([^}]+if \(!rtcAvailable') {
  throw 'Transaction timestamps must not depend only on volatile ESP32 RTC trust.'
}

Write-Output 'ESP32 RTC ownership: 5 focused source checks PASSED'
