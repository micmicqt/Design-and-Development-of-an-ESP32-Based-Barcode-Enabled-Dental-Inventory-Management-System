$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/main.cpp') -Raw
function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}
Require ($source -match 'if \(storageRequestActive && atmegaStorageResponseAvailable\)') 'Unread response can be overwritten'
Require ($source -match 'atmegaStorageMailbox.publish\(storageFrame\)') 'Response publication does not use bounded mailbox'
$read = [regex]::Match($source, '(?s)bool remoteSdReadSectorImpl\(.*?\n\}\s*bool remoteSdWriteSectorImpl').Value
Require ($read -match 'storageNeedsResynchronization && !recoverStorageBridge\(\)') 'Read can start before old stream retirement'
Require ($read -match 'ReadScope\(\) \{ storageRequestActive = true; \}') 'Sector read does not own storage'
Require ($read -match '~ReadScope\(\) \{ storageRequestActive = false; \}') 'Sector ownership leaks after failure'
Require ($source -match 'matchesIdleFence\(\s*atmegaStorageResponse, expectedFence\)') 'Stale terminal can satisfy abort fence'
Require ($source -notmatch 'atmegaStorageResponseParser = dental_link::storage::Parser\{\}') 'Parser resets across stale partial frames'
Require ($source -match 'if \(!initializationComplete\).*?') 'Startup admission gate missing'
Require ($source -match 'pendingModeReply = !initializationComplete \? dental_link::kModeInitializing') 'Startup lacks explicit initializing response'
$failure = [regex]::Match($source, '(?s)void beginErrorFeedback\(.*?\n\}').Value
foreach ($cleanup in @('activeTransaction = nullptr', 'transactionRouteCaptured = false',
    "capturedCacheGeneration[0] = '\0'", 'capturedCacheItemCount = 0U',
    'deferredControllerScan = dental_link::Frame::kNone', 'resetScannerWorkflowBuffers()')) {
  Require ($failure.Contains($cleanup)) "Terminal failure misses cleanup: $cleanup"
}
Require ($source -match '(?s)if \(storageRequestActive \|\| storagePriority\.background\(\) \|\| journalPreviewActive\).*?deferredControllerScan = frame') 'SCAN can recursively enter FatFs/RTC from sector waiter'
Write-Output 'Remote storage lifecycle/startup/terminal cleanup: 16 source checks PASSED'
