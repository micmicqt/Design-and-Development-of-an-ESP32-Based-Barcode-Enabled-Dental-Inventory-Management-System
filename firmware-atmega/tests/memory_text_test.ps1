$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$output = Join-Path $root '.runtime/memory-native'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$zig = Join-Path $root '.runtime/ziglang/ziglang/zig.exe'
foreach ($variant in @('host', 'avr-access', 'ubsan')) {
  $arguments = @('c++', '-std=c++17', '-DF_CPU=16000000UL',
      '-Ifirmware-atmega/include')
  if ($variant -eq 'avr-access') {
    $arguments += @('-O0', '-D__AVR__', '-Ifirmware-atmega/tests/flash_text_fakes')
  } elseif ($variant -eq 'ubsan') {
    $arguments += @('-O1', '-g', '-fsanitize=undefined', '-fno-sanitize-recover=all')
  } else { $arguments += '-O0' }
  $binary = Join-Path $output "memory-text-$variant.exe"
  $arguments += @('firmware-atmega/tests/memory_text_test.cpp', '-o', $binary)
  & $zig @arguments
  if ($LASTEXITCODE -ne 0) { throw "Memory text compilation failed: $variant" }
  & $binary
  if ($LASTEXITCODE -ne 0) { throw "Memory text regression failed: $variant" }
}
