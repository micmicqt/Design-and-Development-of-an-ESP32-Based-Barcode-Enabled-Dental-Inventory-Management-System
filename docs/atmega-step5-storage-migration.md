# ATmega migration Step 5: MicroSD storage bridge

Step 5 moves electrical ownership of the MicroSD module to the ATmega328P
without weakening the existing cache, journal, or synchronization model. The
ATmega drives the card over SPI; the ESP32 remains the network/protocol bridge
and runs the existing FAT/file and transaction semantics over a bounded sector
transport.

## Existing storage architecture audited

The active firmware defines these logical files; this is the repository's
complete storage set, not a claim that every file is present on an uninspected
physical card:

| Logical path | Purpose |
|---|---|
| `/integration_test.csv` | Historical integration-test CSV; preserved if present, no longer written or created by production online scans. |
| `/inventory_cache.csv` | Active authoritative inventory snapshot. |
| `/inventory_cache.tmp` | Validated cache staging file. |
| `/inventory_cache.bak` | Previous valid cache recovery copy. |
| `/pending_sync.csv` | Durable offline journal and ACK cursor. |
| `/pending_sync.tmp` | Recoverable journal replacement. |
| `/pending_sync.bak` | Prior valid journal recovery copy. |

Earlier integration tests wrote the fixed
`timestamp,barcode,action,quantity` rows to `integration_test.csv` before
publishing an online event. That legacy write could hold the online event behind
multi-second remote-sector operations and was not the authoritative record.
Production online scans now enqueue the event without opening the CSV; Electron
commits the authoritative SQLite stock/history/receipt before result delivery
and ACK. An existing CSV is left untouched. The ESP32 shows a neutral queued
message until the committed desktop result arrives; D1 success is not asserted
for the queued scan.

The cache remains the version-1 CRC32 format documented in Phase 6 Step 2A.
The pending journal remains the version-1/cursor format documented in Phases 6
and 7. Each offline row retains its monotonic device-scoped event ID, original
DS3231 timestamp, stable product identity, exact barcode, signed one-unit delta,
resulting offline stock/status, cache generation, and record CRC32. Failed
transactions create no success row. SQLite's durable reconciliation receipt is
still the exactly-once boundary; an ACK advances only the matching journal
head, and acknowledged rows compact only after the final authoritative cache
is installed.

The SD is not required for the online SQLite-authoritative workflow. Synchronous
SD recovery is deferred while desktop presence is active or an online event or
result feedback is pending, then resumes when the desktop is absent. Offline
work still requires the valid cache,
journal, RTC, and storage. Reset/power-loss recovery still validates complete
rows, trims only an unterminated tail through temporary/backup promotion, and
fails closed on a malformed newline-committed record.

Production serial output retains boot, route, event, state-transition, and
failure summaries. Successful per-sector/frame details and extended card
diagnostics are available only when `-DENABLE_VERBOSE_DIAGNOSTICS=1` is supplied
as an ESP32 build flag. A failed sector read reports a compact sector/result/
elapsed/controller summary; recovery logs its eventual READY/UNAVAILABLE
outcome. Recovery validation prints `journal=NOT_CHECKED` when cache validation
fails first, because the journal check is intentionally short-circuited. A
transient storage timeout can cause this read-only probe to fail without proving
on-card corruption; no repair or journal retirement occurs in that path.

## Physical ownership and SPI

| Function | ATmega pin | Uno pin |
|---|---|---|
| CS | PB2 | D10 |
| MOSI | PB3 | D11 |
| MISO | PB4 | D12 |
| SCK | PB5 | D13 |

PB0/PB1 status outputs are preserved with masked register writes. Initialization
uses 125 kHz SPI for initialization and raw-sector transfers.
SD v2/SDHC block addressing is supported for the established FAT32 SDXC
configuration. No format, repair, erase, or unrelated-file operation is
exposed.

ESP32 GPIO5/18/19/23 and Arduino `SD`/`SPI` calls are no longer active storage
owners. GPIO16/17 remains the 9600-baud ATmega controller link.

## Bounded storage design

A full FAT stack on the AVR was rejected after measurement: even tiny-mode
FatFs raised static AVR RAM to 1,823/2,048 bytes while the existing main-loop
frame is about 682 bytes. That would inevitably corrupt the stack.

Instead, the ATmega is a bufferless physical block server. It clocks one sector
directly between the card and fixed 24-byte controller-link chunks, never
allocating a 512-byte sector buffer. The ESP32 has sufficient memory for pinned
Chan FatFs 0.14 in tiny mode and retains the exact long filenames and existing
high-level cache/journal classes. This is not direct ESP32 SPI ownership: every
sector read, sector write, and sync crosses the ATmega-owned card interface.

The current Uno build uses 1,215/2,048 bytes of static SRAM, leaving 833 bytes
for the stack. A non-LTO `-fstack-usage` measurement reports a 562-byte `main`
frame; this leaves 271 bytes before nested calls and interrupts. Measured
examples include 51 bytes for RTC-link service, 24 bytes for its bounded queue
part, 40 bytes for storage-link service, 24 bytes for its handler, 44 bytes for
raw sector begin-read, and 42 bytes for an LCD line. Fixed LCD screen text is
stored in flash, not copied into static SRAM. There is no heap allocation or
512-byte AVR sector buffer. The stack margin is finite, and these individual
measurements are not a complete worst-case call-graph proof; physical stress
testing and renewed stack analysis are required before adding AVR features.

The explicit line frames are:

```text
SD:STATUS
SD:SYNC
SD:ABORT
SD:R:<8-hex-sector>
SD:W:<8-hex-sector>
SD:DATA:<3-hex-offset>:<up-to-24-bytes-as-hex>

SD:READY | SD:UNAVAILABLE
SD:OK | SD:ERROR
```

Every data chunk carries its expected 0-511 sector offset. Duplicate,
out-of-order, empty, oversized, or malformed chunks fail closed and abort the
active raw transfer. `SD:STATUS` and `SD:ABORT` also reset an abandoned
transfer, so an ESP32 reset or timed-out request cannot leave a later request
attached to stale sector state. Frames are fixed-size, newline-delimited, and ignored by PING/PONG, RTC,
SCAN/RESTOCK/CHECKOUT, and registration routing. Read/write deadlines are
bounded on the ESP32. The ATmega continues draining scanner RX and button state
between chunks. A storage error changes storage availability without blocking
LCD, RTC, scanner, buttons, or later controller-link recovery.

The permanent controller link remains 9600 baud, 8N1. One sector read uses one
14-byte request, 21 full 61-byte data frames, one 29-byte tail frame, and one
6-byte completion frame: approximately 1,330 bytes total, with a 1.39-second
wire-time floor including the request. One write adds a six-byte acknowledgement
for the initial request and each of 22 chunks, approximately 1,462 bytes or
1.52 seconds minimum; 9600 8N1 carries about 960 bytes per second. Both complete
sector directions use a calculated five-second deadline; write subrequests
consume the remaining whole-sector budget rather than multiplying it 22 times.
This is intentionally a conservative migration-stage transport, not a claim of
high throughput. Controller bytes, scanner bytes, buttons, RTC, and LCD are
serviced cooperatively between 24-byte chunks; no long fixed delay is used.
FatFs cannot promise a fixed sector count for a logical append: an existing
cluster normally requires file-data and directory metadata traffic, while a
cluster allocation also updates FAT sectors (and the second FAT where present).
Tiny mode's shared sector window can add reads as it changes regions. Therefore
an audit or pending-journal append is expected to take several sector
operations, not one; its actual end-to-end latency must be measured with the
physical card during the authorized verification below.

## Durability and synchronization flows

Online:

```text
ATmega scan + DS3231 timestamp
→ ESP32 online RAM FIFO (no integration_test.csv write)
→ SQLite commit → result → ACK
```

Offline:

```text
ATmega scan + DS3231 timestamp
→ exact cache lookup and pending overlay
→ CRC-complete pending row appended/synced through ATmega sectors
→ local success/status feedback
```

Synchronization remains unchanged above storage:

```text
oldest pending row → SQLite receipt/stock/history atomically
→ exact head ACK → durable cursor advance
→ repeat → zero pending → authoritative cache refresh → compaction
```

Retries keep the same event ID and original RTC timestamp. A lost ACK or restart
therefore cannot apply inventory twice. A torn sector/file operation reports an
I/O failure; existing CRC, newline, temporary, and backup recovery decides the
authoritative file on reboot.

The ESP32 also sends short advisory `FB:` controller frames for committed
RESTOCK/CHECKOUT, durably saved offline RESTOCK/CHECKOUT, scan error, and scan
dismissal. Explicit rejection of an unknown barcode attaches the fixed
`unknown_barcode` display reason to the same event-ID ACK and shows `ITEM NOT
FOUND`; other dismissal stays generic. The ATmega uses these frames only for a
brief LCD screen; they cannot arm a mode, apply stock, append a journal row, or
advance either event queue.
Online success is sent only after result acceptance, and offline success only
after the pending row is durably saved.

## Physical acceptance and repeat procedure

### Remote-storage stability pass (automated; physical retest pending)

The former sector-read waiter did not acquire `storageRequestActive`. Controller
servicing could therefore admit a button/SCAN and enter a nested RTC/storage
wait, repeatedly replacing the one completed storage response slot. A failed
read also returned without retiring the ATmega stream: the next reconstruction
could start with a valid old chunk at offset 216/240. This is a source-backed
failure mechanism, not evidence of UART electrical corruption. The historical
physical log alone cannot identify which nested call first lost the stream.

All sector waits now own the bridge; a completed response cannot be overwritten,
and SCAN continuation is deferred to the outer loop rather than recursively
entering RTC/FatFs. A failed/incomplete read requires `SD:ABORT:<8 hex digits>`
and matching `SD:IDLE:<same digits>` before any further storage request. The
ATmega finishes its current complete line, stops reading, and appends that fence
after queued old bytes. A stale DATA, SD:OK, or older IDLE cannot satisfy the
fence. The parser is not reset mid-frame. Retries are bounded; a failed fence
leaves the bridge unavailable. Read offsets still advance only after the full
line is accepted by TX, with final SD:OK after all 22 chunks. SPI timing, chunk
size, Timer1 TX behavior and all file formats remain unchanged. Both firmware
images must be updated together for this storage-only fence extension.

Journal read errors now report temporary transport unavailability rather than
CRC corruption. Failed stat/open cannot create a false empty journal. A durable
append whose verification read fails stays fail-closed until read-only recovery
resolves the installed row and sequence; recovery does not append it again.
Readonly runtime recovery validates the installed cache/journal without clearing
pending records. FULL and GENERATION_MISMATCH are admission states, not broken
SD hardware. `/status` adds `offlineJournalState`/`offlineJournalReason`; a count
is omitted while untrustworthy, never invented as zero. Healthy empty journals
report count 0/state `empty`; Sync Offline shows Ready and refreshes the preview
when authoritative health/count changes. Preview remains non-destructive.

Before boot initialization is resolved, BTN gets `BTN:INITIALIZING`, displayed
as SYSTEM INITIALIZING / PLEASE WAIT. Terminal failure releases the transaction,
frozen route/cache and barcode immediately; its short visible feedback cooldown
is diagnosed separately from ACTIVE_TRANSACTION. Offline success still requires
`JournalAppendResult::kCommitted`; SQLite receipts and ACK-only replay semantics
are unchanged.

Host verification includes actual ESP32 read/fence functions with simulated UART,
100 sequential/repeated sector reads, interruption at chunks 1/8/21/22, stale
terminals and nonzero/duplicate chunks, plus 100 alternating actual cache lookup,
overlay and durable append operations and reboot reconstruction. No physical
record was read, acknowledged, retired or synchronized during this pass.

Physical acceptance has now covered ATmega-owned raw card readiness, remote
sector reads, FAT32 mount, online and offline RESTOCK/CHECKOUT, durable pending
records across reboot, and exactly-once reconciliation. A lost-ACK retry did
not duplicate SQLite stock or history; the asynchronous retirement worker
eventually cleared the pending journal. The following is the repeat procedure,
not a claim that this documentation update accessed the physical device.

1. Do not hot-move the MicroSD module. Power off the Uno, ESP32, module, and
   peripheral rail.
2. Remove the old ESP32 SD wires only. Connect module CS to D10/PB2, MOSI to
   D11/PB3, MISO to D12/PB4, and SCK to D13/PB5. Preserve common ground.
3. Keep the verified buffered/regulator module supply arrangement from the
   working prototype (module VCC at 5 V). Confirm its level buffer remains
   between the 5 V ATmega and card signals.
4. The final controller link is D7 TX -> GPIO16 RX and GPIO17 TX -> D6 RX.
   GM65 uses D0/D1 hardware USART0; preserve D2/D3 buttons, A4/A5 LCD+RTC
   and all status outputs unchanged.
5. Before an authorized Uno upload, isolate GM65 wires from D0/D1 if needed;
   upload normally on COM10, then reconnect them. Upload ESP32 separately. Verify the
   Uno does not reset/crash and ESP32 reports `MicroSD initialization: SUCCESS -
   ATmega owned`, a valid cache/journal state, and compatible `/status` fields.
6. With Electron active, verify one separately authorized online transaction:
   original RTC timestamp, FIFO/modal, SQLite result, result
   feedback, and ACK. Confirm no duplicate row/event.
7. Close Electron until `desktopOnline:false`, then verify separately authorized
   RESTOCK and CHECKOUT operations append distinct pending rows, retain exact
   barcodes/timestamps, reconstruct stock/status, and do not enter the online
   FIFO or SQLite.
8. Reset each controller separately and then perform a controlled full power
   cycle. Confirm cache generation, pending count, FIFO head, event IDs, and
   effective stock recover unchanged.
9. Reconnect Electron and run the existing parameter-free Sync Offline flow.
   Verify exact-once SQLite application, ordered ACK retirement, zero pending,
   final cache refresh, and compaction. Never remove the card while powered or
   while a write may be active.
