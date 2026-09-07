# Phase 6 Step 1: desktop presence foundation

This step distinguishes an available desktop application from an ESP32 that is
merely connected to Wi-Fi. It does not implement offline inventory mutation,
an inventory cache, pending synchronization records, reconciliation, or archive
handling.

## Presence contract

While an administrator is signed in and the application shell is mounted, the
renderer invokes one parameter-free method on the frozen preload API. The
authenticated main-frame IPC handler delegates through `HardwareGateway` to the
fixed ESP32 endpoint:

```http
POST /desktop/heartbeat
```

A successful request returns:

```json
{"desktopOnline":true}
```

The renderer receives neither the ESP32 base URL nor `fetch`, request options,
or another arbitrary network capability. Network errors are reduced to `false`
at the IPC boundary and do not interrupt inventory features.

## Timing and lifecycle

- The desktop sends a heartbeat immediately after the authenticated shell opens.
- It renews about every four seconds, scheduling only after the previous request
  settles so heartbeat requests cannot overlap.
- Logout, shell unmount, and application shutdown stop future renewals.
- A failed request is harmless; the next interval retries automatically.
- The ESP32 uses a 12-second `millis()` lease with unsigned elapsed-time
  subtraction, including across timer wrap.
- A heartbeat marks `desktopAvailable` true and refreshes the lease.
- Lease expiry marks it false.
- Wi-Fi loss marks it false immediately. Reconnection alone is insufficient; a
  new successful heartbeat is required to restore desktop availability.
- The lease is intentionally volatile and begins unavailable after ESP32 reset.

`GET /status` retains all prior fields and adds the backward-compatible optional
field `desktopOnline`. Older Phase 5 responses without this field are still
accepted by the desktop parser.

## Isolation from Phase 5 transactions

The heartbeat handler does not inspect, enqueue, apply a result to, acknowledge,
or dequeue a hardware event. It does not touch SQLite, the MicroSD CSV, RTC,
scanner, LCD, or LED outputs. The established online ordering remains:

1. SQLite commit and durable receipt.
2. `POST /events/result`.
3. Durable result-delivered marker.
4. `POST /events/ack`.
5. FIFO advance.

The existing `/health`, `/status`, `/events/next`, `/events/result`, and
`/events/ack` contracts remain compatible.

## Verification

This implementation is verified without uploading firmware or performing live
transactions. Run from the repository root:

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
