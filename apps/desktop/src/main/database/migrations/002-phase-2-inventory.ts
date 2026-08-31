import { INVENTORY_CATEGORIES } from "../../domain/inventory";
import type { DatabaseMigration } from "./types";

const categoryValues = INVENTORY_CATEGORIES.map(
  (category) => `'${category.replaceAll("'", "''")}'`,
).join(", ");

/**
 * Phase 2 keeps products as the parent of their permanent movement snapshots.
 * Products are therefore retired with `deleted_at` instead of being removed.
 * SQLite cannot alter a CHECK constraint in place, so the child table is
 * rebuilt to add STOCK_CORRECTION while retaining every Phase 1 row.
 */
export const phase2InventoryMigration: DatabaseMigration = {
  version: 2,
  name: "phase_2_inventory_crud",
  up(database) {
    database.exec(`
      ALTER TABLE products
        ADD COLUMN deleted_at TEXT
          CHECK (deleted_at IS NULL OR length(trim(deleted_at)) > 0);

      CREATE INDEX products_deleted_at_index
        ON products (deleted_at);

      CREATE TABLE transactions_phase_2 (
        transaction_id TEXT PRIMARY KEY CHECK (length(trim(transaction_id)) > 0),
        product_id INTEGER NOT NULL,
        barcode TEXT NOT NULL CHECK (length(trim(barcode)) > 0),
        item_name TEXT NOT NULL CHECK (length(trim(item_name)) > 0),
        category TEXT NOT NULL CHECK (category IN (${categoryValues})),
        action TEXT NOT NULL
          CHECK (action IN ('RESTOCK', 'CHECKOUT', 'STOCK_CORRECTION')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        previous_stock INTEGER NOT NULL CHECK (previous_stock >= 0),
        new_total INTEGER NOT NULL CHECK (new_total >= 0),
        occurred_at TEXT NOT NULL CHECK (length(trim(occurred_at)) > 0),
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        source TEXT NOT NULL CHECK (source IN ('ONLINE', 'OFFLINE')),
        FOREIGN KEY (product_id) REFERENCES products(id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        CHECK (
          (action = 'RESTOCK' AND new_total = previous_stock + quantity)
          OR
          (action = 'CHECKOUT' AND new_total = previous_stock - quantity)
          OR
          (
            action = 'STOCK_CORRECTION'
            AND new_total <> previous_stock
            AND quantity = abs(new_total - previous_stock)
          )
        )
      ) STRICT;

      INSERT INTO transactions_phase_2 (
        transaction_id,
        product_id,
        barcode,
        item_name,
        category,
        action,
        quantity,
        previous_stock,
        new_total,
        occurred_at,
        recorded_at,
        source
      )
      SELECT
        transaction_id,
        product_id,
        barcode,
        item_name,
        category,
        action,
        quantity,
        previous_stock,
        new_total,
        occurred_at,
        recorded_at,
        source
      FROM transactions;

      DROP TABLE transactions;
      ALTER TABLE transactions_phase_2 RENAME TO transactions;

      CREATE INDEX transactions_occurred_at_index
        ON transactions (occurred_at DESC);
      CREATE INDEX transactions_product_id_index
        ON transactions (product_id);
      CREATE INDEX transactions_barcode_index
        ON transactions (barcode);
    `);
  },
};
