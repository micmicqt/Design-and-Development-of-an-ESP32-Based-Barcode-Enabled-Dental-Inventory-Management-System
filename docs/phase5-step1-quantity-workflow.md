# Phase 5 Step 1: barcode lookup and quantity review

This step starts the online transaction workflow but does **not** save a stock
transaction. It changes only desktop source, tests, and documentation. There are
no new dependencies, migrations, firmware changes, hardware uploads, or stock
feedback commands.

## Existing architecture reused

Hardware events still use the verified Phase 4 path: ESP32 FIFO →
`Esp32HttpGateway` → authenticated hardware IPC → frozen preload API → React.
Event polling still permits only one outstanding event request and pauses while
an event is pending, including when its dialog is hidden for later review.

Product lookup uses React → `inventory.findProductByBarcode(barcode)` in preload
→ `products:find-by-barcode` authenticated/trusted-main-frame IPC → the existing
`InventoryService` → its existing SQLite connection. There is no renderer SQL,
generic IPC/fetch exposure, new database layer, or ESP32 address in the renderer.

The new method returns `IpcResult<ProductDto | null>`: a successful `null` means
no active matching item; a failed request is a separate retryable lookup error,
never silently classified as ITEM NOT FOUND. Images use the existing managed
image URL conversion, and status uses the existing `deriveStockStatus` mapping.

The prepared query binds the original barcode to `barcode = ? COLLATE BINARY`
and excludes `deleted_at IS NOT NULL`. It is exact and case/space sensitive,
not a substring search. Barcodes remain strings end-to-end: `000123` and `123`
are different. Lookup does not trim, case-fold, or numerically normalize text.
It rejects non-text, blank/all-whitespace, control characters, and text over
256 characters. Existing create/search normalization is deliberately unchanged.

## Known item and quantity review

The dialog displays RESTOCK or CHECKOUT, image/fallback, item name, category,
barcode, current stock, derived stock status, and the original RTC timestamp.
The input is labelled Quantity to ADD or Quantity to REMOVE.

Validate rereads the product through the same lookup service before checking the
quantity, so a stock correction made while the dialog was deferred is reflected.
Lookups and validation submissions are serialized, with stale async results
ignored. A lookup failure offers retry and preserves the hardware event.

Shared, pure quantity validation accepts whole-number quantities from 1 through
10,000 inclusive. This per-scan guard is intentionally practical; it does not
alter existing database stock limits or normal inventory editing. Blank, zero,
negative, decimal, nonnumeric, exponent/hex/comma notation, and excessive values
are rejected. CHECKOUT also rejects quantities above current stock and clearly
blocks an empty item. RESTOCK can be reviewed when current stock is zero.

Success explicitly says the quantity is validated and ready for the Phase 5
Step 2 database transaction, **stock is unchanged**, and the scan remains pending.
Changing the quantity or resuming review clears that validation message.
No create/update/delete/history-write API is called by this workflow.

## Deferred review and ACK semantics

- Opening a known dialog, editing its quantity, failing validation, and passing
  validation do **not** acknowledge the event.
- Review later hides the dialog without clearing or ACKing the event. A Resume
  pending scan control restores it and refreshes product information. Normal
  inventory navigation/search/editing remain available while review is deferred.
- The pending head prevents later FIFO events from being offered to the UI.
  There is no known-item commit/ACK action in Step 1; passing Validate is not
  a completed inventory transaction. This intentional limit prepares Step 2.
- Unknown or soft-deleted barcodes show ITEM NOT FOUND and the scanned barcode.
  The explicit Reject scan action acknowledges intentional rejection **without**
  adding a product, changing stock, or inserting movement history. Nothing is
  ACKed automatically on lookup. A lookup error cannot expose Reject scan.
- Rejection uses the existing ACK contract and clears the pending event only
  after a successful response for that event ID. A failed/mismatched ACK keeps
  the event and permits retry. Duplicate clicks cannot send concurrent ACKs.
- Logout does not ACK a known pending event. On the next login the ESP32 can
  return its unchanged head. Deferred UI state itself is not persisted locally.

The future ordering remains receive → exact lookup → quantity → validate →
successful SQLite transaction → ACK. Step 2 must revalidate stock and quantity
inside that transaction; Step 1's read-only preview is not a reservation or
authorization to mutate stock later without another check.

## Retained limits and verification

The firmware still has an eight-event **RAM** FIFO and volatile ACK receipts.
Power loss/reset loses queued events; a full queue cannot accept later live
events. Hardware CSV logging remains separate and is not replayed by this step.
Known pending reviews can hold the FIFO head; Step 1 adds no durable delivery,
offline workflow, or synchronization. Existing firmware LCD/LED success means
the hardware CSV append succeeded, not that desktop inventory changed.

Automated coverage includes exact/leading-zero lookup against real temporary
SQLite databases, read-only query enforcement with unchanged product/history
snapshots, trusted/authenticated IPC, narrow preload, quantity edge cases,
known/unknown dialogs, fresh-stock checks, deferred review, duplicate prevention,
ACK failure/retry, and existing inventory CRUD regressions. Test fixtures are
isolated from the clinic database and from real ESP32 events.

Run from the repository root:

```powershell
npm.cmd run test --workspace "@dental-inventory/desktop"
npm.cmd run test --workspace "@dental-inventory/protocol"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build:desktop
git diff --check
git status --short -uall
```

Firmware build is required only if firmware is changed. Automated checks do not
themselves prove physical integration; the separately authorized hardware
verification is recorded below. Desktop checks require no firmware upload.

## Completion file inventory

Recovered partial work without reverting it: exact lookup service and service
tests, payload validation, authenticated lookup IPC, frozen preload/typed contract,
quantity validator/tests, IPC/preload tests, and the initial dialog component.
Completed the dialog's shell integration, scoped presentation, review/resume and
rejection paths, renderer tests, documentation, and two verification fixes (a
lint-safe control-character check and a guarded optional focus target).

Modified existing files:

- `README.md`
- `apps/desktop/src/main/inventory/inventory-service.ts`
- `apps/desktop/src/main/ipc/payload-validation.ts`
- `apps/desktop/src/main/ipc/register-inventory-handlers.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/shared/ipc-contract.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/App.test.tsx`
- `apps/desktop/src/renderer/src/styles.css`
- `apps/desktop/tests/inventory/inventory-service.test.ts`
- `apps/desktop/tests/ipc/payload-validation.test.ts`
- `apps/desktop/tests/ipc/register-inventory-handlers.test.ts`
- `apps/desktop/tests/preload/preload-hardware-api.test.ts`

New files (including those recovered from the interrupted run):

- `apps/desktop/src/renderer/src/components/HardwareTransactionDialog.tsx`
- `apps/desktop/src/shared/transaction-quantity.ts`
- `apps/desktop/tests/domain/transaction-quantity.test.ts`
- `docs/phase5-step1-quantity-workflow.md`

## Final automated verification — 2026-09-04

| Check | Result |
| --- | --- |
| Desktop tests | 317 passed across 14 files, including 49 renderer tests |
| Shared protocol tests | 13 passed |
| TypeScript (desktop and protocol) | Passed |
| ESLint | Passed |
| Electron production main/preload/renderer build | Passed |
| `git diff --check` | Passed; Git reports only normal LF/CRLF conversion notices |
| Firmware build | Not needed: no firmware files changed |

The desktop test log includes an expected, deliberately simulated database-error
message in an existing image-removal failure test; that test passed. No tests
were removed or disabled. No real clinic stock/history data, local credentials,
or firmware were modified during verification.

Implementation scope relative to baseline
`aa181f5f5abd4f4755496f8bc7fdaf76846633ff`: 13 modified files and four new files,
all listed above.

## Physical verification and checkpoint — 2026-09-04

- Real ESP32 `/health` and `/status` returned HTTP 200. The authenticated desktop
  showed Connected, Idle, RTC Available, and MicroSD Available. A session-only
  address override accommodated DHCP; local configuration files were unchanged.
- Known RESTOCK displayed the exact barcode and product details. Blank, zero,
  negative, decimal, nonnumeric and over-limit quantities were rejected; quantity
  2 validated with an explicit stock-unchanged message and no ACK.
- Review later and Resume preserved the event, refreshed product information,
  and retained one dialog without ACKing the event.
- With current stock 20, CHECKOUT quantities 1 and 20 validated; 21 was rejected.
  No stock/history mutation or known-event ACK occurred.
- Known pending events were cleared only by user-requested ESP32 reboots, followed
  by desktop renderer refreshes. No hidden/manual ACK was used.
- The full unknown barcode displayed ITEM NOT FOUND and remained pending until
  explicit Reject scan. Separately queued retries were each rejected through the
  visible UI in FIFO order. Final `/events/next` returned HTTP 204.
- Read-only pre/post checksums over complete ordered product and history rows
  matched. Stock/status remained unchanged, history stayed empty, and no product
  was automatically created. No renderer errors were observed.
- Zero-stock CHECKOUT was not physically testable because no active zero-stock
  item existed; automated coverage passed. The physical test item had no reference
  image, so only its clinic-logo fallback was verified on hardware-driven scans.
- Electron closed cleanly. No firmware changes/uploads or application fixes were
  needed. Credentials, local configuration, database snapshots and detailed
  verification artifacts under `.runtime/` are excluded from the checkpoint.
