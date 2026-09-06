# Phase 5 Step 3: online transaction result feedback

This step returns an already-committed online RESTOCK or CHECKOUT result to the
ESP32. It adds no offline inventory processing, synchronization, WebSocket,
mDNS, cloud service, or installer packaging.

## Ordered trust boundary

The renderer still sends only an event ID and quantity through the frozen
preload. Authenticated main-frame IPC delegates to the transaction coordinator,
which uses the narrow `HardwareGateway`; the renderer receives neither the ESP32
base URL nor generic network access.

A successful transaction now follows this order:

1. Verify the event is the current ESP32 FIFO head.
2. Atomically update SQLite stock, insert one movement, and insert the durable
   processed-event receipt.
3. Commit SQLite.
4. POST the receipt-derived result to `/events/result`.
5. Mark `result_delivered_at` after the ESP32 accepts the result.
6. POST `/events/ack`.
7. Clear the renderer event and resume polling.

Neither result delivery nor acknowledgement is attempted when the SQLite
transaction fails. The hardware event remains pending until acknowledgement.

## Result endpoint

`POST /events/result` accepts exactly one JSON object with these fields:

```json
{
  "eventId": "evt-device-session-1",
  "result": "success",
  "mode": "restock",
  "quantity": 2,
  "resultingStock": 22,
  "stockStatus": "HIGH"
}
```

`mode` is `restock` or `checkout`; quantity is a positive whole number up to
10,000; resulting stock is a non-negative JavaScript-safe integer; and status is
`HIGH`, `LOW`, or `EMPTY`. Firmware rejects missing, duplicate, unknown,
malformed, escaped, or out-of-range fields. The event ID and mode must match the
current FIFO head.

The first valid result and an identical retry both return HTTP 200:

```json
{"accepted":true,"eventId":"evt-device-session-1"}
```

An unrelated event or mode is rejected without changing feedback. Once a result
has been applied, any different quantity, resulting stock, or status for that
event is a conflict. Result state is kept with the existing volatile RAM event
queue; reboot limitations therefore remain the same as in Phase 4 Step 3.

## Kiosk feedback

For a committed result, the 20x4 LCD shows the action, signed quantity,
resulting stock, and database-derived status for four seconds. D1 SUCCESS pulses
for one second using the verified GPIO32/GPIO33 logic; D2 ERROR is not asserted.
The LCD then returns to the existing idle screen without blocking Wi-Fi service
or the scanner state machine.

The received status—not a second ESP32 stock calculation—selects the persistent
GPIO26/GPIO27 stock output:

| Status | GPIO26 | GPIO27 | Visible indicator |
| --- | --- | --- | --- |
| HIGH | HIGH | LOW | D3 green |
| LOW | LOW | HIGH | D4 yellow |
| EMPTY | HIGH | HIGH | D5 red |

Required LCD/D1 feedback is retained in a bounded FIFO even if the associated
event is acknowledged. A full feedback FIFO rejects a new first-time result for
later retry instead of accepting it and silently dropping its display. An
identical already-applied retry needs no new feedback entry.

## Durable recovery

Migration 4 adds nullable `result_delivered_at` to
`processed_hardware_events`. A null value means SQLite is committed but result
delivery must be retried. A value means the ESP32 accepted the result and only
acknowledgement remains.

- Result request failure leaves the receipt null at this boundary, does not ACK,
  and never repeats the stock/history transaction.
- If the ESP32 applied the result but its response was lost, the same receipt
  produces an identical safe retry.
- Result success followed by ACK failure is recorded durably as ACK-only recovery.
- If an ACK response is lost, an empty queue is considered completion only when
  result delivery was already recorded. If the next FIFO head is already
  visible, the coordinator retries the old ID so the firmware's recent-ACK
  receipt can prove completion without consuming that next event. Neither case
  can falsely complete an undelivered result.

The dialog clearly reports that inventory is already updated and exposes only
the retry action appropriate to the durable state. **Review later** preserves
the same event and recovery state. Unknown barcodes retain the explicit existing
Reject scan acknowledgement path and do not invent a stock result.

## Physical verification

The online result path was exercised on 2026-09-06 with the real Electron
application, ESP32, GM65, RTC, LCD, MicroSD, and clinic database. Using the
existing `Cleanser` test product, the controlled sequence was:

1. CHECKOUT 2: stock 7 to 5, status LOW.
2. CHECKOUT 5: stock 5 to 0, status EMPTY.
3. RESTOCK 7: stock 0 to 7, status HIGH.

All three scans produced one ONLINE movement and one durable event receipt. The
firmware accepted each committed result before its event was acknowledged, and
`GET /events/next` returned HTTP 204 after each acknowledgement. The final
RESTOCK restored the product to its starting stock.

After rebuilding the breadboard logic wiring on 2026-09-07, the complete LED
path passed physically. D1 SUCCESS and D2 ERROR operate independently through
GPIO32/GPIO33. The database-supplied HIGH, LOW, and EMPTY results select only D3
green, D4 yellow, and D5 red respectively through GPIO26/GPIO27. The stock LED
remains latched to the most recent authoritative status after the LCD returns to
idle, as designed.

The RTC oscillator-stop flag was cleared once during controlled recovery after
a power-loss indication. The normal firmware does not overwrite retained RTC
time, and the final startup/status checks reported the RTC available.

Lost result-response and lost acknowledgement-response cases were not forced on
the live transaction because there was no risk-free physical isolation method.
Their idempotent recovery remains covered by automated tests.

The final integrated firmware was also verified with the physical RESTOCK button
on GPIO13 and CHECKOUT button on GPIO14. The temporary Serial `c`/`r` trigger
used during button troubleshooting is not part of the normal firmware build.

Automated verification continues to use isolated temporary or in-memory
databases and host-native firmware protocol tests.

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
