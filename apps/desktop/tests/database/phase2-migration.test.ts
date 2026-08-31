// @vitest-environment node

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialSchemaMigration } from "../../src/main/database/migrations/001-initial-schema";
import { phase2InventoryMigration } from "../../src/main/database/migrations/002-phase-2-inventory";
import type { SqliteDatabase } from "../../src/main/database";

describe("Phase 2 inventory migration", () => {
  let database: SqliteDatabase;

  beforeEach(() => {
    database = new BetterSqlite3(":memory:");
    database.pragma("foreign_keys = ON");
    initialSchemaMigration.up(database);
  });

  afterEach(() => {
    database.close();
  });

  function insertPhase1Movement(): number {
    const product = database
      .prepare(
        `INSERT INTO products (
          barcode,
          item_name,
          category,
          current_stock,
          low_stock_threshold
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("00001234", "Phase 1 Product", "General", 10, 3);
    const productId = Number(product.lastInsertRowid);

    database
      .prepare(
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
      )
      .run(
        "phase-1-movement",
        productId,
        "00001234",
        "Phase 1 Product",
        "General",
        "RESTOCK",
        2,
        8,
        10,
        "2026-08-30 16:45:12",
        "ONLINE",
      );

    return productId;
  }

  it("preserves Phase 1 movement rows and adds soft deletion", () => {
    const productId = insertPhase1Movement();

    phase2InventoryMigration.up(database);

    expect(
      database
        .prepare("SELECT transaction_id, action, new_total FROM transactions")
        .all(),
    ).toEqual([
      {
        transaction_id: "phase-1-movement",
        action: "RESTOCK",
        new_total: 10,
      },
    ]);

    const columns = database.prepare("PRAGMA table_info(products)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("deleted_at");

    expect(() => database.prepare("DELETE FROM products WHERE id = ?").run(productId)).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  it("accepts valid stock corrections and rejects invalid correction arithmetic", () => {
    const productId = insertPhase1Movement();
    phase2InventoryMigration.up(database);

    const insertCorrection = database.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, 'STOCK_CORRECTION', ?, ?, ?, ?, 'ONLINE')`,
    );

    expect(() =>
      insertCorrection.run(
        "valid-correction",
        productId,
        "00001234",
        "Phase 1 Product",
        "General",
        4,
        10,
        6,
        "2026-08-31T01:00:00.000Z",
      ),
    ).not.toThrow();

    expect(() =>
      insertCorrection.run(
        "invalid-correction",
        productId,
        "00001234",
        "Phase 1 Product",
        "General",
        3,
        10,
        6,
        "2026-08-31T01:01:00.000Z",
      ),
    ).toThrow(/CHECK constraint failed/i);
  });
});
