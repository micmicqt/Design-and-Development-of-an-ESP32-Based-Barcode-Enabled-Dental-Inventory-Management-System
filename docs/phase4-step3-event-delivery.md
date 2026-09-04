# Phase 4 Step 3: hardware transaction event delivery

This step delivers successfully saved RESTOCK/CHECKOUT scans to a temporary desktop
modal. It does **not** update inventory, create SQLite movement records, accept a
quantity, or synchronize offline records. No new dependencies are required.

## Changed-file inventory

Recovered partial files, then completed where needed:

- `firmware/src/main.cpp`
- `apps/desktop/src/main/hardware/hardware-gateway.ts`
- `apps/desktop/src/main/hardware/esp32-http-gateway.ts`
- `apps/desktop/src/shared/ipc-contract.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/App.test.tsx`
- `apps/desktop/src/renderer/src/styles.css` (recovered styling retained)

Additional existing files updated to finish the path, test it, or document it:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/ipc/register-hardware-handlers.ts`
- `apps/desktop/src/main/development/mock-hardware-gateway.ts` (test-only interface compatibility)
- `apps/desktop/tests/hardware/esp32-http-gateway.test.ts`
- `apps/desktop/tests/ipc/register-hardware-handlers.test.ts`
- `apps/desktop/tests/preload/preload-hardware-api.test.ts`
- `README.md`

New source/test/documentation files:

- `firmware/include/transaction_event_queue.h`
- `firmware/tests/transaction_event_queue_test.cpp`
- `docs/phase4-step3-event-delivery.md`

## Preserved hardware workflow

The active PlatformIO `esp32dev` application remains `firmware/src/main.cpp`;
`gm65_command_diagnostic.cpp` remains excluded. Monitor and upload baud remain
115200. Pin configuration, scanner trigger/ACK/parser, RTC retained time, MicroSD
at 1 MHz, CSV format/readback, LCD, buttons, LED feedback, Wi-Fi retry behavior,
`/health`, and `/status` are unchanged.

Only after the existing `/integration_test.csv` append succeeds does the firmware
offer the event to its pending delivery queue. Original hardware success feedback
still completes. HTTP handlers run on the existing hardware loop; no additional
task mutates the queue concurrently.

## FIFO and event identity

- Fixed-size RAM FIFO: eight events. Reads never consume an event.
- Full queue: preserve older unacknowledged events, warn on Serial, and leave the
  successful CSV write intact. The newly saved scan cannot be queued for delivery.
- Each event has a device MAC, per-boot random session identifier, and increasing
  64-bit sequence in its ID. Boot entropy is enabled briefly before peripheral
  initialization, then disabled. IDs are collision-resistant across reboots and
  devices; the counter does not wrap into reused IDs.
- Barcode remains text (up to 256 printable ASCII characters). Leading zeroes and
  accepted spaces are preserved; commas and all-space barcodes are rejected by
  the existing scanner/CSV validation. RTC timestamps stay in
  `YYYY-MM-DD HH:MM:SS`, without conversion to the PC's time zone.
- Pending events and recent ACK receipts are volatile: reboot clears them. This
  is not durable delivery or offline synchronization. CSV remains the hardware
  record, but this step does not replay CSV records to the desktop.

## HTTP contract

`GET /events/next` returns HTTP 204 with no JSON body when empty. Otherwise HTTP
200, `application/json`, returns the same oldest event until acknowledged:

```json
{
  "eventId": "evt-device-session-1",
  "mode": "restock",
  "barcode": "0004806016001569",
  "timestamp": "2026-09-04 09:00:00"
}
```

`mode` is exactly `restock` or `checkout`; the four fields are required. The ID
above is illustrative, not a real queued scan.

`POST /events/ack` accepts a JSON body with only the event ID:

```json
{"eventId":"evt-device-session-1"}
```

A matching FIFO head is removed and HTTP 200 returns exactly:

```json
{"acknowledged":true,"eventId":"evt-device-session-1"}
```

Malformed/oversized bodies return 400. An unknown ID returns 404 when the queue
is empty or 409 when it does not match the current head. Neither removes anything.
An eight-entry receipt ring recognizes recently successful ACKs: retrying one
returns the same success without removing the next event. This handles an ACK
whose HTTP response was lost. Receipts are not permanent or persisted over reboot.

Use only the trusted clinic LAN. These firmware diagnostic HTTP endpoints have
no device-level authentication or TLS; do not expose them to the internet.
The existing Arduino `WebServer` buffers a request before invoking the ACK handler;
the 128-byte ACK validation limit is not a network-ingress memory/time limit.
Normal desktop ACKs are small, but slow/malformed clients can delay the shared loop.
This step retains that existing server rather than changing the verified Wi-Fi
implementation.

## Desktop boundary and modal

The route remains React → frozen preload API → authenticated, trusted-main-frame
IPC → `Esp32HttpGateway` → ESP32 HTTP. React receives no base URL, credentials,
generic HTTP method, or socket access. Existing context isolation/sandbox settings
are unchanged. Configure the LAN URL only in ignored `apps/desktop/.env.local`;
firmware Wi-Fi credentials remain in ignored `firmware/include/secrets.h`.

The gateway validates event fields, supported modes, real RTC dates, barcode/ID
limits, HTTP status codes, and exact matching ACK responses. Requests use the
existing 2.5-second timeout. HTTP 200 with JSON `null` is invalid, not an empty
queue. Invalid/unavailable polls do not acknowledge an event; polling retries.

The authenticated shell polls about once per second using one outstanding event
request (including React StrictMode startup). Polling pauses while a modal is
pending and stops on logout/unmount. RESTOCK/CHECKOUT modals show barcode and RTC
timestamp only. Dismiss sends an ACK once; it clears the modal only after a
successful matching response. Failure retains the event and offers retry. The
stock, product, and movement-history APIs are never invoked by scan delivery.

## Verification

From the repository root:

```powershell
npm.cmd run test --workspace "@dental-inventory/desktop"
npm.cmd run test --workspace "@dental-inventory/protocol"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build:desktop
pio run --project-dir firmware -e esp32dev
git diff --check
git status --short
```

Desktop automated tests cover transport validation, timeouts, authenticated IPC,
preload exposure, poll lifecycle, duplicate prevention, both scan modes, and ACK
failure/retry without inventory mutation. Firmware host tests exercise the real
pure queue, ACK parser, and serializer without activating hardware. Build outputs
belong under ignored runtime/build directories.

To run the firmware host tests with a C++11-capable MinGW `g++` on Windows:

```powershell
New-Item -ItemType Directory -Force .runtime/firmware-tests | Out-Null
g++ -std=c++11 -D__USE_MINGW_ANSI_STDIO=1 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/transaction_event_queue_test.cpp -o .runtime/firmware-tests/transaction_event_queue_test.exe
if ($LASTEXITCODE -ne 0) { throw 'Firmware host-test compilation failed' }
& .runtime/firmware-tests/transaction_event_queue_test.exe
if ($LASTEXITCODE -ne 0) { throw 'Firmware host tests failed' }
```

## Physical verification record — 2026-09-04

The current Step 3 firmware was built, uploaded to COM9 at 115200, and physically
verified with the real Electron application. Startup initialized LEDs, both
buttons, LCD, RTC, MicroSD, GM65, Wi-Fi, and HTTP successfully. Both `/health` and
`/status` returned HTTP 200. The current DHCP address was supplied through a
session-only desktop environment override; no real device address or credentials
were added to tracked source.

| Mode | Barcode | RTC timestamp | Result |
| --- | --- | --- | --- |
| RESTOCK | `25156485` | `2026-09-04 17:01:45` | One pending event and modal; repeated reads preserved the head; Dismiss ACK cleared it; subsequent GET returned 204. |
| CHECKOUT | `25156485` | `2026-09-04 17:09:20` | One pending event and modal; repeated reads preserved the head; Dismiss ACK cleared it; subsequent GET returned 204. |

LCD/D1 success and no-scan timeout/D2/error-to-idle behavior were confirmed. No
quantity dialog or renderer errors occurred. Pre/post read-only logical database
hashes matched: two product rows unchanged and zero movement-history rows.
Existing CSV append behavior was preserved; an independent full-card readback was
not performed. Intentional resets while moving the single button interrupted
Serial capture, so CHECKOUT delivery/ACK was verified through HTTP and the UI.
No application or firmware fixes were needed during physical verification.

**Physical-test limitation:** ACK failure/retry during a network outage was not
physically tested because safe network-only isolation was unavailable. Rebooting
would clear the RAM queue and is not a substitute for that test. Keep the existing
automated coverage: gateway rejection/timeout validation, renderer failed or
mismatched ACK retention/retry, authenticated IPC failure handling, and the native
lost-response receipt test (which verifies that retry cannot consume the next
FIFO head). This limitation does not change the ACK contract or queue design.

Future physical retests require explicit upload authorization. This checkpoint
does not update desktop stock or movement history.
