# Offline production identity, sequencing and feedback pass

No COM port, device endpoint, upload, physical ACK/synchronization, staging,
commit or push was used. The real database was opened only read-only/query-only
to select the specifically authorized historical receipt. No real migrations,
inventory changes or receipt changes were performed. Physical pending records
remain untouched; their current count was not queried.

## Evidence and legacy identity lifecycle

The historical SQLite receipt for `off-148CE50D5020-0000000000000001` contains:

| Field | Historical receipt | Current payload supplied by operator |
| --- | --- | --- |
| timestamp | 2026-09-09 20:49:59 | 2026-10-07 01:07:22 |
| productId | 3 | 4 |
| barcode | 4806016001569 | 9556006060346 |
| action / delta | RESTOCK / +1 | RESTOCK / +1 |
| cached resulting stock / status | 3 / LOW | 11 / HIGH |
| cache generation digest | 2cc1fb7e970b64ce9edcfb33b47e15a15cb8e525d63df350538a907a3f8e0283 | 8961a6920fc3599a559b52560e4044bb9beec9712dcc4b9f45d46f95892c4362 |

Both generations have the `v1-` prefix. Historical transaction ID is
`c08f4a13-2279-4cce-b819-c562683a4c9d`; it is not removed or rewritten.

The old next ID was the stable device ID plus journal maximum sequence + 1.
Boot validation reconstructs that maximum. ACK retains rows and an ACK cursor;
compaction retains the compacted/ACK floor, so an empty **compacted** journal does
not reset it. Recovery chooses valid active/temp/backup data and its floor.
However, with no surviving journal/temp/backup, `loadOrCreate` writes an empty
journal with floor zero. Its next sequence is 1 again. SQLite receipts survive
that recreation. Reboot/reflash alone does not erase the SD journal; the exact
historical action that lost/reset all sequence-bearing files cannot be established
from the available logs. The source reset mechanism and reuse are independently
covered by deterministic fixtures, not inferred from a button/transport failure.

## Corrected allocator

Wire format remains `off-<12 uppercase hex device>-<16 uppercase hex sequence>`;
capacities, existing physical records and CSV schema are unchanged. Corrected
sequences start at `8000000000000000`, disjoint from practical legacy sequences.
Before a row body is written, ESP32 Preferences/NVS namespace `offline-id`, key
`high-water`, reserves `max(durable high-water, recovered journal floor) + 1`
(or the namespace's first value), commits it and verifies an exact uint64 readback.
NVS failure/invalid type/range/exhaustion fails closed. A failed/torn append burns
a reservation; strictly increasing gaps are allowed only in the corrected
high-bit namespace. Legacy sequence-contiguity validation remains unchanged.

The allocator is independent of SD files, cache generation, ACK and compaction.
Normal resets and firmware uploads preserve NVS. **Do not factory-erase the NVS
identity and all SD sequence history together**: no deterministic counter can
remember an identity after every durable copy has been destroyed. Preserve the
identity partition for deployment/recovery; total identity erasure requires a
separate device re-enrollment procedure, not reuse of this device's old receipts.

Tests generate 10,000 unique reservations, reconstruct the allocator repeatedly,
reset journal floors, and inject write/readback/type/range/exhaustion failures.
Actual journal tests cover reboot, complete retirement, empty compaction,
recreation, backup/temp recovery, cache-generation replacement and a torn append
followed by a non-reused reservation.

## Legacy collision compatibility / migration 007

Canonical SHA-256 encodes the versioned fixed-order tuple of wire event ID,
RTC timestamp, normalized numeric product ID, exact barcode, action, signed
delta, cached stock/status and cache generation. Barcode bytes are not trimmed.
Migration 007 adds strict `offline_event_identities`: receipt key, wire event ID,
full fingerprint, NORMAL/LEGACY_COLLISION kind, unique `(wire ID, fingerprint)`.
Existing receipts are fingerprinted without changing their rows or movements.

Same wire ID + same full payload returns its prior durable receipt, including
after reopen and after later collisions. A different payload is compatible only
for a lower-half legacy ID, a strictly later valid RTC timestamp than the latest
known payload of that ID, and all ordinary event/product/barcode/action/delta/
active-product/nonnegative-current-stock validation. Same-time/older changed
payloads and every changed corrected high-bit ID remain hard conflicts. This is
an explicit migration policy, **not** a claim that timestamps authenticate data
or distinguish every conceivable corruption. An ambiguous clock rollback stops
for operator investigation rather than applying automatically.

A compatible payload receives deterministic internal receipt key
`lc-<first 60 fingerprint hex characters>` (fits the existing 63-byte key bound);
the full hash and original wire ID remain stored. A truncated-key collision fails
on the receipt PK and rolls back; it never silently aliases another payload.
Returned receipts retain the original wire ID for the physical FIFO ACK.
Stock changes by **current SQLite stock + signed delta**, never cached stock.
Stock/history/receipt/fingerprint mapping commit atomically before ACK. History
and original receipt are preserved; mapping insertion failure rolls everything
back. The renderer still supplies no event payload. The backend fetches the head.

This provides a tested path for the operator's existing legitimate legacy
records, but they have **not** been applied, ACKed or retired in this pass.

## Publication and sync sequencing

Previously heartbeat/reconnect and post-inventory-commit cache signals could call
installation despite a known pending journal; the firmware interlock rejected
them with 409. Every real cache coordinator now requires a **fresh getStatus**
before publication. Unknown/nonzero pending count or QUEUED/RUNNING/VERIFYING
retirement defers publication, leaves refresh required, and applies the existing
30-second automatic retry cooldown. No cache POST is sent for those states.
Expected deferral is not logged as a failed inventory commit. The firmware
interlock remains the final race protection if a new record arrives after status.

Two-record order remains fetch 1 -> fingerprint -> atomic SQLite COMMIT -> ACK 1
-> retirement confirmation -> fetch 2 -> COMMIT -> ACK 2 -> confirmation -> fresh
empty count -> one authoritative publication. A heartbeat/final-sync overlap
coalesces an identical snapshot; a genuinely changed generation still gets a
trailing publication. Lost ACK recovery never repeats a stock/history mutation.
Existing typed conflict/journal/last-known renderer behavior is retained.

## Physical latency evidence and bounded improvement

Operator-supplied successful event 3 timing (2026-10-07 03:06:23):
RTC 45 ms, lookup 0, overlay 0, calculation 1, append/readback 31,369 ms,
total 31,415 ms; 18 physical reads, 4 writes, 0 fences.
FatFs OPEN_READ 9,740 ms, OPEN_WRITE 11,132 ms, READ 1,393 ms,
WRITE 2,782 ms, SYNC 6,322 ms, CLOSE 0. These inclusive stages nearly cover
the whole append. They identify filesystem/remote-sector work, not RTC or stock
calculation, as the bottleneck in this sample. They do not prove a full 60-second
sample or establish the physical card's complete directory layout.

The earlier host model used a small FAT16 directory. A new real-ChanFatFS FAT32
fixture with ten directory sectors reproduces cache churn: eight slots require
37-39 append reads and modeled 58.2-67.4 seconds. Sixteen fixed read-through slots
reduce that fixture to 16-18 reads and modeled 28.8-38.0 seconds. Writes remain
physical, both body/newline flushes remain, and every written sector is invalidated
before durable readback. Cache is cleared at transaction entry/exit and I/O failure.
This is a bounded 4,160-byte ESP32 increase, no ATmega sector buffer and no SD
format change. It does not prove that the physical layout has the same cache churn.

Five samples for each initial journal size; nearest-rank p95 is the max:

| Initial pending | FAT16 min / median / p95 / max (seconds) | FAT32 min / median / p95 / max |
| ---: | --- | --- |
| 0 | 13.4 / 14.8 / 22.4 / 22.4 | 28.8 / 28.8 / 38.0 / 38.0 |
| 2 | 14.8 / 14.8 / 22.4 / 22.4 | 28.8 / 28.8 / 38.0 / 38.0 |
| 10 | 14.8 / 14.8 / 22.4 / 22.4 | 28.8 / 28.8 / 38.0 / 38.0 |
| 50 | 14.8 / 14.8 / 22.4 / 22.4 | 28.8 / 28.8 / 38.0 / 38.0 |
| 100 | 14.8 / 14.8 / 22.4 / 22.4 | 28.8 / 28.8 / 38.0 / 38.0 |

Models use 1.4 s/read and 1.6 s/write; they omit real CPU, NVS, card pauses and
LCD/link service. They are not physical promises. Larger directories can exceed
the fixed cache, and cluster/FAT allocation still costs real writes. No successful
response was changed to wait for a timeout; no UART baud/SPI/retry budget changed.

Timing now separately measures append readback, deferred-admission/queue WAIT,
bridge-fence retry attempts, and transport read/write/sync/fence elapsed times.
`OFFLINE TX TRANSPORT` explicitly prints `rawRetries=not_reported`: successful
SD replies do not carry internal ATmega CMD17 retry counts. Failure diagnostics
already preserve raw trace attempts. This avoids treating bridge retries zero
as proof of zero card retries. Readback is included in append; transport/FatFs
timings are nested inclusive counters and must not be summed as independent work.

## LCD feedback and memory

Short advisory `LCD:P:R` / `LCD:P:C` headers enable PROCESSING on ATmega immediately,
even before the following bounded rows. `LCD:<0..3>:<up to 20 printable chars>`
carries display-only rows. No new transaction/ACK or stock calculation exists.
ESP32 queues processing before RTC/FatFs and does not wait for an LCD ACK.
The existing complete-line transport services rows cooperatively. Display remains
PROCESSING while durable work continues. Only `kCommitted` queues the saved result;
failed accepted barcodes queue concrete error rows instead, never SAVED.

```text
OFFLINE RESTOCK       RESTOCK SAVED
PROCESSING...        Composite Resin
9556006060346        STOCK: 11 HIGH
PLEASE WAIT          9556006060346
```

CHECKOUT uses corresponding action labels. Product name comes from the existing
validated transaction cache product; there is no second SD name lookup. Names and
barcodes clip to 20 columns with trailing `~` when truncated; original stored data
is unchanged, including leading zeroes. Non-ASCII UTF-8 display characters map
to `?` without splitting sequences. Maximum numeric stock uses compact `H/L/E`
if the full status cannot fit. Success/error holds 2.5 seconds; missing result rows
cannot leave a finite result stuck permanently. Processing lasts until terminal
feedback. LCD failure never gates scanner/RTC/storage/controller work.

ATmega retains only 4 x 20 display bytes and bounded parser metadata. WorkflowScreen
is long-lived static rather than a larger main-stack object. AVR headers/default
processing text remain flash-resident. Production SRAM is 636/2048, flash
25,938/32,256. Non-LTO main frame is 549; production LTO main is 569 bytes including
saved registers/return PC. Existing disassembly call-graph estimate: foreground
637 + largest non-nested ISR 19 = 656 bytes; remaining estimate 756 bytes. This is
not a measured physical stack watermark or a formal exhaustive bound.

## Verification / deployment boundary

- Affected desktop pass: 759 tests across 31 files; final cache/integration rerun
  20/20 after making fresh status mandatory. Migration/backfill, legacy duplicates,
  multiple reuses, different product, strict future conflicts, atomic rollback,
  reopen/replay and lost-ACK sequencing are included.
- Shared desktop protocol: 13/13. TypeScript, ESLint, Electron production build pass.
- Native firmware regression: 33 executables, plus event/cache/journal/RTC fixture
  98 scenarios and 100 alternating durable events. Allocator: 10,000 reservations
  and failure checks. LCD: 18 bounded layouts plus immediate processing, malformed
  rows, incomplete-result expiry, parser recovery and terminal errors; host UBSan
  and AVR flash-access variants pass.
- Literal production FatFs: 100 interleaving/cursor/reopen cycles; remote read/fence:
  8 fault/timing cases + 100 cycles; actual RawCard SPI: 5 cases + 100 cycles.
  FAT16/FAT32 latency fixtures: 50 measured appends plus reopen/ambiguous-write/ACK
  preservation tests, UBSan. Existing memory text/date/time/ownership checks pass.
- ESP32 production build: RAM 104,860/327,680 (32.0%), flash
  1,141,461/1,310,720 (87.1%). Uno production build passes with figures above.

Rebuild/deploy the Electron application and **both controllers** together for the
new LCD protocol and identity allocator. Installer packaging is not part of this
pass. Do not erase NVS or pending files. Physical display, preserved legacy sync,
future identity after reset/recreation and measured timing remain user-controlled
acceptance work. No physical latency improvement or record retirement is claimed.

## Files changed by this pass (not the whole pre-existing dirty worktree)

- Desktop: migrations/index.ts; new 007-offline-event-identities.ts;
  inventory/inventory-service.ts; new offline-event-identity.ts;
  hardware/offline-inventory-cache.ts; ipc/register-hardware-handlers.ts.
- Desktop tests: database/database.test.ts; new offline-event-identities.test.ts;
  inventory/offline-reconciliation-service.test.ts;
  hardware/offline-inventory-cache.test.ts; hardware/offline-sync-integration.test.ts.
- ESP32: include/offline_pending_journal.h; new include/offline_event_sequence.h;
  src/main.cpp; src/remote_diskio.cpp.
- Shared: controller_link_protocol.h; new offline_display_feedback.h.
- ATmega: include/lcd_display.h; include/ping_client.h; src/main.cpp;
  new tests/offline_display_test.cpp.
- ESP32 tests: transaction_event_queue_test.cpp; new offline_event_sequence_test.cpp;
  foreground_fatfs_production_test.cpp; remote_storage_production_test.cpp;
  offline_latency_production_test.cpp; remote_diskio_test.cpp;
  new offline_feedback_source_test.ps1.
- Documentation: this file and offline-production-performance.md.
