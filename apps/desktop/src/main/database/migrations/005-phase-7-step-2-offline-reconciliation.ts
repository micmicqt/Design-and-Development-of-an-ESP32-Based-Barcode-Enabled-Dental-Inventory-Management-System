import type { DatabaseMigration } from './types'

/**
 * Keeps the idempotency key and complete firmware audit input for every
 * offline event applied to SQLite. The linked transaction remains the
 * authoritative movement snapshot; cached stock/status are retained only to
 * detect an event-ID collision on a later replay.
 */
export const phase7Step2OfflineReconciliationMigration: DatabaseMigration = {
  version: 5,
  name: 'phase_7_step_2_offline_reconciliation',
  up(database) {
    database.exec(`
      CREATE TABLE offline_reconciliation_receipts (
        event_id TEXT PRIMARY KEY
          CHECK (length(event_id) BETWEEN 1 AND 63),
        transaction_id TEXT NOT NULL UNIQUE,
        event_timestamp TEXT NOT NULL
          CHECK (length(event_timestamp) = 19),
        product_id INTEGER NOT NULL CHECK (product_id > 0),
        barcode TEXT NOT NULL COLLATE BINARY
          CHECK (length(barcode) BETWEEN 1 AND 256),
        action TEXT NOT NULL
          CHECK (action IN ('RESTOCK', 'CHECKOUT')),
        delta INTEGER NOT NULL CHECK (delta IN (-1, 1)),
        cached_resulting_stock INTEGER NOT NULL
          CHECK (cached_resulting_stock >= 0),
        cached_stock_status TEXT NOT NULL
          CHECK (cached_stock_status IN ('HIGH', 'LOW', 'EMPTY')),
        cache_generation TEXT NOT NULL
          CHECK (
            length(cache_generation) = 67
            AND substr(cache_generation, 1, 3) = 'v1-'
            AND substr(cache_generation, 4) NOT GLOB '*[^0-9a-f]*'
          ),
        resulting_status TEXT NOT NULL
          CHECK (resulting_status IN ('HIGH', 'LOW', 'EMPTY')),
        processed_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        CHECK (
          (action = 'RESTOCK' AND delta = 1)
          OR (action = 'CHECKOUT' AND delta = -1)
        ),
        CHECK (
          (cached_resulting_stock = 0 AND cached_stock_status = 'EMPTY')
          OR (cached_resulting_stock > 0 AND cached_stock_status <> 'EMPTY')
        )
      ) STRICT;
    `)
  }
}
