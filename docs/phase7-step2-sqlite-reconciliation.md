# Phase 7 Step 2: SQLite offline reconciliation

Phase 7 Step 2 applies at most one oldest pending ESP32 transaction to the
authoritative SQLite inventory. The operation is atomic and idempotent: a new
event changes stock and creates movement history once, while an exact replay
returns its durable receipt without changing either again.

This step does not acknowledge or retire the device record. Firmware
acknowledgement is reserved for Phase 7 Step 3, so the same FIFO head remains
visible after local application.

## Bounded workflow

The authenticated **SYNC OFFLINE** page first uses the Step 7.1 read-only
preview. Its only state-changing control invokes a parameter-free preload
capability:

```ts
window.desktopApi.hardware.reconcileNextOfflineEvent()
// Promise<IpcResult<OfflineReconciliationOutcome>>
```

Electron main performs the complete operation:

1. verify that the IPC sender is the trusted main frame and the administrator
   session is authenticated;
2. serialize the request with other hardware inventory mutations;
3. fetch the current authoritative FIFO head from the fixed
   `GET /offline/events/next` firmware route;
4. validate the event again at the inventory-service boundary; and
5. atomically apply it to SQLite or return its existing receipt.

The renderer supplies no event body, event ID, barcode, product ID, stock
total, URL, HTTP method, database statement, or acknowledgement. This prevents
a stale preview or arbitrary renderer input from selecting a mutation target.

## Authoritative stock composition

The journal's `resultingStock` and `stockStatus` describe the ESP32's offline
view: its installed cache snapshot plus offline deltas known to that device.
They are retained in the durable receipt as `offlineResultingStock` and
`offlineStockStatus` for audit and exact-replay comparison. They are never
written into the product row as an absolute total.

For a new event, SQLite computes:

```text
authoritative new total = current SQLite stock + signed offline delta
```

`RESTOCK` has delta `+1`; `CHECKOUT` has delta `-1`. Status is derived again
from the resulting SQLite total and the product's current low-stock threshold.
This composes intervening desktop changes with the offline movement instead of
overwriting them with a potentially stale cached value.

The successful receipt therefore keeps both views:

- `previousStock`, `newTotal`, and `status` are authoritative SQLite values;
- `offlineResultingStock` and `offlineStockStatus` are firmware audit values;
- the event identity, timestamp, product identity, action, delta, and cache
  generation are retained for exact replay checking; and
- the transaction ID, item name, and category identify the immutable movement
  snapshot created by the local commit.

## Atomic commit and durable idempotency

Database migration 5 adds the strict `offline_reconciliation_receipts` table.
Its primary key is the durable firmware `event_id`; its transaction foreign key
links to one immutable `transactions` row whose source is `OFFLINE`.

For a first application, one SQLite transaction:

- confirms that the product is active and that its numeric ID and exact barcode
  identify the same row;
- checks checkout underflow and safe-integer overflow;
- updates the product from its current stock;
- inserts one quantity-one `RESTOCK` or `CHECKOUT` movement; and
- inserts the offline reconciliation receipt.

All changes commit together or roll back together. A failure cannot leave a
stock update without its movement and receipt.

Before changing inventory, the service looks up `event_id`. If all original
event fields match the stored receipt, it returns `ALREADY_APPLIED` with the
durable authoritative result. It does not update stock, insert another movement,
or replace the receipt. If the same ID is paired with different event content,
it returns an event-ID conflict without mutating inventory.

The receipt survives application restart and database reopen, so retry safety
does not depend on renderer memory.

## Renderer outcomes

`OfflineReconciliationOutcome` has four explicit states:

| Outcome | Renderer meaning |
| --- | --- |
| `APPLIED` | **Applied locally** — SQLite stock, movement history, and the durable receipt committed once. |
| `ALREADY_APPLIED` | **Already applied locally** — an exact replay returned the existing receipt without another movement. |
| `CONFLICT` | **Conflict or error** — the event remains pending and no inventory update commits for that attempt. |
| `NO_PENDING_EVENT` | No authoritative FIFO head was available when Electron performed the operation. |

Both successful local states also display **Awaiting device acknowledgement**
and keep **Pending on ESP32** visible. The page shows the receipt's item,
action, event timestamp, authoritative stock transition, and authoritative
status so they cannot be confused with the device's cached audit values.

An unconfirmed IPC or internal error is retry-safe because the event ID receipt
prevents duplicate local application. The renderer does not infer success from
the preview or hide the still-pending device state.

## Conflict classes

Expected reconciliation conflicts cross IPC as bounded codes and safe messages:

| Code | Meaning |
| --- | --- |
| `INVALID_EVENT` | The event fails the strict offline-event contract. |
| `EVENT_ID_CONFLICT` | A receipt with the same event ID has different immutable event content. |
| `PRODUCT_NOT_ACTIVE` | The referenced product does not exist or is soft-deleted. |
| `PRODUCT_IDENTITY_CONFLICT` | Product ID and exact barcode do not identify the same active product. |
| `INSUFFICIENT_STOCK` | Applying a checkout to current SQLite stock would go below zero. |
| `STOCK_OVERFLOW` | Applying a restock would exceed the supported safe-integer range. |

These conditions do not update product stock, movement history, or the
reconciliation receipt. Unexpected transport, SQLite, or internal diagnostics
are sanitized before reaching the renderer so local URLs, raw events, and
database details are not exposed.

## Deferred device acknowledgement

Step 7.2 deliberately sends no acknowledgement to the ESP32 and does not
archive, delete, truncate, or rewrite `/pending_sync.csv`. The reported pending
count therefore does not decrease after a local application. A repeated
reconciliation retrieves the same oldest event and surfaces
`ALREADY_APPLIED`.

Phase 7 Step 3 remains responsible for authenticated acknowledgement, safe
oldest-event retirement or archival, multi-record draining, and any required
authoritative cache refresh. Until then, the UI reports local and device state
separately and makes no end-to-end completion claim.

## Verification boundary

Automated coverage verifies migration constraints and rollback, current-stock
composition, exact replay after database reopen, changed-payload conflicts,
product identity conflicts, underflow and overflow rejection, authenticated
parameter-free IPC, preload argument stripping, and all renderer outcome
labels. Tests use temporary databases and mocked hardware transport; they do
not contact, acknowledge, erase, or reflash the physical ESP32.
