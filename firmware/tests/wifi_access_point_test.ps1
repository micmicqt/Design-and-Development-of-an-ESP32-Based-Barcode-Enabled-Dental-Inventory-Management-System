param([string]$Zig = '')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $project
if (-not $Zig) { $Zig = Join-Path $root '.runtime/ziglang/ziglang/zig.exe' }
$source = Get-Content -LiteralPath (Join-Path $project 'src/main.cpp') -Raw
# Compile the actual production functions with host hardware fakes, including
# the existing station state machine. No secrets.h contents are read.
if ($source -notmatch 'constexpr char kAccessPointPassword\[\] = DENTAL_AP_PASSWORD;' -or
    $source -match 'constexpr char kAccessPointPassword\[\] = "') {
  throw 'Production AP password must come only from ignored secrets.h'
}
$functions = [regex]::Match($source,
  '(?s)bool wiFiCredentialsAreConfigured\(\).*?(?=void setTransactionIndicatorOff\()')
$state = [regex]::Match($source, '(?s)enum class WiFiConnectionState.*?\};')
$globals = [regex]::Match($source,
  '(?s)WiFiConnectionState wiFiConnectionState =.*?kDesktopPresenceLeaseMs\);')
$constants = [regex]::Matches($source,
  '(?s)constexpr (?:char|uint32_t|uint16_t) k(?:AccessPointSsid|AccessPointPassword|WiFiConnectionTimeoutMs|WiFiRetryBackoffMs|WiFiProgressIntervalMs|WiFiSsidPlaceholder|WiFiPasswordPlaceholder|DesktopPresenceLeaseMs)\b.*?;')
if (-not $functions.Success -or -not $state.Success -or -not $globals.Success -or
    $constants.Count -ne 8) { throw 'Production Wi-Fi test extraction failed' }
$routeStart = [regex]::Match($source,
  '(?s)void beginTransactionWorkflow\(.*?activeTransactionRoute =')
if ($routeStart.Value -notmatch 'networkConnected = wiFiNetworkAvailable\(\)') {
  throw 'Transaction network availability does not include the access point'
}
$output = Join-Path $root '.runtime/wifi-access-point-tests'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$unit = ($constants.Value -join "`n") + "`n" + $state.Value + "`n" +
    $globals.Value + "`n" + $functions.Value
[IO.File]::WriteAllText((Join-Path $output 'wifi_production.inc'), $unit)
$binary = Join-Path $output 'wifi_access_point_test.exe'
& $Zig c++ -std=c++17 -O0 "-I$output" "-I$project/include" `
    (Join-Path $PSScriptRoot 'wifi_access_point_test.cpp') -o $binary
if ($LASTEXITCODE -ne 0) { throw 'Wi-Fi host test compilation failed' }
& $binary
if ($LASTEXITCODE -ne 0) { throw 'Wi-Fi host tests failed' }
