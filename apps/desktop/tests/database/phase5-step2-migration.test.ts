// @vitest-environment node

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../../src/main/database";
import { initialSchemaMigration } from "../../src/main/database/migrations/001-initial-schema";
import { phase2InventoryMigration } from "../../src/main/database/migrations/002-phase-2-inventory";
import { phase5Step2HardwareTransactionsMigration } from "../../src/main/database/migrations/003-phase-5-step-2-hardware-transactions";

describe("Phase 5 Step 2 hardware transaction migration", () => {
  let database: SqliteDatabase;

  beforeEach(() => {
    database = new BetterSqlite3(":memory:");
    database.pragma("foreign_keys = ON");
    initialSchemaMigration.up(database);
    phase2InventoryMigration.up(database);
  });

  afterEach(() => {
    database.close();
  });

  function insertMovement(): void {
    const productId = Number(
      database
        .prepare(`
          INSERT INTO products (
            barcode, item_name, category, current_stock, low_stock_threshold
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run("00001234", "Existing Product", "General", 12, 3).lastInsertRowid,
    );
    database
      .prepare(`
        INSERT INTO transactions (
          transaction_id, product_id, barcode, item_name, category, action,
          quantity, previous_stock, new_total, occurred_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "existing-movement",
        productId,
        "00001234",
        "Existing Product",
        "General",
        "RESTOCK",
        2,
        10,
        12,
        "2026-09-05 08:00:00",
        "ONLINE",
      );
  }

  it("adds the durable event receipt table without changing existing movements", () => {
    insertMovement();

    phase5Step2HardwareTransactionsMigration.up(database);

    expect(
      database.prepare("SELECT transaction_id, new_total FROM transactions").all(),
    ).toEqual([{ transaction_id: "existing-movement", new_total: 12 }]);
    expect(
      database.prepare("PRAGMA table_info(processed_hardware_events)").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "event_id", pk: 1, notnull: 1 }),
        expect.objectContaining({ name: "transaction_id", notnull: 1 }),
        expect.objectContaining({ name: "resulting_status", notnull: 1 }),
        expect.objectContaining({ name: "processed_at", notnull: 1 }),
      ]),
    );
  });

  it("enforces unique event and movement receipts plus transaction integrity", () => {
    insertMovement();
    phase5Step2HardwareTransactionsMigration.up(database);
    const insertReceipt = database.prepare(`
      INSERT INTO processed_hardware_events (
        event_id, transaction_id, resulting_status
      ) VALUES (?, ?, ?)
    `);

    insertReceipt.run("event-1", "existing-movement", "HIGH");
    expect(() =>
      insertReceipt.run("event-1", "missing-movement", "HIGH"),
    ).toThrow(/UNIQUE constraint failed/i);
    expect(() =>
      insertReceipt.run("event-2", "existing-movement", "HIGH"),
    ).toThrow(/UNIQUE constraint failed/i);
    expect(() =>
      insertReceipt.run("event-3", "missing-movement", "HIGH"),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() =>
      database
        .prepare("UPDATE processed_hardware_events SET resulting_status = 'UNKNOWN'")
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});
