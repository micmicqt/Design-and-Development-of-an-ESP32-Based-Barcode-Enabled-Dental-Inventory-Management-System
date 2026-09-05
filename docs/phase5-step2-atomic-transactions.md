# Phase 5 Step 2: atomic online transactions

This step completes stock and movement-history persistence for online ESP32
RESTOCK and CHECKOUT events. It does not add ESP32 result feedback, stock LED
control, offline operation, or synchronization, and it does not change firmware.

## Trust boundary and ordering

The renderer sends only the pending `eventId` and quantity through the frozen
preload API. Authenticated, trusted-main-frame IPC validates that payload. The
main process obtains the current event from the existing `HardwareGateway`; it
does not trust renderer-supplied barcode, mode, timestamp, current stock, or
status.

The successful order is:

1. Verify that `eventId` is the current ESP32 FIFO head.
2. Re-read the active product by exact barcode inside the SQLite transaction.
3. Revalidate the quantity and current stock.
4. Update product stock.
5. Insert one permanent `transactions` snapshot using the DS3231 timestamp.
6. Insert the durable processed-event receipt.
7. Commit SQLite.
8. Acknowledge the ESP32 event.

No acknowledgement is attempted when SQLite fails. An acknowledgement failure
after commit does not roll back valid inventory data.

## Atomic stock rules

- RESTOCK adds a positive whole-number quantity of at most 10,000. The resulting
  stock must remain a non-negative JavaScript safe integer.
- CHECKOUT subtracts the quantity only when the freshly read database stock is
  sufficient. A checkout may reach exactly zero but may never go below zero.
- The existing `deriveStockStatus` helper determines HIGH, LOW, or EMPTY.
- Every successful transaction creates exactly one ONLINE movement snapshot with
  product, barcode, item name, category, action, quantity, previous stock, new
  total, and the hardware scan timestamp.
- Unknown and soft-deleted barcodes fail without changing stock or history.

The existing `better-sqlite3` transaction helper encloses all three writes. A
failure while updating stock, inserting history, or inserting the receipt rolls
the entire unit back.

## Durable idempotency

Migration 3 creates `processed_hardware_events` with:

- `event_id` as the primary key;
- a unique foreign-key link to the permanent movement `transaction_id`;
- the resulting stock status snapshot; and
- a database-recorded processing timestamp.

Receipt details are reconstructed by joining this row to the existing immutable
movement snapshot. Reprocessing the same event and quantity returns that receipt
without another stock update or history insert. Reusing an event ID with
different transaction details is rejected. Because the receipt is in SQLite,
this protection survives an Electron restart and database reopen.

## Acknowledgement recovery

If the database commits but the ESP32 ACK request fails, the UI clearly reports
that inventory was already updated and switches to an acknowledgement-only
state. Confirm buttons are no longer available. **Retry acknowledgement** uses
the durable receipt and never repeats the stock transaction.

If an ACK reached the ESP32 but its HTTP response was lost, an empty hardware
queue on retry is treated as completion. A different current FIFO head is never
acknowledged on behalf of the saved event.

The older generic ACK route remains available only for explicit rejection of an
unknown barcode. A registered product must use the atomic transaction path.

## Renderer behavior

- Known scans show **Confirm Restock** or **Confirm Checkout**.
- Quantity validation remains mode-aware, and the submit guard prevents duplicate
  requests while processing.
- Database failures leave the scan pending and allow a safe retry.
- A committed receipt displays item, signed quantity, previous stock, resulting
  stock, and resulting status.
- A successful ACK clears the event, refreshes inventory and movement history,
  resumes polling, and shows a transaction-success notice.
- On dialog resume, the renderer checks for a durable receipt before offering a
  confirm action, preserving the acknowledgement-only state across a restart.

## Verification boundary

Automated tests use in-memory or temporary isolated SQLite databases. This phase
does not launch the Electron application against the clinic database, perform a
physical stock-changing transaction, upload firmware, or modify the ESP32.

Run the verification from the repository root:

```powershell
npm.cmd run test --workspace "@dental-inventory/desktop"
npm.cmd run test --workspace "@dental-inventory/protocol"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build:desktop
git diff --check
git status --short
```

## Physical online verification — 2026-09-05

The Step 2 implementation was verified with the real Electron database and the
physically connected ESP32. A read-only baseline was captured before launching
Electron: Cleanser (`4806016001569`) was the only active product, at stock 20,
threshold 5, status HIGH; history and durable receipt counts were both zero.
Migration 3 was not present until the normal Step 2 application startup applied
it. The baseline database-file SHA-256 was
`83744be1fc3fd541eec961de8ce281b7d5fae0c57ec3320641f709422eefeaf0`.

The real RESTOCK event
`evt-148CE50D5020-A2BFCAECD13250FF-1`, scanned at
`2026-09-05 13:14:47`, added 2 units. SQLite recorded movement
`c8abc600-cb2c-4db2-83d9-a769bd106b92` as ONLINE RESTOCK, stock 20 → 22,
and one linked HIGH receipt. The UI reported 22 / HIGH, and the ESP32 queue
returned HTTP 204 after acknowledgement. Read-only receipt lookup confirmed the
same event was represented once without resubmitting production data.

The real CHECKOUT event
`evt-148CE50D5020-8F28D9C1C28F3A10-1`, scanned at
`2026-09-05 13:18:51`, removed 2 units. SQLite recorded movement
`368c5298-f07c-4400-943a-cd78cd85ad5f` as ONLINE CHECKOUT, stock 22 → 20,
and one linked HIGH receipt. The UI reported 20 / HIGH, and the ESP32 queue
again returned HTTP 204 after acknowledgement.

The final read-only comparison found three product rows and one active product,
unchanged from baseline; only Cleanser's expected stock/update activity occurred.
Cleanser returned to stock 20 / HIGH. The exact test delta was two history rows
and two processed-event receipts—one of each action—with no duplicates or
unintended product changes. Final logical SHA-256 values were:

- products: `c27266441f0709a7ea4a7129fa5e67acc29ef75385348b572887e297984e61d9`;
- history: `1449aa4cc71ccdfe465a1119e98f4d2536c33242b8c904b0324fc34da9bf696e`;
- processed receipts: `9b3c3555d11d1123e65d5635423c21461ea165c39301d045f6382a0fcf2127eb`.

There was no safe disposable active product for a physical checkout-to-zero
test, so that case remains automated-only. Deliberately forcing an ACK failure
during a production stock transaction was also not considered safely practical;
commit-before-ACK and ACK-only retry remain covered by coordinator, IPC, and
renderer tests. No implementation fix, firmware change, or firmware upload was
needed during physical verification.
