$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Get-Content -LiteralPath (Join-Path $root 'firmware/src/main.cpp') -Raw
$read = [regex]::Match($source, '(?s)bool remoteSdReadSectorImpl\(.*?\n\}(?=\s*bool remoteSdWriteSectorImpl)').Value
$fence = [regex]::Match($source, '(?s)bool recoverStorageBridge\(\) \{.*?\n\}(?=\s*bool remoteSdInitializeImpl)').Value
if (-not $read -or -not $fence) { throw 'Production read/fence extraction failed' }
$generated = Join-Path $root '.runtime/critical-remote-production.inc'
[IO.File]::WriteAllText($generated, $fence + "`n" + $read)
$zig = Join-Path $root '.runtime/ziglang/ziglang/zig.exe'
$binary = Join-Path $root '.runtime/priority-native/remote-production-final.exe'
& $zig c++ -std=c++17 -O0 '-Ifirmware/include' `
  (Join-Path $PSScriptRoot 'remote_storage_production_test.cpp') -o $binary
if ($LASTEXITCODE -ne 0) { throw 'Production remote storage test compilation failed' }
& $binary
if ($LASTEXITCODE -ne 0) { throw 'Production remote storage test failed' }
