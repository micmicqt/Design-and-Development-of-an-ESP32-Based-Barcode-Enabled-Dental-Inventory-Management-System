$ErrorActionPreference = 'Stop'
$firmwareRoot = Split-Path -Parent $PSScriptRoot
$main = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'src/main.cpp')
$config = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'include/hardware_config.h')
$disk = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'src/remote_diskio.cpp')

if ($main -match '#include\s*[<"](?:SD|SPI|FS)\.h[>"]' -or
    $main -match '\bSD\s*\.' -or $main -match '\bSPI\s*\.') {
  throw 'ESP32 active source still contains direct MicroSD/SPI ownership.'
}
if ($config -notmatch 'kEsp32MicroSdEnabled\s*=\s*false' -or
    $config -notmatch 'MicroSD is ATmega-owned') {
  throw 'ESP32 hardware configuration does not enforce ATmega MicroSD ownership.'
}
if ($main -notmatch 'SD:STATUS' -or $main -notmatch 'atmegaSdReadSector' -or
    $disk -notmatch 'disk_read') {
  throw 'Bounded ATmega block transport/FAT adapter is missing.'
}
$initialization = [regex]::Match(
    $main,
    'bool initializeMicroSd\(\)\s*\{(?<body>[\s\S]*?)\n\}',
    [System.Text.RegularExpressions.RegexOptions]::None).Groups['body'].Value
$rawInitialize = $initialization.IndexOf('disk_initialize(0U)')
$cleanup = $initialization.IndexOf('recoverStorageBridge()')
if ($rawInitialize -lt 0 -or $cleanup -lt 0 -or $cleanup -lt $rawInitialize) {
  throw 'Storage cleanup runs before the first disk-adapter initialization attempt.'
}
Write-Output 'ESP32 MicroSD ownership: 5 focused source checks PASSED'
