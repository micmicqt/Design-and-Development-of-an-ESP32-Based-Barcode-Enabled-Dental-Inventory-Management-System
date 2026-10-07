$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$binary = Join-Path $root '.runtime/critical-native/atmega-sd_raw_driver_test.exe'
& .runtime/ziglang/ziglang/zig.exe c++ -std=c++17 -O0 -DF_CPU=16000000UL `
  '-Ifirmware-atmega/tests/sd_register_fakes' '-Ifirmware-atmega/include' `
  firmware-atmega/tests/sd_raw_driver_test.cpp -o $binary
if ($LASTEXITCODE -ne 0) { throw 'RawCard host compilation failed' }
& $binary
if ($LASTEXITCODE -ne 0) { throw 'RawCard host tests failed' }
