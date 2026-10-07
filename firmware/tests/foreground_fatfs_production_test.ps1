$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$source = Get-Content firmware/src/main.cpp -Raw
$adapter = [regex]::Match($source, '(?s)class FatFsFileStorage \{.*?(?=SdCacheStorage cacheStorage;)').Value
if (-not $adapter) { throw 'Production file adapter extraction failed' }
[IO.File]::WriteAllText((Join-Path $root '.runtime/foreground-fatfs-production.inc'), $adapter)
$zig = Join-Path $root '.runtime/ziglang/ziglang/zig.exe'
$arguments = @('c++', '-std=c++17', '-O0', '-Ifirmware/include',
  '-Ifirmware/.pio/libdeps/esp32dev/ChanFatFS/include',
  'firmware/tests/foreground_fatfs_production_test.cpp', 'firmware/src/remote_diskio.cpp')
foreach ($unit in @('ff', 'ffunicode')) {
  $object = Join-Path $root ".runtime/priority-native/$unit.o"
  & $zig cc -std=c99 '-Ifirmware/include' `
    '-Ifirmware/.pio/libdeps/esp32dev/ChanFatFS/include' `
    -c "firmware/.pio/libdeps/esp32dev/ChanFatFS/src/$unit.c" -o $object
  if ($LASTEXITCODE -ne 0) { throw 'FatFs compilation failed' }
  $arguments += $object
}
$binary = Join-Path $root '.runtime/priority-native/foreground-fatfs-production-final.exe'
$arguments += @('-o', $binary)
& $zig @arguments
if ($LASTEXITCODE -ne 0) { throw 'Production file adapter compilation failed' }
& $binary
if ($LASTEXITCODE -ne 0) { throw 'Production file adapter tests failed' }
