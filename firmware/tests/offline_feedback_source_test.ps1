$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Get-Content -LiteralPath (Join-Path $root 'firmware/src/main.cpp') -Raw
$complete = [regex]::Match($source, '(?s)void completeBarcode\(\) \{.*?(?=void processBarcodeByte)').Value
if (!$complete) { throw 'Barcode workflow not found' }
if ($complete.IndexOf('queueOfflineDisplay(true,') -gt $complete.IndexOf('readRtcTimestamp(')) {
  throw 'Processing display queued after expensive RTC/storage work'
}
$offline = [regex]::Match($source, '(?s)void completeOfflineBarcode\(.*?(?=void completeBarcode)').Value
if (!$offline -or $offline.IndexOf('JournalAppendResult::kCommitted') -gt $offline.IndexOf('beginOfflineSuccessFeedback(committedRecord)')) {
  throw 'Saved feedback is not gated by durable commitment'
}
if ($source -notmatch '(?s)void beginErrorFeedback.*?offlineLcdProcessing.*?TRANSACTION ERROR.*?queueOfflineDisplay\(false') {
  throw 'Accepted-barcode errors leave Processing on the LCD'
}
if ($source -notmatch '(?s)void beginOfflineSuccessFeedback.*?offlineProductBuffer.name') {
  throw 'LCD product name must come from the already validated cache product'
}
Write-Output 'Offline LCD production ordering: processing before RTC/storage, saved after commit, concrete errors, existing metadata PASS'
