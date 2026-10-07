import { offlineEventFingerprint } from '../../inventory/offline-event-identity'
import type { DatabaseMigration } from './types'

export const offlineEventIdentitiesMigration: DatabaseMigration = {
  version: 7,
  name: 'offline_event_identities',
  up(database) {
    database.exec(`CREATE TABLE offline_event_identities (
      receipt_id TEXT PRIMARY KEY REFERENCES offline_reconciliation_receipts(event_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
      wire_event_id TEXT NOT NULL CHECK(length(wire_event_id) BETWEEN 1 AND 63),
      payload_fingerprint TEXT NOT NULL CHECK(length(payload_fingerprint) = 64
        AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
      identity_kind TEXT NOT NULL CHECK(identity_kind IN ('NORMAL', 'LEGACY_COLLISION')),
      UNIQUE(wire_event_id, payload_fingerprint)
    ) STRICT;`)
    const rows = database.prepare(`SELECT event_id AS eventId, event_timestamp AS timestamp,
      product_id AS productId, barcode, action, delta, cached_resulting_stock AS resultingStock,
      cached_stock_status AS stockStatus, cache_generation AS cacheGeneration
      FROM offline_reconciliation_receipts`).all() as Parameters<typeof offlineEventFingerprint>[0][]
    const insert = database.prepare(`INSERT INTO offline_event_identities
      (receipt_id, wire_event_id, payload_fingerprint, identity_kind) VALUES (?, ?, ?, 'NORMAL')`)
    for (const row of rows) insert.run(row.eventId, row.eventId, offlineEventFingerprint(row))
  }
}
