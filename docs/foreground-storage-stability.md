# Foreground storage priority and runtime SD evidence

This pass is host-verified, not physically accepted. Neither controller was
uploaded, no COM port was accessed, and physical pending records were untouched.

## Root causes and arbitration

The blanket `storageRequestActive` admission gate rejected even online buttons
while background cache publication used the remote bridge. A queued HTTP job
alone did not solve this: its synchronous FatFs execution could own the bridge
for many sector operations.

Publication now yields **after a complete FatFs API returns**, never inside
`disk_read`, `disk_write`, a partial UART line, or an unfinished filesystem call.
The current atomic call finishes first. A button arriving during it is recorded
with its online/offline route and receives `BTN:WAIT`. This live-controller
reply is renewed every 500 ms while the protected call runs. Final mode OK starts
the scanner deadline after protected waiting; missing replies still exhaust the
existing bounded retries. No barcode can be forwarded before mode OK.

At a safe boundary, foreground transaction processing runs with controller,
RTC, workflow timeouts, Wi-Fi, and HTTP servicing. Background work resumes after
the foreground workflow completes. Each resumed filesystem operation advances
the cache job before its next yield point. Unconfirmed online FIFO events still
intentionally prevent cache replacement; this is not a false storage failure.

Publication and foreground reads use different `FIL` cursors. The shared
`FF_FS_TINY` volume is used sequentially, not reentrantly. Preview is read-only,
yields at a line boundary, returns a retryable transaction-active response, and
does not mark the journal corrupt. Preview/ACK cannot enter the publication job.

The old installed cache remains authoritative throughout staging. Offline work
freezes that generation. Immediately before promotion, the journal interlock is
checked again. Newly durable pending records prevent replacement. Rename,
rollback, and acknowledged-journal compaction remain protected; buttons wait
rather than rejecting solely because these operations own storage.

## SD failure evidence

The supplied 24 ms `SD:ERROR` with zero chunks proves an explicit remote failure,
but contains no R1/token evidence that identifies its raw stage. This pass does
not claim to have reproduced or fixed that physical card failure.

Failure-only diagnostics now report current sector, reason, actual retry count,
R1, R1 timeout, token, token timeout, ready timeout, and initialized state. The
compact CMD17 trace includes both attempts and retry readiness. Not-ready and
transfer-busy attempts reset the trace too, so an earlier sector cannot be
reported as the current failure. An error after DATA is distinguished from a
bootstrap rejection.

Mid-stream failures trigger the existing tagged abort/fence and a version-2
`SD:STREAM` diagnostic. It preserves generated/accepted DATA counts, last
generated/accepted offsets, terminal OK/error generation and acceptance,
requested sector, abort occurrence, and remaining frame bytes/transfer state
captured at abort. Accepted means admitted to the UART scheduler, not proof of
physical reception. High-water is the scheduler peak, not a live wire-depth
measurement. The abort snapshot identifies host cleanup; it does not itself
prove an autonomous ATmega abort caused the original stall.

The five-second limit was demonstrably insufficient for legal raw read retry
paths. The old 16-chunk log does not establish whether that particular failure
was slow bootstrap, backpressure, missing generation, or wire loss. The next
failure snapshot is required to distinguish those possibilities.

CMD24 already checks its data-response token and waits until the card releases
busy before deselecting/trailing clocks and returning success. Sync also waits
for readiness. Production-driver host tests verify this ordering and reject
stuck busy. No speculative SPI mode, frequency, pin, or write-format change was
made.

## Derived budgets

At 125 kHz, 65,000 byte polls take `65000 * 8 / 125000 = 4.160 s` on the wire.
A read permits one retry: two token polls plus one retry-ready poll, at most
12.480 s. A 518-byte payload/CRC/command allowance costs 34 ms.

At 9600 baud 8N1, a 24-byte hex DATA frame is 61 characters and the final 8-byte
frame is 29. A read uses 14 command characters, 21 full DATA frames, one final
DATA, and six terminal OK characters: 1,330 characters, rounded up to 1,386 ms.
Add 2,000 ms for bounded scheduling/backpressure and interrupt overhead:

- Read: `12480 + 1386 + 34 + 2000 = 15900 ms`.
- Write: two readiness polls (pre-data and programming busy), 1,462 controller
  characters including 23 acknowledgements (1,523 ms), and SPI/margin:
  `8320 + 1523 + 34 + 2000 = 11877 ms`.
- Sync: `4160 + 20 + 2000 = 6180 ms`.

Initialization remains 8,000 ms. General HTTP, mode retry, debounce, and unrelated
controller deadlines are unchanged. A protected FatFs call can contain several
sector operations; these are sector bounds, not a whole-publication deadline.
Host timing tests cover a valid read beyond five seconds and bounded missing
terminal behavior. Physical timing/interrupt stress remains an acceptance check.

## Performance evidence

Each completed cache operation emits `Cache I/O profile` with read/write request
counts, FAT sectors, first root-directory cluster sectors, other sectors, and
controller TX/RX bytes. Extended directory-chain sectors are included in
`other`; the logger does not mislabel these as file-data-only sectors.

The actual production adapter with pinned ChanFatFS on a synthetic one-product
FAT16 volume measured:

| Operation | Reads | Writes | FAT accesses | Directory accesses |
| --- | ---: | ---: | ---: | ---: |
| BEGIN | 3 | 5 | 3 | 4 |
| ITEM | 2 | 2 | 0 | 2 |
| COMMIT | 9 | 4 | 0 | 7 |

These are host-volume counts, not measurements of the physical FAT32 card.
They demonstrate metadata cost; they cannot establish the cause of its 46/10/61
second publication timings. No repeated mount or full-file validation exists in
the normal ITEM path. Per-item sync/close, CRC validation, backup recovery, and
promotion verification remain intact. No sector cache was added that could hide
a failed physical write during validation. The proven improvement is ownership
latency: publication no longer rejects foreground requests for its entire run.
The current FatFs call still must finish, so no physical sub-second latency
guarantee is claimed.

## Verification and physical acceptance

The tests use disposable host sectors and SQLite fixtures only. They cover
safe waiting/missing replies, staging/foreground interleaving, genuine storage
failure, durable overlay/append/reopen, interrupted tails and backup recovery,
read-only preview, cache promotion interlocks, exact-once receipts, and lost-ACK
retries. The production FatFs test runs 100 interleavings and reopens its disk;
the production raw SPI driver runs 100 read/write/idle/read cycles; the actual
ESP32 read/fence test runs 100 sequential/nested-request cycles and eight faults.
The durable sequence verifies 50 RESTOCK/50 CHECKOUT, each resulting stock and
sequence number, then reloads the journal without mutation.

Final host verification for this pass:

- 35 distinct firmware native executables passed, plus ownership/lifecycle
  source checks. Coverage includes RTC/TWI/LCD, scanner/controller UART,
  buttons, sector fences, storage, cache, journal, and online/offline transitions.
- 100 online admissions, 100 offline admissions, 100 cache/foreground
  interleavings, and the 50/50 durable alternating sequence passed.
- The production FatFs cursor test passed 100 interleavings and disk reopen.
  The production raw SPI test passed five fault/register scenarios and 100
  read/write/idle/read cycles. The production ESP32 read/fence test passed
  eight fault/timing scenarios and 100 sequential/nested-request cycles.
- Undefined-behavior sanitizer runs passed for the storage-link and foreground
  cache/journal tests. These do not model physical interrupt timing or AVR stack
  exhaustion.
- 514 affected desktop tests and 13 shared-protocol tests passed. TypeScript and
  ESLint passed. No desktop source was changed by this pass.
- Uno production build passed: flash 26,824 / 32,256 bytes; static SRAM
  1,313 / 2,048 bytes. ESP32 production build passed: flash
  1,131,601 / 1,310,720 bytes; static RAM 82,468 / 327,680 bytes.

The non-LTO compiler reports a 571-byte main frame. Static SRAM plus that frame
leaves approximately **164 bytes before nested calls and interrupts**, versus
178 bytes at the preceding baseline. This is dangerously tight headroom, not
a proven maximum live stack budget. Raw read/command frames measured 44/18
bytes, with additional link service/diagnostic frames and interrupt overhead.
Physical combined-load/stack measurements remain required before deployment can
be called stable. No task-stack increase or large AVR buffer was added.

Files touched by this pass (other pre-existing worktree changes are preserved):

- `firmware/src/main.cpp`
- `firmware/include/foreground_storage_priority.h`, `button_admission.h`,
  `offline_inventory_cache.h`, `offline_pending_journal.h`,
  `remote_storage_timing.h`
- `firmware-common/include/controller_link_protocol.h`,
  `storage_link_protocol.h`
- `firmware-atmega/include/physical_workflow.h`, `sd_card.h`,
  `firmware-atmega/src/sd_card.cpp`
- `firmware-atmega/tests/physical_workflow_test.cpp`, `storage_link_test.cpp`,
  `sd_raw_driver_test.cpp`, `sd_raw_driver_test.ps1`,
  `sd_register_fakes/avr/io.h`, `sd_register_fakes/util/delay.h`
- `firmware/tests/foreground_storage_priority_test.cpp`,
  `foreground_fatfs_production_test.cpp`,
  `foreground_fatfs_production_test.ps1`, `remote_storage_production_test.cpp`,
  `remote_storage_production_test.ps1`, `remote_diskio_test.cpp`,
  `remote_storage_lifecycle_test.ps1`, `offline_cache_http_service_test.ps1`
- This report: `docs/foreground-storage-stability.md`

Update **both ATmega and ESP32** together when physical testing is authorized;
the explicit WAIT response and expanded diagnostics require matching firmware.
No desktop update is required by this firmware-only pass.

1. Confirm normal RTC, SD, cache, and journal readiness without clearing records.
2. During cache BEGIN/ITEM/pre-promotion COMMIT, press a transaction button.
   Expect mode recorded/WAIT, boundary yield, normal mode acceptance, one result,
   then cache resume. No rejection solely for background bridge ownership.
3. During protected promotion, verify WAIT followed by final OK and a full scan
   window. Verify both modes and repeated requests while cache makes progress.
4. For offline interleaving, confirm the installed generation is frozen and the
   new pending event blocks staged replacement. Do not sync/retire records as
   part of this acceptance test without separate authorization.
5. If a read fails, retain the raw/trace/stream failure lines and I/O profile.
   Do not infer wiring failure or a specific R1 from a generic `SD:ERROR`.
6. Monitor stack headroom and reset behavior under combined RTC/LCD/scanner/SD
   load. Tight AVR SRAM remains a physical deployment risk, not resolved merely
   by green host tests.
