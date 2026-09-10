import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialSchemaMigration } from "../../src/main/database/migrations/001-initial-schema";
import { phase2InventoryMigration } from "../../src/main/database/migrations/002-phase-2-inventory";
import { phase5Step2HardwareTransactionsMigration } from "../../src/main/database/migrations/003-phase-5-step-2-hardware-transactions";
import { phase5Step3ResultDeliveryMigration } from "../../src/main/database/migrations/004-phase-5-step-3-result-delivery";
import { phase7Step2OfflineReconciliationMigration } from "../../src/main/database/migrations/005-phase-7-step-2-offline-reconciliation";

describe("Phase 7 Step 2 offline reconciliation migration", () => {
  let database: BetterSqlite3.Database;

  beforeEach(() => {
    database = new BetterSqlite3(":memory:");
    database.pragma("foreign_keys = ON");
    initialSchemaMigration.up(database);
    phase2InventoryMigration.up(database);
    phase5Step2HardwareTransactionsMigration.up(database);
    phase5Step3ResultDeliveryMigration.up(database);
  });

  afterEach(() => database.close());

  function insertProduct(): number {
    return Number(
      database
        .prepare(`
          INSERT INTO products (
            barcode, item_name, category, current_stock, low_stock_threshold
          ) VALUES ('000123', 'Composite', 'Restorative & Esthetic', 5, 2)
        `)
        .run().lastInsertRowid,
    );
  }

  function insertMovement(
    transactionId: string,
    productId: number,
    source: "ONLINE" | "OFFLINE",
  ): void {
    database
      .prepare(`
        INSERT INTO transactions (
          transaction_id, product_id, barcode, item_name, category, action,
          quantity, previous_stock, new_total, occurred_at, source
        ) VALUES (?, ?, '000123', 'Composite', 'Restorative & Esthetic',
          'RESTOCK', 1, 5, 6, '2026-09-09 10:11:12', ?)
      `)
      .run(transactionId, productId, source);
  }

  it("adds a dedicated receipt without changing Phase 5 receipts or movements", () => {
    const productId = insertProduct();
    insertMovement("online-movement", productId, "ONLINE");
    database
      .prepare(`
        INSERT INTO processed_hardware_events (
          event_id, transaction_id, resulting_status, result_delivered_at
        ) VALUES ('online-event', 'online-movement', 'HIGH', NULL)
      `)
      .run();

    phase7Step2OfflineReconciliationMigration.up(database);

    expect(
      database.prepare("SELECT * FROM processed_hardware_events").all(),
    ).toEqual([
      expect.objectContaining({ event_id: "online-event", transaction_id: "online-movement" }),
    ]);
    expect(
      database.prepare("PRAGMA table_info(offline_reconciliation_receipts)").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "event_id", pk: 1, notnull: 1 }),
        expect.objectContaining({ name: "transaction_id", notnull: 1 }),
        expect.objectContaining({ name: "cached_resulting_stock", notnull: 1 }),
        expect.objectContaining({ name: "cached_stock_status", notnull: 1 }),
        expect.objectContaining({ name: "resulting_status", notnull: 1 }),
      ]),
    );
  });

  it("enforces one receipt per offline event and action/delta integrity", () => {
    const productId = insertProduct();
    phase7Step2OfflineReconciliationMigration.up(database);
    insertMovement("offline-movement", productId, "OFFLINE");

    const insertReceipt = database.prepare(`
      INSERT INTO offline_reconciliation_receipts (
        event_id, transaction_id, event_timestamp, product_id, barcode,
        action, delta, cached_resulting_stock, cached_stock_status,
        cache_generation, resulting_status
      ) VALUES (?, ?, '2026-09-09 10:11:12', ?, '000123', ?, ?, 6, 'HIGH',
        ?, 'HIGH')
    `);
    const generation = `v1-${"a".repeat(64)}`;

    insertReceipt.run(
      "off-ABCDEF123456-0000000000000001",
      "offline-movement",
      productId,
      "RESTOCK",
      1,
      generation,
    );
    expect(() =>
      insertReceipt.run(
        "off-ABCDEF123456-0000000000000002",
        "offline-movement",
        productId,
        "RESTOCK",
        1,
        generation,
      ),
    ).toThrow(/UNIQUE constraint failed/i);
    expect(() =>
      database
        .prepare(
          "UPDATE offline_reconciliation_receipts SET delta = -1 WHERE event_id = ?",
        )
        .run("off-ABCDEF123456-0000000000000001"),
    ).toThrow(/CHECK constraint failed/i);
  });
});
