# Phase 7 Step 3: safe offline synchronization completion

Phase 7 Step 3 completes the local-network synchronization loop without giving
the React renderer control over event identity, stock values, URLs, or HTTP
methods. Electron processes the ESP32's durable journal strictly oldest first:

```text
GET oldest event
→ atomic SQLite reconciliation (or exact durable replay)
→ POST exact head acknowledgement
→ durable device retirement
→ repeat
→ verify pending count is zero
→ install a fresh authoritative SQLite cache
```

The existing Phase 7 Step 2 receipt remains the database idempotency boundary.
An event is never acknowledged before SQLite returns either `APPLIED` or
`ALREADY_APPLIED`.

## Offline acknowledgement protocol

Electron main uses the fixed endpoint:

```http
POST /offline/events/ack
Content-Type: application/json

{"eventId":"off-A1B2C3D4E5F6-0000000000000001"}
```

A successful response is strictly validated:

```json
{
  "acknowledged": true,
  "eventId": "off-A1B2C3D4E5F6-0000000000000001",
  "pendingSyncItems": 5,
  "alreadyAcknowledged": false
}
```

On the current ATmega-backed MicroSD path, the ESP32 first validates the exact
FIFO head and returns HTTP 202 with
`{"acknowledged":false,"processing":true,"eventId":"..."}`. This means
retirement was scheduled, **not** durably completed. One lower-priority worker
owns the journal and controller UART until the existing rewrite/verification
finishes. During that work, `/status` and `/desktop/heartbeat` remain served;
`GET /offline/events/next` returns a fast `offline_ack_in_progress` error
instead of reading FatFs concurrently. A duplicate ACK for the same ID gets
the same in-progress response; another ID is rejected. After durable success,
the normal HTTP 200 acknowledgement and last-retired replay receipt apply.
Electron confirms an in-progress or response-lost ACK only when the exact FIFO
head advances (or an empty head agrees with a zero pending count). A failure
keeps the event pending for ACK-only retry; SQLite is never reapplied.

The firmware accepts only the exact unacknowledged FIFO head. Malformed,
unknown, or later IDs do not change the journal. Online `/events/ack` and its
Phase 5 result-before-ACK workflow remain separate.

## Durable retirement and retry safety

`/pending_sync.csv` remains a bounded, CRC-protected journal. Its versioned
metadata includes a durable acknowledged-prefix cursor and a bounded
last-retired receipt. A successful ACK advances the cursor by exactly one and
atomically promotes the replacement journal through the existing temporary and
backup-file recovery path.

Acknowledged prefix rows remain physically available as an offline stock
overlay until the post-sync authoritative cache is accepted. This prevents a
partial synchronization from changing the kiosk's effective stock if the
desktop disconnects before draining the journal. `pendingSyncItems` and
`GET /offline/events/next` expose only rows after the cursor.

After the device accepts the final authoritative cache, it atomically compacts
the acknowledged prefix. The bounded last-retired receipt remains so a retry
after a lost HTTP response or reboot can prove that the immediately preceding
event was already retired without consuming the new head.

Power interruption during retirement recovers to one safe state: either the old
head remains pending, where the SQLite receipt prevents a second mutation, or
the cursor has durably advanced and the next event is the head. Recovery never
skips or reorders an unrelated row.

## Desktop synchronization coordinator

The authenticated IPC method is parameter-free:

```ts
window.desktopApi.hardware.synchronizeOfflineInventory()
```

Electron main owns each fetch, reconciliation, event ID, acknowledgement, and
cache transfer. A single-flight guard and bounded loop prevent overlapping or
unbounded synchronization jobs.

For each event:

1. fetch and strictly validate the current firmware head;
2. run the existing atomic SQLite reconciliation;
3. stop without ACK on a typed conflict or database failure;
4. ACK only an `APPLIED` or `ALREADY_APPLIED` event;
5. verify ambiguous ACK transport failures by re-reading the authoritative
   head; and
6. proceed only after the acknowledged event is no longer the head.

The important Step 7.2 waiting state is therefore safe: if SQLite already has
the durable receipt while firmware still exposes the event, reconciliation
returns `ALREADY_APPLIED` and the coordinator performs ACK-only recovery.

If a commit succeeds but ACK cannot be confirmed, the outcome is
`ACKNOWLEDGEMENT_PENDING`. A retry reads the same durable receipt and performs
no second stock or history mutation. If firmware retired the event but the HTTP
response was lost, the changed/empty head proves forward progress and the
coordinator continues.

## Final cache refresh

The immutable cache interlock remains active while any unacknowledged journal
record exists. Only after `GET /offline/events/next` is empty and a fresh
`/status` reports `pendingSyncItems: 0` does Electron build a snapshot from
current SQLite and use the existing bounded `begin` → `item` → `commit`
transfer.

A failed final transfer produces `CACHE_REFRESH_FAILED`. Retired events stay
retired and durable SQLite receipts stay unchanged. The next parameter-free
attempt sees no journal head and retries the cache only. The UI reports
**Sync Complete** only when reconciliation, retirement, zero-count
verification, and authoritative cache installation all succeed.

## UI and security outcomes

The Sync Offline page distinguishes:

- active sequential synchronization;
- a blocking conflict whose FIFO head was not skipped;
- committed inventory awaiting device acknowledgement;
- fully retired transactions awaiting only cache refresh; and
- complete synchronization with applied, replayed, and acknowledged counts.

Preload exposes only the fixed, frozen capability. Trusted-main-frame and
administrator-session checks remain required in Electron main. Renderer code
cannot choose an event ID, submit stock data, execute SQL, or issue arbitrary
network requests.

## Verification boundary

Automated tests use mock gateways, temporary SQLite databases, and synthetic
MicroSD files. They cover new and already-applied events, ordering, conflicts,
database and ACK failures, lost responses, restart-safe replay, multi-event
FIFO draining, final-stock cache generation, cache-only retry, strict IPC
security, journal retirement, CRC recovery, and injected power-loss stages.
Development and automated verification do not connect to or alter the six
pending transactions retained on the physical ESP32.
