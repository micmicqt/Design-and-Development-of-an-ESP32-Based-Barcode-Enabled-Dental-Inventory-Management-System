$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$source = Get-Content firmware/src/main.cpp -Raw
$adapter = [regex]::Match($source, '(?s)class FatFsFileStorage \{.*?(?=SdCacheStorage cacheStorage;)').Value
if (-not $adapter) { throw 'Production adapter extraction failed' }
[IO.File]::WriteAllText((Join-Path $root '.runtime/foreground-fatfs-production.inc'), $adapter)
$zig = Join-Path $root '.runtime/ziglang/ziglang/zig.exe'
$output = Join-Path $root '.runtime/offline-latency-native'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$arguments = @('c++', '-std=c++17', '-O1', '-fsanitize=undefined', '-fno-sanitize-recover=all',
  '-Ifirmware/include', '-Ifirmware/.pio/libdeps/esp32dev/ChanFatFS/include',
  'firmware/tests/offline_latency_production_test.cpp', 'firmware/src/remote_diskio.cpp')
foreach ($unit in @('ff', 'ffunicode')) {
  $object = Join-Path $output "$unit.o"
  & $zig cc -std=c99 '-Ifirmware/include' '-Ifirmware/.pio/libdeps/esp32dev/ChanFatFS/include' `
    -c "firmware/.pio/libdeps/esp32dev/ChanFatFS/src/$unit.c" -o $object
  if ($LASTEXITCODE -ne 0) { throw 'FatFs compile failed' }
  $arguments += $object
}
$binary = Join-Path $output 'offline-latency.exe'
$arguments += @('-o', $binary)
& $zig @arguments
if ($LASTEXITCODE -ne 0) { throw 'Offline latency compile failed' }
& $binary
if ($LASTEXITCODE -ne 0) { throw 'Offline latency regression failed' }
