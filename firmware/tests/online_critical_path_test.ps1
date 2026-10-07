$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '..\src\main.cpp'
$source = Get-Content -LiteralPath $sourcePath -Raw

function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

$barcode = [regex]::Match($source, '(?s)void completeBarcode\(\) \{(.*?)\n\}\s*void processBarcodeByte')
Require $barcode.Success 'Could not locate completeBarcode()'
$onlineStart = $barcode.Groups[1].Value.IndexOf('if (!onlineDeliveryAvailable())')
Require ($onlineStart -ge 0) 'Online queue capacity guard is missing'
$online = $barcode.Groups[1].Value.Substring($onlineStart)
Require ($online -match 'enqueuePendingEvent\(') 'Online event is not queued'
Require ($online -notmatch 'remoteStorage|disk_read|disk_write|appendTransactionEvent|integration_test') 'Online dispatch touches SD/FatFs'
Require ($online -match 'beginOnlineQueuedFeedback\(') 'Queued scan feedback is missing'

$mode = [regex]::Match($source, '(?s)void beginTransactionWorkflow\(const TransactionProfile& transaction\) \{(.*?)\n\}\s*void serviceWorkflowTimeouts')
Require $mode.Success 'Could not locate mode acceptance path'
Require ($mode.Groups[1].Value -match 'storage_policy::modeMayStart') 'Mode does not distinguish online from offline SD requirements'

$recovery = [regex]::Match($source, '(?s)void serviceMicroSdRecovery\(uint32_t nowMs\) \{(.*?)\n\}\s*void setup')
Require $recovery.Success 'Could not locate recovery service'
Require ($recovery.Groups[1].Value -match 'storage_policy::mayRecover') 'Recovery can block active online delivery'
Require ($recovery.Groups[1].Value -match 'NOT_CHECKED') 'Skipped journal validation is mislabeled invalid'

Require ($source -match '#define ENABLE_VERBOSE_DIAGNOSTICS 0') 'Production verbose logging does not default off'
Require ($source -match 'if \(kVerboseDiagnostics\) \{\s*Serial.print\("MicroSD remote read: sector="\)') 'Successful sector detail is not gated'
Require ($source -match 'MicroSD READ failed: sector=') 'Compact failed-sector summary is missing'
Require ($source -notmatch 'ensureIntegrationTestFile|appendTransactionEvent|Saved to SD') 'Legacy online CSV or premature success remains active'

Write-Output 'Online critical-path source checks: PASSED'
