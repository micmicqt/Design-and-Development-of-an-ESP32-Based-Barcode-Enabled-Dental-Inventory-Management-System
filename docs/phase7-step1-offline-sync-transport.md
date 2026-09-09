# Phase 7 Step 1: bounded offline sync transport

Phase 7 Step 1 adds a non-destructive path for the authenticated Electron
backend to inspect one durable offline transaction at a time. It is transport
only: retrieval does not update SQLite, create movement history, acknowledge an
event, or remove anything from `/pending_sync.csv`.

## Fixed endpoint and response

Electron main uses one fixed firmware route:

```http
GET /offline/events/next
```

The response is deliberately bounded:

- `204 No Content` means that no pending offline transaction exists.
- `200 OK` returns one validated JSON record: the oldest logical transaction in
  the authoritative journal.
- `503 Service Unavailable` reports unavailable journal storage.
- `500 Internal Server Error` reports an invalid authoritative journal. It is
  not reported as empty, and committed corrupt data is not skipped.

The route never acknowledges, advances, archives, truncates, replaces, or
rewrites the journal. Existing `/health`, `/status`, `/desktop/heartbeat`,
`/offline/cache`, `/events/next`, `/events/result`, and `/events/ack` behavior is
unchanged.

## Pending-event contract

The `200` body maps to the shared desktop type `OfflinePendingEvent`:

| Field | Meaning |
| --- | --- |
| `eventId` | Durable offline synchronization identity. |
| `timestamp` | RTC value captured as `YYYY-MM-DD HH:MM:SS`. |
| `productId` | Stable product ID represented as decimal text. |
| `barcode` | Exact barcode string, including leading zeroes. |
| `action` | `RESTOCK` or `CHECKOUT`. |
| `delta` | Signed integer `+1` for RESTOCK or `-1` for CHECKOUT. |
| `resultingStock` | Effective offline stock after the recorded delta. |
| `stockStatus` | Resulting `HIGH`, `LOW`, or `EMPTY` status. |
| `cacheGeneration` | The `v1-<SHA-256>` inventory-cache generation used as the base. |

The desktop validates every field and the relationships between action and
delta before exposing a record. In particular, it never parses a barcode as a
number. `eventId`, rather than timestamp or barcode, is reserved as the durable
identity for later idempotent synchronization.

## Oldest-first and repeated reads

Firmware scans the versioned CSV journal from the beginning with fixed-size
buffers and returns the first complete validated row after the header. It does
not deserialize the full journal into RAM.

Reading is stable and non-destructive. Given `event1`, `event2`, and `event3`,
successive requests return `event1` until a future protocol explicitly
acknowledges it. A reboot or complete power loss does not change which record is
oldest: the same recovered authoritative journal produces the same `event1`.
Retrieval neither changes `pendingSyncItems` nor writes the active, temporary,
or backup journal files.

Existing CRC validation, newline-commit rules, torn-tail recovery,
active/backup recovery, monotonic sequence recovery, cache-generation binding,
and exact-text CSV parsing remain the authority. A committed malformed row
causes retrieval to fail rather than silently selecting a later row.

## Desktop and security boundary

The only renderer-visible capability added for this step is parameter-free:

```ts
window.desktopApi.hardware.getNextOfflineEvent()
// Promise<IpcResult<OfflinePendingEvent | null>>
```

The call follows the established boundary:

```text
React -> frozen preload -> authenticated/trusted IPC -> Electron main
      -> HardwareGateway -> fixed ESP32 route
```

The renderer cannot provide an event payload, URL, HTTP method, ESP32 address,
acknowledgement, or file operation. Electron main maps `204` to a successful
`null` result, maps a strictly valid `200` body to a successful
`OfflinePendingEvent` result, rejects malformed bodies as protocol errors, and
treats timeout or network failure as harmless and retryable. The retrieval
handler does not call an inventory service or open the SQLite database.

`/status` remains the source for the optional `pendingSyncItems` and
`offlineReady` summary only. Transaction contents always come from
`/offline/events/next`.

## Renderer behavior

The existing **SYNC OFFLINE** page is a read-only transport preview. On entry it
can show the reported pending count, offline-journal readiness, and the one
oldest validated pending record. It explicitly states that synchronization was
not executed and that the record remains unapplied, unacknowledged, and pending
on the ESP32. There are no apply, synchronize, acknowledge, delete, archive, or
clear controls in Step 7.1.

## Deferred work

Phase 7 Steps 2 and 3 remain responsible for all state-changing behavior,
including:

- idempotent SQLite application and movement-history creation;
- durable processed-event receipts;
- conflict and cache-generation reconciliation;
- firmware acknowledgement and safe retirement or archival; and
- authoritative cache refresh after pending records are resolved.

The six physical pending records retained after Phase 6 Step 3 are intentionally
untouched by automated development. Step 7.1 tests use host-native temporary
storage and mocked HTTP/IPC boundaries; they do not upload firmware, contact the
physical ESP32, open the real SQLite database, or execute a real synchronization.
