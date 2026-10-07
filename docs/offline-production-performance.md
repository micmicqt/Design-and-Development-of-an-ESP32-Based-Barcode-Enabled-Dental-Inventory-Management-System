# Offline transaction and synchronization production pass

This records the earlier performance pass. Current identity migration, timing
instrumentation, LCD feedback, verification totals and deployment requirements
supersede the historical scope/results below; see
[offline-event-identity-and-feedback.md](offline-event-identity-and-feedback.md).

## Scope and evidence

This pass changes ESP32-side derived runtime indices and desktop synchronization
diagnostics/display handling. It does not change ATmega production source, pins,
baud, SPI timing, SD chunk size, storage formats, network configuration, SQLite
reconciliation rules, or ACK retirement rules.

All measurements below use disposable memory-sector fixtures or in-memory SQLite
and a mock device. Neither physical pending record was accessed, synchronized,
acknowledged, deleted, or replaced. No COM port or application database was used.
Physical synchronization success and new physical transaction latency remain
unverified.

The supplied physical synchronization failure contains no failing endpoint,
HTTP status, or stage trace. It cannot establish whether the first failure was
fetch, SQLite, ACK, or final cache publication. The new logs expose that boundary;
the generic old message must not be treated as proof of one particular failure.

## Proven latency contributors

The previous healthy path validated the full cache during barcode lookup,
scanned the full journal during overlay, repeated overlay validation during
append, then scanned the full journal again to verify append. Each pass reopened
FatFs files and reread directory/FAT/data sectors over the 9600-baud bridge.
The resulting sector work increased with journal length. Normal successful
responses already return immediately, not at the end of their failure budgets.

Baseline production-FatFs fixture, first transaction at each initial journal size:

| Initial rows | Lookup reads | Overlay reads | Append reads | Writes | Wire-cost model |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 2 | 2 | 8 | 4 | 23.2 s |
| 10 | 2 | 8 | 25 | 7 | 60.2 s |
| 50 | 2 | 36 | 81 | 7 | 177.8 s |
| 100 | 2 | 72 | 150 | 4 | 320.0 s |

Append includes its second stock derivation and post-write verification; lookup
and overlay are not included again in those append read counts. These are actual
fixture sector counts, not measured physical elapsed times. The model assigns
1.4 s per remote sector read and 1.6 s per write. RTC, CPU, physical card pauses,
recovery waits, and feedback transmission are not modeled.

At 125 kHz, 512 payload SPI bytes take about 32.8 ms. A roughly 1330-character
sector response at 9600 baud, 8N1 takes about 1.386 s on UART alone. Repeated
filesystem passes therefore cost much more than local CRC/stock arithmetic.

## Bounded runtime acceleration

- Cache lookup optionally retains four complete product records after validating
  metadata, header, every row, CRC, and EOF. The index is keyed to generation and
  item count, rebuilt at boot/recovery/cache replacement, and invalidated on SD
  transport failure. Larger catalogs use the original streaming validation path.
- Journal validation builds a bounded 32-product overlay, exact barcode identity,
  stock-chain/threshold constraints, oldest pending record, and validated EOF.
  Barcodes beyond the physical scanner's 64-character bound or more than 32
  distinct products fall back to streaming derivation. Retained acknowledged rows
  still contribute to effective offline stock until the existing compaction step.
- Healthy appends preserve the independent flushed body and newline commit marker.
  They physically read back only the new CRC-protected row from validated EOF,
  compare all record fields, and verify EOF. Metadata and derived stock advance
  only after verified commitment. Ambiguous writes retain the full existing
  scan/recovery path. No journal rewrite or format change is introduced.
- A sixteen-sector read-through cache exists only inside an admitted offline
  transaction. It is cleared at entry/exit and on transport failure. Every write
  is still physical and invalidates the corresponding cached sector, so durable
  append readback cannot be satisfied from stale RAM. There is no write-back cache.
- READY oldest-record preview uses validated runtime metadata without SD I/O.
  Unknown/recovering/invalid state still fails closed or takes the recovery path.

MicroSD remains authoritative. Runtime indices are disposable, reconstructed from
durable files after reboot, and never create events or alter receipts. Existing
foreground ownership, cache-publication deferral, ABORT/IDLE fences, and ACK-worker
exclusion remain intact. Generic storage/test adapters do not opt into trusted
runtime reads and retain the original full-validation behavior.

## Fixture scaling results

Each series starts with the specified row count and performs five further durable
appends. The fifth sample therefore has four more prior records than the first.
With five samples, nearest-rank p95 equals the maximum; this is a small regression
fixture, not a statistically representative physical benchmark.

| Initial rows | Before min / median / p95 / max (s) | After min / median / p95 / max (s) |
| ---: | --- | --- |
| 0 | 23.2 / 33.6 / 43.4 / 43.4 | 13.4 / 14.8 / 22.4 / 22.4 |
| 10 | 59.6 / 60.2 / 68.6 / 68.6 | 14.8 / 14.8 / 22.4 / 22.4 |
| 50 | 177.2 / 177.8 / 186.2 / 186.2 | 14.8 / 14.8 / 22.4 / 22.4 |
| 100 | 320.0 / 328.4 / 329.0 / 329.0 | 14.8 / 14.8 / 22.4 / 22.4 |

After priming, lookup and overlay each require zero sector reads in these fixtures;
append uses 5–8 reads and 4–7 writes in the small FAT16 fixture. Directory/FAT work and the two flushed
appends/readback remain real costs. These figures do not promise a 14.8-second
physical transaction. The later FAT32/large-directory fixture and physical
31.415-second sample are documented in [offline-event-identity-and-feedback.md](offline-event-identity-and-feedback.md).

Production `OFFLINE TX TIMING` records RTC, lookup, overlay, calculation, append,
physical sector counts, recovery-fence calls, and controller-barcode-receive to
durable-save elapsed time. `OFFLINE TX I/O` records FatFs operation counts and
elapsed time for open/read/write/sync/close/stat/unlink/rename. Explicit readback
seek is included under READ; FatFs append seek is included under OPEN_WRITE.
ATmega internal retry counts are not carried in successful storage replies.
The later pass separately measures deferred-admission/queue wait and bridge-fence
retries; neither establishes successful card-internal retry counts.
The diagnostic is emitted only after `kCommitted`, before success feedback.

## Synchronize click and failure-state handling

The click calls parameter-free frozen preload
`hardware.synchronizeOfflineInventory()`, authenticated/trusted IPC, the existing
main-process coordinator, and the same configured gateway used by online work.
The coordinator fetches the authoritative FIFO head itself, reconciles current
SQLite stock plus signed delta in an atomic stock/history/receipt transaction,
then sends device ACK only after COMMIT. Cached device resulting stock remains
audit context, never a replacement for current SQLite stock.

Safe main-process logs cover SYNC START, record fetch, database apply/commit,
device ACK, ACK status/confirmation, final status, cache refresh, and preview.
HTTP logs contain fixed endpoint, method, status, elapsed time, timeout flag, and
whitelisted device error. They never log address, token, password, or event body.
Malformed responses and typed conflicts are reported at their owning stage.

The original generic fetch/IPC catch discarded useful gateway error information.
Status transport failure omitted current journal metadata, which the page
rendered directly as Not reported. Now a separate display-only observation keeps
the last trustworthy count/readiness with an explicit last-known notice. A new
authoritative recovering/corrupt/unavailable status supersedes that observation.
Unknown is never converted into zero. Healthy zero remains 0 / Ready.

Status request sequencing prevents an older completed failure from replacing a
newer status result. Preview generation guards prevent a pre-click preview from
overwriting synchronization state. Only explicit temporary busy/recovery states
receive bounded fetch retries: at most three attempts, two seconds between
attempts. Authorization, malformed response, and generic network failures are
not blindly retried.

Preview remains read-only. ACK 202 means scheduled/in progress, not retired.
Existing durable ACK confirmation, lost-response recovery, and receipt replay
remain unchanged. Cache publication starts only after retirement and a confirmed
empty journal. Cache failure returns CACHE_REFRESH_FAILED, distinct from failed
event reconciliation; retry does not reapply events.

## Current HTTP contracts (unchanged)

These firmware routes currently have no firmware bearer-token gate. Electron
uses authenticated/trusted IPC and its same saved address/token/gateway; this pass
does not add, remove, or weaken an authentication check.

| Endpoint | Success / empty | Busy / unavailable / invalid |
| --- | --- | --- |
| GET /status | 200 RAM snapshot, including mode, RTC/SD, optional cache/journal metadata and ACK-job state | Journal unknown/unavailable is represented by state and omitted count, never invented zero |
| GET /offline/events/next | 200 one typed oldest event; 204 empty body for no pending event | 409 transaction_active, cache_publication_in_progress, offline_ack_in_progress; 503 storage_recovering, storage_transport_unavailable, pending_journal_unavailable; 500 pending_journal_invalid |
| POST /offline/events/ack | Body `{eventId}`; 202 processing; 200 durably acknowledged or identical durable replay | 400 invalid_request; 404 no_pending_event; 409 controller_busy, event_id_mismatch, cache/ACK busy; 503 journal/worker unavailable; 500 journal invalid |
| POST /offline/cache | Typed begin/item/commit body; 202 job queued/in progress; 200 completed/idempotent result | 400 invalid_request; 409 publication/transaction/ACK/pending interlocks and transfer identity/index/count conflicts; 503 storage unavailable; 422 cache validation failed; 500 write/replacement/compaction failures |
| GET /offline/cache?jobId=… | 202 same job progress; 200 success | 400 invalid_job_id; 404 unknown_job_id; terminal job errors as above |

Pending-event JSON fields are eventId, timestamp, productId, barcode, action,
delta, resultingStock, stockStatus, cacheGeneration. ACK progress JSON is
acknowledged:false, processing:true, eventId; durable ACK JSON adds the verified
pendingSyncItems and alreadyAcknowledged flag. ACK status is in GET /status,
not a separate endpoint: IDLE/QUEUED/RUNNING/VERIFYING/SUCCEEDED/FAILED plus event ID.
Cache progress reports processing, jobId, operation, generation, stage, elapsedMs,
storageOwner, lastFatFsOperation/result, failureReason. Completed cache replies
report accepted, operation, generation, receivedItems, alreadyCurrent.
Strict production gateway parsing remains covered by tests.

The 15-second preview timeout remains operation-specific. Healthy READY preview
now has zero SD sector operations; fallback recovery is not claimed to finish
within 15 seconds. ACK retains 30-second HTTP request and bounded existing job
monitoring; cache retains its 120-second overall budget; normal request budgets
were not globally increased.

## Verification and deployment boundary

- Affected desktop pass: 566 tests, then final changed subset: 469 tests,
  including one new IPC status-order test (567 distinct affected tests overall).
- Shared protocol: 13 tests. TypeScript, ESLint, Electron production build: PASS.
- Native generic regression: 31 executables. Actual FatFs foreground adapter:
  100 interleavings and reopen. Actual remote storage: eight fault/timing cases
  plus 100 cycles. Actual RawCard: five fault/register cases plus 100 cycles.
- Journal/cache/event/RTC suite: 97 scenarios and 100 durable-event cycles.
  Final remote disk suite: 20 scenarios. Button admission: three scenarios and
  100 cycles. Production AP/STA: seven scenarios and 100 cycles.
- New production-FatFs latency fixture: four journal sizes, five durable
  transactions each, preview/reopen/ACK overlay/conflict/ambiguous-write coverage.
  UBSan enabled for the focused latency, remote-disk, and journal suites: PASS.
- Real in-memory SQLite sync batches 0/1/2/10/50/100: PASS. One illustrative host
  run took 13.51/7.43/6.42/23.48/99.66/187.15 ms respectively. Mock device fetch,
  ACK and cache return immediately; these are not physical network/card timings.
- ESP32 build: PASS; RAM 100,516 / 327,680 (30.7%), flash 1,136,029 / 1,310,720
  (86.7%). No ATmega production change, hence no redundant Uno build this pass.

Files changed by this pass (not the entire pre-existing dirty worktree):

- firmware/include/offline_inventory_cache.h
- firmware/include/offline_pending_journal.h
- firmware/include/remote_diskio.h
- firmware/src/remote_diskio.cpp
- firmware/src/main.cpp
- firmware/tests/foreground_fatfs_production_test.cpp and .ps1
- firmware/tests/remote_storage_production_test.cpp
- firmware/tests/remote_diskio_test.cpp
- firmware/tests/offline_latency_production_test.cpp and .ps1 (new)
- apps/desktop/src/main/hardware/esp32-http-gateway.ts
- apps/desktop/src/main/hardware/offline-sync-coordinator.ts
- apps/desktop/src/main/ipc/register-hardware-handlers.ts
- apps/desktop/src/renderer/src/pages/SyncOfflinePage.tsx
- apps/desktop/tests/hardware/offline-sync-coordinator.test.ts
- apps/desktop/tests/hardware/offline-sync-integration.test.ts
- apps/desktop/tests/ipc/register-hardware-handlers.test.ts
- apps/desktop/src/renderer/src/pages/SyncOfflinePage.test.tsx
- docs/offline-production-performance.md (new)

Deployment requires the rebuilt desktop application and ESP32 firmware only,
after separate upload approval. Uno firmware need not change. Physical checks
must first confirm healthy status/preview and collect stage logs; synchronization
of the two real pending records remains explicitly user-controlled. No upload,
staging, commit, push, or hardware access occurred in this pass.
