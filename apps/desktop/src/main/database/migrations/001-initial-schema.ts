import { INVENTORY_CATEGORIES } from "../../domain/inventory";
import type { DatabaseMigration } from "./types";

const categoryValues = INVENTORY_CATEGORIES.map(
  (category) => `'${category.replaceAll("'", "''")}'`,
).join(", ");

export const initialSchemaMigration: DatabaseMigration = {
  version: 1,
  name: "initial_phase_1_schema",
  up(database) {
    database.exec(`
      CREATE TABLE configured_admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL COLLATE NOCASE UNIQUE
          CHECK (length(trim(username)) BETWEEN 1 AND 100),
        password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barcode TEXT NOT NULL UNIQUE CHECK (length(trim(barcode)) > 0),
        item_name TEXT NOT NULL CHECK (length(trim(item_name)) > 0),
        category TEXT NOT NULL CHECK (category IN (${categoryValues})),
        image_path TEXT NOT NULL DEFAULT '',
        current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
        low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE transactions (
        transaction_id TEXT PRIMARY KEY CHECK (length(trim(transaction_id)) > 0),
        product_id INTEGER NOT NULL,
        barcode TEXT NOT NULL CHECK (length(trim(barcode)) > 0),
        item_name TEXT NOT NULL CHECK (length(trim(item_name)) > 0),
        category TEXT NOT NULL CHECK (category IN (${categoryValues})),
        action TEXT NOT NULL CHECK (action IN ('RESTOCK', 'CHECKOUT')),
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
        )
      ) STRICT;

      CREATE INDEX transactions_occurred_at_index
        ON transactions (occurred_at DESC);
      CREATE INDEX transactions_product_id_index
        ON transactions (product_id);
      CREATE INDEX transactions_barcode_index
        ON transactions (barcode);
    `);
  },
};

