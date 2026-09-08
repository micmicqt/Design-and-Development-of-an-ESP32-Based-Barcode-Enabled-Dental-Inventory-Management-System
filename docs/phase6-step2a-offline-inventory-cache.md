# Phase 6 Step 2A: offline inventory cache

This step gives the ESP32 a durable, last-known snapshot of active inventory
while the authenticated desktop application is available. The desktop SQLite
database remains authoritative. The cache does not yet enable offline RESTOCK
or CHECKOUT, change stock, create `pending_sync.csv`, reconcile movements, or
write anything back to SQLite.

## Authoritative snapshot and trust boundary

Electron main builds the snapshot from `InventoryService.listProducts()`, whose
repository query excludes soft-deleted products. The renderer cannot supply
cache rows, a destination URL, or generic HTTP options. React continues through
the frozen preload and authenticated, trusted-main-frame IPC; the backend alone
uses the configured `HardwareGateway`.

Each active row contains the stable SQLite product ID as decimal text, exact
barcode text, item name, category, current stock, low-stock threshold, and the
existing derived `HIGH`, `LOW`, or `EMPTY` status. Products are ordered by ID.
Leading zeroes, case, punctuation, and Unicode in valid barcode text are not
converted or numerically normalized.

The generation has this form:

```text
v1-<64 lowercase SHA-256 hexadecimal characters>
```

It is the SHA-256 digest of a deterministic versioned JSON representation of
the ordered rows. Unchanged cache content therefore keeps the same generation;
any cached field change produces a different generation.

## Bounded transfer protocol

Electron installs a snapshot through the fixed backend-only route:

```http
POST /offline/cache
```

The transfer is sequential and bounded rather than one large inventory JSON
document:

1. `begin` declares the generation and product count.
2. One `item` request sends one indexed product.
3. `commit` requests validation and installation after every item is durable.

The firmware limits the count, JSON body, fields, and per-row buffers. Every
`begin` whose generation is not already installed recreates staging from index
zero, including a repeated `begin` for the same interrupted generation. It
never trusts an unverifiable staged prefix left by an earlier runtime. This may
resend bounded items after a failure, but the prior active cache remains
untouched. Repeated identical item requests within the current transfer and an
already-installed generation are idempotent.

## MicroSD representation and atomic recovery

The active cache is stored separately from the Phase 3/5 transaction log:

```text
/inventory_cache.csv
/inventory_cache.tmp
/inventory_cache.bak
```

The CSV starts with format-version, generation, and count metadata, followed by
a fixed column header, one quoted product row per item, and a CRC32 trailer.
Quoted CSV escaping preserves commas and quotation marks. The desktop rejects
duplicate product IDs or barcodes before transfer. Firmware commit reparses
every row and checks stock/status consistency, count, generation metadata, and
checksum before promotion.

Installation uses a recoverable swap:

1. Write and validate `/inventory_cache.tmp` without changing the active file.
2. Preserve a valid active file as `/inventory_cache.bak`.
3. Promote the validated temporary file to `/inventory_cache.csv`.
4. Revalidate the promoted file and leave the previous valid active generation
   at `/inventory_cache.bak` as a recovery copy.

An incomplete transfer leaves the previous valid active cache intact. If power
or a filesystem error interrupts replacement, boot recovery validates the
active, completed temporary, and backup copies. A valid active file always wins;
otherwise a completely validated temporary file can finish promotion, and a
valid backup is moved back to the active path when it is the remaining recovery
source. A failed recovery does not advertise an unusable active cache as
available.

## Refresh and boot behavior

The first successful authenticated desktop heartbeat requests an initial cache
refresh. Later successful heartbeats consult coordinator state but do not
rebuild or resend a current snapshot. Successful Add, Edit, Delete, online
RESTOCK/CHECKOUT, and transaction-recovery operations request an authoritative
refresh after the existing operation settles.

Concurrent signals are coalesced, with one trailing snapshot when inventory
changes during a transfer. Background failures remain best-effort and cannot
change a successful inventory IPC result. Automatic heartbeat retries observe
a cooldown, avoiding a full transfer attempt every four seconds when the ESP32
or MicroSD remains unavailable; a new authoritative mutation can request an
immediate retry.

At startup, the existing MicroSD mount runs first. Firmware validates the cache
stream and retains only its availability, generation, and item count in RAM; it
does not load the full catalog. A valid cache therefore survives ESP32 reboot
without a mandatory resend.

`GET /status` retains every existing field and adds:

```json
{
  "offlineCacheAvailable": true,
  "offlineCacheGeneration": "v1-...",
  "offlineCacheItems": 27
}
```

When unavailable, generation is `null` and item count is zero. The desktop
gateway accepts both the extended response and legacy Phase 5/6.1 status
responses with none of these optional fields. Cache metadata is not a new
renderer command or generic preload capability.

## Phase 5 and hardware isolation

Cache code does not enqueue, inspect, apply, acknowledge, or dequeue transaction
events and does not append to `integration_test.csv`. The established online
ordering remains:

1. SQLite stock/history/processed-event commit.
2. `POST /events/result`.
3. Durable result-delivered marker.
4. `POST /events/ack`.
5. ESP32 FIFO advance.
6. Best-effort cache refresh after the Phase 5 coordinator settles.

The `/health`, `/status`, `/events/next`, `/events/result`, `/events/ack`, and
`/desktop/heartbeat` contracts remain compatible. LCD/LED feedback, RTC, GM65,
MicroSD transaction logging, 115200 upload/monitor speed, and all verified GPIO
mappings are unchanged.

## Local-LAN trust limitation

This step does not add HTTP authentication or transport encryption to the ESP32
route. The ESP32 and desktop must remain on a trusted, isolated clinic LAN; do
not port-forward or expose the device to the public Internet. Administrator
authentication protects the renderer-to-main IPC boundary, but it does not
authenticate arbitrary devices already able to reach the ESP32 on that LAN. A
future device-token or mutually authenticated transport remains separate work.

## Verification

Automated verification uses in-memory or temporary desktop databases and a
host-native MicroSD adapter. It does not upload firmware, install a physical
cache, or perform an offline transaction.

Run from the repository root:

```powershell
npm.cmd run test --workspace "@dental-inventory/desktop"
npm.cmd run test --workspace "@dental-inventory/protocol"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build:desktop
& "C:\Users\hp\.platformio\penv\Scripts\platformio.exe" run --project-dir firmware
git diff --check
git status --short
```

The host-native firmware scenarios are compiled separately with an available
C++17 host compiler from `firmware/tests/transaction_event_queue_test.cpp`.
There is intentionally no PlatformIO `native` environment or `pio test -e
native` command in this project; the PlatformIO command above verifies the real
`esp32dev` firmware build.

### Physical Step 2A checkpoint

The real ESP32 and MicroSD completed the bounded cache installation, retained
the installed generation across an ESP32 reboot while Electron was closed, and
recognized the identical generation after Electron reconnected without another
full installation. The application database, movement history, processed-event
receipts, transaction CSV, and event FIFO remained isolated from this test.

On the first startup immediately after the verification upload, one MicroSD
mount attempt did not succeed. A single EN reset, without changing firmware or
wiring, restored the existing initialization path and the card mounted normally
on attempt 1. The behavior was not reproducible as an implementation defect, so
no runtime change was made solely for that isolated occurrence.

The production inventory had no active barcode beginning with zero, so physical
leading-zero verification was unavailable; automated exact-string coverage was
used for that case. Destructive cache-corruption, interrupted-write, and backup
recovery scenarios likewise remained host-native tests to avoid altering the
production MicroSD contents.
