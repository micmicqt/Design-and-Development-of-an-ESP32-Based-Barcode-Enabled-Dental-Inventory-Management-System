// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  initializeDatabase,
  type SqliteDatabase,
} from "../../src/main/database";
import { INVENTORY_CATEGORIES } from "../../src/main/domain";

interface ProductInput {
  barcode: string;
  category?: string;
  currentStock?: number;
  lowStockThreshold?: number;
}

describe("database migrations and constraints", () => {
  let database: SqliteDatabase;

  beforeEach(() => {
    database = initializeDatabase({ databasePath: ":memory:" });
  });

  afterEach(() => {
    database.close();
  });

  function insertProduct(input: ProductInput): number {
    const result = database
      .prepare(
        `INSERT INTO products (
          barcode,
          item_name,
          category,
          current_stock,
          low_stock_threshold
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.barcode,
        `Product ${input.barcode}`,
        input.category ?? "General",
        input.currentStock ?? 0,
        input.lowStockThreshold ?? 0,
      );

    return Number(result.lastInsertRowid);
  }

  it("initializes all required tables and records its migration", () => {
    const tableNames = (
      database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(tableNames).toEqual([
      "configured_admin",
      "offline_event_identities",
      "offline_reconciliation_receipts",
      "processed_hardware_events",
      "products",
      "schema_migrations",
      "transactions",
    ]);
    expect(
      database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: "initial_phase_1_schema" },
      { version: 2, name: "phase_2_inventory_crud" },
      { version: 3, name: "phase_5_step_2_hardware_transactions" },
      { version: 4, name: "phase_5_step_3_result_delivery" },
      { version: 5, name: "phase_7_step_2_offline_reconciliation" },
      { version: 6, name: "phase_8_step_2_product_unit_type" },
      { version: 7, name: "offline_event_identities" },
    ]);
  });

  it("can re-run migration initialization without changing schema state", () => {
    applyDatabaseMigrations(database);
    applyDatabaseMigrations(database);

    const result = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    expect(result.count).toBe(7);
  });

  it("accepts all six fixed categories and rejects any other category", () => {
    INVENTORY_CATEGORIES.forEach((category, index) => {
      expect(() =>
        insertProduct({ barcode: `valid-${index}`, category }),
      ).not.toThrow();
    });

    expect(() =>
      insertProduct({ barcode: "invalid-category", category: "Consumables" }),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("rejects a duplicate barcode", () => {
    insertProduct({ barcode: "4801234567890" });

    expect(() => insertProduct({ barcode: "4801234567890" })).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it("rejects negative current stock", () => {
    expect(() =>
      insertProduct({ barcode: "negative-stock", currentStock: -1 }),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("rejects a negative low-stock threshold", () => {
    expect(() =>
      insertProduct({ barcode: "negative-threshold", lowStockThreshold: -1 }),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("derives status outside SQLite rather than storing a status column", () => {
    const productColumns = (
      database.prepare("PRAGMA table_info(products)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);

    expect(productColumns).not.toContain("status");
  });

  it("keeps transaction IDs unique and enforces stock arithmetic", () => {
    const productId = insertProduct({
      barcode: "transaction-product",
      currentStock: 10,
      lowStockThreshold: 2,
    });
    const insertTransaction = database.prepare(
      `INSERT INTO transactions (
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
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertTransaction.run(
      "transaction-001",
      productId,
      "transaction-product",
      "Transaction Product",
      "General",
      "RESTOCK",
      2,
      10,
      12,
      "2026-08-30 16:45:12",
      "ONLINE",
    );

    expect(() =>
      insertTransaction.run(
        "transaction-001",
        productId,
        "transaction-product",
        "Transaction Product",
        "General",
        "RESTOCK",
        2,
        10,
        12,
        "2026-08-30 16:45:12",
        "ONLINE",
      ),
    ).toThrow(/UNIQUE constraint failed/i);

    expect(() =>
      insertTransaction.run(
        "transaction-bad-arithmetic",
        productId,
        "transaction-product",
        "Transaction Product",
        "General",
        "CHECKOUT",
        2,
        10,
        9,
        "2026-08-30 16:45:13",
        "OFFLINE",
      ),
    ).toThrow(/CHECK constraint failed/i);
  });
});
