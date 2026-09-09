# Phase 6 Step 3: offline power-loss recovery verification

Phase 6 Step 3 physically verified the durability and reboot-recovery behavior
implemented in Step 2B. It introduced no new transaction or synchronization
behavior.

## Initial durable state

Electron was closed, so the ESP32 reported `desktopOnline: false`. The
authoritative `/inventory_cache.csv` base stock for Cleanser was 2. The existing
`/pending_sync.csv` journal contained three committed deltas:

```text
+1
+1
-1
```

The expected effective offline stock was therefore 3. Firmware reported a valid
two-item cache, `pendingSyncItems: 3`, and `offlineReady: true`.

## EN/RESET recovery

After an ESP32 EN/RESET, startup successfully recovered the retained RTC time,
MicroSD, two-item offline cache, three-record pending journal, GM65 scanner,
Wi-Fi, and HTTP server. `/status` continued to report:

```json
{
  "desktopOnline": false,
  "rtc": true,
  "sd": true,
  "offlineCacheAvailable": true,
  "offlineCacheItems": 2,
  "pendingSyncItems": 3,
  "offlineReady": true
}
```

A subsequent offline CHECKOUT resumed at event sequence 4, subtracted one from
the reconstructed stock of 3, reported resulting stock 2 with `LOW` status, and
durably increased the pending count to 4.

## Complete power-loss recovery

All system power was removed for approximately ten seconds. After power was
restored, startup again preserved the RTC time and recovered the MicroSD,
two-item cache, four-record pending journal, scanner, integrated workflow,
Wi-Fi, and HTTP server. The offline-ready status remained healthy without an
Electron connection.

Additional RESTOCK verification produced the final durable sequence:

```text
+1
+1
-1
-1
+1
+1
```

Starting from cache stock 2, firmware reconstructed and reported effective
offline stock 4. `/status` reported `pendingSyncItems: 6`, and event identifiers
continued monotonically through sequence 6 across reset and complete power
loss.

The six pending records are intentionally retained on the physical MicroSD for
future Phase 7 synchronization testing. They were not imported into SQLite,
acknowledged, archived, deleted, or cleared during this checkpoint.

## Handling precaution

The MicroSD module was accidentally moved once during testing. The subsequent
reboot and rescan recovered a journal count and effective stock consistent with
the committed records; this manual disturbance was not treated as a firmware
failure.

Do not move, remove, or reconnect the MicroSD card or module while the system is
powered or while a write may be active. Intentional hot-removal support is not
part of the current design.

## Scope boundary

This checkpoint verifies local offline durability only. Phase 7 remains
responsible for retrieving, importing, deduplicating, acknowledging, and
archiving pending offline transactions. No synchronization behavior is included
in Phase 6 Step 3.
