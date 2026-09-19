# Focused active-source guard: the host protocol models alone cannot establish
# that actual ESP32 setup/readiness paths no longer gate on a removed LCD.
$ErrorActionPreference = 'Stop'
$firmwareDirectory = Split-Path -Parent $PSScriptRoot
$source = Get-Content -LiteralPath (Join-Path $firmwareDirectory 'src/main.cpp') -Raw
$configuration = Get-Content -LiteralPath (Join-Path $firmwareDirectory 'platformio.ini') -Raw
if ($source -match 'LiquidCrystal_I2C|lcdAvailable|kLcdI2cAddress|LCD unavailable|LCD is unavailable|\blcd\.(init|print|setCursor|backlight)') {
  throw 'ESP32 must neither access nor require the ATmega-owned LCD'
}
if ($configuration -match 'LiquidCrystal_I2C') { throw 'Legacy ESP32 LCD dependency remains' }
if ($source -notmatch 'void showLcdScreen\(const String&, const String&, const String&, const String&\)\s*\{\s*\}') {
  throw 'Migration feedback shim must remain an explicit no-op'
}
if ($source -notmatch 'return rtcAvailable && microSdAvailable &&\s*cacheMetadata.available &&\s*offlinePendingJournal.compatibleWith\(cacheMetadata\)') {
  throw 'Offline readiness must retain RTC/SD/cache/journal checks without an LCD gate'
}
if ($source -match 'rtc.begin\(&Wire\)' -or
    $source -match 'Wire.begin\(dental::hardware::kI2cSdaGpio') {
  throw 'Step 4B must not restore direct ESP32 RTC bus ownership'
}
Write-Output 'ESP32 active LCD ownership: 5 source-integration checks PASSED'
