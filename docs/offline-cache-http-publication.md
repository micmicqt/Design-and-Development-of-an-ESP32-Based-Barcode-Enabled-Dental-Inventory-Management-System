# Offline-cache HTTP publication (Step 5 deployment fix)

The physical HTTP timing trace measured three approximately 36.6-second
`/offline/cache` handler intervals. The cache was absent at boot, and the
desktop waits for the `begin` response before sending any `item` or `commit`,
so these intervals were **BEGIN**, not ITEM or COMMIT. The trace did not
measure the individual FatFs calls. The opt-in `esp32dev-http-timing` build now
aggregates FatFs operation and remote-sector timings per cache job; identifying
the exact expensive FatFs sub-operation requires a later approved diagnostic
upload. No SD timing or durability rule was changed on the basis of a guess.

The external `POST /offline/cache` body remains the bounded `begin`/`item`/
`commit` contract. `begin` creates a temporary header and restarts incomplete
staging at item zero, except that an already-installed identical generation is
a no-op. Each ordered `item` is appended and synced before completion. `commit`
validates the count and CRC, replaces the active file through the existing
temporary/backup recovery sequence, and only then reports success. The active
cache is not replaced by a partial transfer. Pending offline journal records
block replacement; a drained acknowledged prefix can be compacted after a
successful cache refresh. If the desktop disappears, the one queued operation
finishes or fails, while a later `begin` safely restarts staging.

The HTTP POST now validates and enqueues one request, then returns `202` with
`processing`, `jobId`, `operation`, `generation`, `stage`, `elapsedMs`, and
bounded storage diagnostics. An identical retry gets the same job. A different
request while it is queued/running gets `409`. The main loop executes the
storage operation *after* the POST handler returns, with HTTP service pumped
between remote-storage waits. `GET /offline/cache/progress?jobId=...` returns
`202` while processing, the existing exact `200` success shape only after the
durable operation completes, or its failure status/error. Job IDs are seeded
from the boot session. A successful identical POST can also replay the exact
`200` response if the original response was lost.

Only the cache job owns FatFs and the controller storage bridge while it runs.
Offline ACK, journal preview, registration start, RTC sync, and SD recovery are
interlocked from entering competing storage/controller work. `/status`,
`/events/next`, desktop heartbeat, and existing RAM-backed online event state
remain serviceable. A queued cache job does not make an idle transaction BUSY.
A mode frame received during an actual exclusive sector operation fails closed
with the existing storage rejection and logs `STORAGE_BRIDGE_ACTIVE`; an active
offline ACK owner similarly logs `OFFLINE_ACK_IN_PROGRESS`. BUSY remains reserved
for an active user transaction or registration capture.

Queued publication waits while a transaction owns barcode processing; offline
transactions retain their captured cache generation throughout that interval.
This also prevents an online SCAN from nesting RTC work inside a cache read.
Before executing deferred work, the journal replacement interlock
is checked again: a pending record saved during that wait prevents replacement.
The installed-cache no-op remains available, without discarding pending records.
Journal preview returns the explicit retryable `409 transaction_active` while a
transaction owns barcode/result processing, preventing a SCAN serviced during
preview from recursively entering the same RTC/FatFs storage path.

The desktop posts each operation once and polls the lightweight progress URL
at a bounded interval, with a 120-second overall per-operation deadline. It
does not resend an operation after receiving `202`; if only the initial POST
response is lost, it retries the identical request, which the ESP32 deduplicates.
Failure remains retryable through the existing background cache refresh policy
and does not reverse a committed SQLite transaction.

## Physical acceptance after separate upload approval

1. Preserve the current MicroSD and pending journal. Upload only after the
   user explicitly authorizes a firmware update; do not scan or synchronize
   during the timing measurement.
2. Start the opt-in timing build and Electron with an unchanged inventory
   snapshot. Record `Offline cache ... operation=begin|item|commit` and the
   `Cache FatFs ...` / `Cache remote sectors ...` summary lines. These locate
   the actual slow FatFs and sector sub-stages without per-sector log spam.
3. While a slow cache job is running, sample `/status` and `/events/next` from
   the same LAN. Confirm normal low-latency responses, continued heartbeat,
   no simultaneous FatFs ownership, and no HTTP service gap comparable to
   36.6 seconds.
4. Verify the progress URL reports `202`, then `200` only after completion.
   Repeat the same POST to verify idempotent response; send a different cache
   request while active and expect `409` without changing the installed cache.
5. Verify the installed generation/count and the existing tmp/bak recovery
   checks. Do not clear or ACK pending offline transactions for this test.
