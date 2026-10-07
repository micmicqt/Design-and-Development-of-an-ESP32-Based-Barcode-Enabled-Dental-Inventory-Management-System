$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\src\main.cpp') -Raw

function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

$handler = [regex]::Match($source,
  '(?s)void handleOfflineCacheRequest\(\) \{(.*?)\n\}\s*void serviceCachePublication')
Require $handler.Success 'Cache HTTP handler was not found'
Require ($handler.Groups[1].Value -match 'cachePublicationJob\.submit\(') `
  'Cache POST does not enqueue the bounded job'
Require ($handler.Groups[1].Value -notmatch
  'offlineInventoryCache\.(begin|item|commit)\(|f_(open|write|sync|rename|unlink)\(') `
  'Cache POST still performs synchronous FatFs/cache publication'
Require ($source -match
  'httpServer\.on\("/offline/cache/progress", HTTP_GET,') `
  'Lightweight cache-progress endpoint is missing'
Require ($source -match
  'cachePublicationJob\.run\(executeCacheOperation') `
  'Cache work is not run outside the HTTP handler'
Require ($source -match 'pumpHttpDuringCachePublication\(\)') `
  'Remote sector waits do not pump HTTP while the cache job is active'
Require ($source -match 'void handleNextEventRequest\(\)') `
  'Online event polling is missing'
Require ($source -match 'void handleStatusRequest\(\)') `
  'RAM-backed status endpoint is missing'
Require ($source -match '!cachePublicationJob\.active\(\) &&') `
  'SD recovery is not interlocked with cache publication'
Require ($source -match 'if \(cachePublicationJob\.active\(\)\) \{\s*sendAcknowledgementError\(409') `
  'Offline ACK is not interlocked with cache publication'
Require ($source -match 'if \(activeTransaction != nullptr\) return;\s*#if ENABLE_HTTP_SERVICE_TIMING') `
  'Queued cache publication is not deferred during transaction barcode processing'
Require ($source -match '(?s)CacheJob::Outcome executeCacheOperation\(const CacheRequest& request\).*?offlinePendingJournal\.blocksCacheReplacement\(\) &&\s*!requestIsInstalledCacheNoOp\(request\)') `
  'Deferred cache work does not recheck the pending-journal interlock'
Require ($source -match 'storageRequestActive && !storagePriority\.preemptible\(\) && !journalPreviewActive') `
  'Background staging/preview still rejects foreground mode requests'
Require ($source -match 'publicationStorage : remoteStorage') 'Paused publication and foreground share a cursor'
Require ($source -match 'void foregroundStorageCheckpoint\(\) \{') 'Safe-boundary foreground yield missing'
Require ($source -match 'offlinePendingJournal\.blocksCacheReplacement\(\)\);') 'Final promotion interlock missing'
foreach ($reason in @('RTC_UNAVAILABLE', 'RTC_UNTRUSTED', 'SD_UNAVAILABLE',
    'CACHE_UNAVAILABLE', 'JOURNAL_UNAVAILABLE', 'CACHE_GENERATION_MISMATCH',
    'JOURNAL_FULL', 'EVENT_QUEUE_FULL')) {
  Require ($source.Contains('lastModeRejectReason = "' + $reason + '";')) `
    "Mode rejection lacks an explicit diagnostic: $reason"
}
Require ($source -match 'offlinePendingJournal\.metadata\(\)\.storedCount >=\s*dental::offline::kMaximumPendingRecords') `
  'Journal capacity diagnosis ignores retained acknowledged overlay records'
Require ($source -match '(?s)void handleNextOfflineEventRequest\(\).*?if \(activeTransaction != nullptr\).*?sendOfflinePendingReadError\(409, "transaction_active"\).*?offlinePendingJournal\.peekOldest') `
  'Journal preview can enter FatFs while a transaction barcode is pending'

Write-Output 'Offline cache/admission/storage ownership: 23 focused checks PASSED'
