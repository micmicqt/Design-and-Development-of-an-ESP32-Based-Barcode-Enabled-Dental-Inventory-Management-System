# Phase 6 Step 2B: offline transactions and pending journal

Phase 6 Step 2B lets the ESP32 complete a one-unit RESTOCK or CHECKOUT when
the authenticated desktop-presence lease is unavailable. The operation remains
local to the kiosk: it reads the last authoritative cache, appends a durable
MicroSD journal record, and updates the LCD and LED indicators. It does not
modify Electron, SQLite, desktop movement history, or the online event FIFO.

This is transaction capture only. Phase 7 will own import, reconciliation,
idempotent synchronization, acknowledgement, and journal archival or clearing.

## Frozen online/offline route

The first accepted debounced RESTOCK or CHECKOUT button press owns the
transaction. Additional presses while the kiosk is busy remain ignored,
RESTOCK retains its established precedence for a simultaneous accepted press,
and a release is required before the next transaction.

At that acceptance boundary, firmware captures one route:

- `desktopOnline == true` selects the existing ONLINE flow.
- `desktopOnline == false` selects the new OFFLINE flow.

The captured route does not change if a heartbeat arrives or the 12-second
lease expires while the scanner is active. An offline scan never enters the
online RAM FIFO. An online scan continues through the existing desktop quantity
dialog and Phase 5 commit/result/acknowledgement flow; it is not converted to a
one-unit transaction.

The existing busy state and button-release interlock allow at most one journal
append for one accepted press-and-scan workflow. After the kiosk returns to
idle, scanning the same barcode in a later accepted workflow is a distinct
inventory movement and receives a new offline event ID.

## Immutable base plus pending overlay

`/inventory_cache.csv` remains the immutable, CRC-validated snapshot produced
from authoritative active SQLite products in Step 2A. Offline transactions do
not rewrite it. For one exact product, firmware derives usable offline stock as:

```text
current offline stock = cached base stock + all valid pending signed deltas
```

Both the cache and journal are scanned with fixed-size buffers. The complete
catalog and complete journal are not retained in RAM. Product association uses
the stable product ID, exact barcode text, and cache generation. Barcodes remain
strings: leading zeroes, case, and punctuation are not numerically parsed or
normalized.

An offline transaction requires an available LCD, mounted MicroSD card, valid
cache, readable and compatible non-full journal, usable DS3231 time, and an
exact cache match. RESTOCK adds exactly one; CHECKOUT subtracts exactly one and
is rejected when current offline stock is zero. Overflow, negative results, and
the 10,000-record journal limit are handled as errors. No quantity dialog is
involved.

The resulting status uses the same rule as the desktop:

```text
EMPTY: stock <= 0
LOW:   stock > 0 and stock <= low-stock threshold
HIGH:  stock > low-stock threshold
```

## `/pending_sync.csv` version 1

The durable journal path is:

```text
/pending_sync.csv
```

Its versioned first line binds the file to the physical ESP32:

```text
DENTAL_PENDING_SYNC,1,<12-uppercase-hex-device-id>
```

The fixed columns are:

```text
sequence,event_id,timestamp,product_id,barcode,action,delta,resulting_stock,resulting_status,cache_generation,record_crc32
```

Each successful row records:

- the durable sequence and offline event ID;
- the exact DS3231 timestamp in `YYYY-MM-DD HH:MM:SS` form;
- stable product ID and exact barcode;
- `RESTOCK` or `CHECKOUT`;
- signed one-unit delta;
- resulting offline stock and `HIGH`, `LOW`, or `EMPTY` status;
- the `v1-<SHA-256>` cache generation used as the base; and
- a CRC32 over the canonical row prefix before `record_crc32`.

CSV quoting protects text fields without changing their contents. Firmware
treats a record as committed only after the complete row (including its
terminating newline) has been appended and the resulting journal validates.

## Durable event IDs and reboot recovery

Offline event IDs have this shape:

```text
off-<12-uppercase-hex-device-id>-<16-uppercase-hex-sequence>
```

The device component comes from the ESP32 hardware identity. Firmware validates
the journal at startup, finds the greatest committed sequence, and allocates the
next value. It therefore does not reset the offline sequence to one after a
reboot, and the RTC timestamp is never used by itself as an identifier. Sequence
exhaustion is a safe error rather than a reason to reuse an ID.

Every newline-committed row is parsed and CRC-checked before it can contribute
to stock or pending count. A power loss may leave only the final row
unterminated. Firmware preserves all older valid rows and rewrites that torn
tail away through recoverable temporary and backup paths:

```text
/pending_sync.tmp
/pending_sync.bak
```

A malformed row that was newline-committed is not silently skipped or applied;
it marks the journal unavailable for offline transactions until deliberate
recovery can occur. Boot recovery retains only bounded metadata such as validity,
pending count, and next sequence rather than loading all pending rows into RAM.

## Cache replacement interlock

Pending deltas are defined relative to the cache generation recorded in each
journal row. Replacing that base before Phase 7 reconciliation would make the
overlay ambiguous. Firmware is therefore the final interlock:

- with zero pending records and a valid journal, normal Step 2A cache delivery
  can proceed;
- with one or more pending records, a different generation is rejected before
  it can replace `/inventory_cache.csv`; and
- uncertain or malformed journal state also blocks replacement safely.

An identical already-current generation requires no replacement and remains an
idempotent no-op. The desktop treats an HTTP 409 interlock response as a fixed
gateway rejection. Cache refresh is best-effort, so Add/Edit/Delete and committed
online transactions remain successful; the cache stays stale and recurring
heartbeat retries continue to use the existing 30-second cooldown. Reconnecting
Electron never deletes pending rows.

## LCD and LED behavior

A successful offline operation presents a compact 20x4 result containing the
offline mode, signed one-unit quantity, resulting stock, and status. It pulses
D1 SUCCESS, keeps D2 ERROR inactive, and persistently sets D3/D4/D5 from the
derived offline status until a later result changes the stock indication. After
the existing feedback interval, the kiosk returns to idle.

Unknown or malformed barcode, scanner timeout, zero-stock checkout, unavailable
cache, SD failure, invalid journal, RTC failure, overflow, or append failure
create no successful row and do not alter the online FIFO. Firmware shows a
concise error and pulses D2. The verified GPIO truth tables and all hardware pin
assignments remain unchanged.

## Backward-compatible status

`GET /status` preserves every earlier field and adds the paired metadata:

```json
{
  "pendingSyncItems": 3,
  "offlineReady": true
}
```

`pendingSyncItems` is the count (from zero through 10,000) of fully validated,
newline-committed journal records. `offlineReady` reports whether the LCD, RTC,
MicroSD, cache, and compatible non-full journal prerequisites are healthy;
route selection still depends separately on the captured desktop-presence
state. Firmware emits these two fields together only while journal metadata is
valid, so unavailable or corrupt journal state is never misreported as zero
pending items. Electron main accepts the pair when present and continues to
accept older firmware—or an unavailable journal—that omits both. They are not
exposed as a new renderer command or generic network capability.

The established `/health`, `/status`, `/desktop/heartbeat`, `/offline/cache`,
`/events/next`, `/events/result`, and `/events/ack` contracts remain available.

## Scope and limitations

Step 2B intentionally does not:

- import pending records into SQLite or desktop movement history;
- reconcile online changes with offline deltas;
- mark, acknowledge, delete, or archive pending records;
- refresh the base cache while unresolved deltas depend on it;
- add a sync UI, WebSocket, mDNS, cloud service, or installer; or
- replace the trusted-clinic-LAN assumption documented in Step 2A.

The pending journal is an input to the future Phase 7 synchronization protocol,
not proof that synchronization has already occurred.

## Verification

Automated tests use temporary/in-memory desktop data and host-native storage.
They exercise route capture, exact and leading-zero lookup, fixed deltas,
status parity, journal integrity and reboot recovery, prerequisite failures,
cache interlock, FIFO/transaction-file isolation, and preservation of the
online flow. They do not upload firmware, perform a physical stock transaction,
or change the real application database or MicroSD.

Run from the repository root:

```powershell
npm.cmd run test --workspace "@dental-inventory/desktop"
npm.cmd run test --workspace "@dental-inventory/protocol"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build:desktop
& "C:\Users\hp\.platformio\penv\Scripts\platformio.exe" run --project-dir firmware -e esp32dev
git diff --check
git status --short --branch
```

The firmware host scenarios in
`firmware/tests/transaction_event_queue_test.cpp` are compiled and executed
separately with an available C++17 host compiler. PlatformIO has no `native`
environment in this project; its command above verifies the real `esp32dev`
firmware build.
