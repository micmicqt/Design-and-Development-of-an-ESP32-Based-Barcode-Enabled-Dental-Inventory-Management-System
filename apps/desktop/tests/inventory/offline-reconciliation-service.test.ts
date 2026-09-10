import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OfflinePendingEvent } from "../../src/shared/ipc-contract";
import { initializeDatabase, type SqliteDatabase } from "../../src/main/database";
import {
  createInventoryService,
  type InventoryService,
  type OfflineReconciliationConflictError,
} from "../../src/main/inventory";

const GENERATION = `v1-${"a".repeat(64)}`;

function pendingEvent(overrides: Partial<OfflinePendingEvent> = {}): OfflinePendingEvent {
  return {
    eventId: "off-ABCDEF123456-0000000000000001",
    timestamp: "2026-09-09 10:11:12",
    productId: "1",
    barcode: "000123",
    action: "RESTOCK",
    delta: 1,
    resultingStock: 42,
    stockStatus: "HIGH",
    cacheGeneration: GENERATION,
    ...overrides,
  };
}

describe("InventoryService offline reconciliation", () => {
  let database: SqliteDatabase;
  let inventory: InventoryService;
  let nextTransaction = 1;

  beforeEach(() => {
    database = initializeDatabase({ databasePath: ":memory:" });
    inventory = createInventoryService(database, {
      createTransactionId: () => `offline-tx-${nextTransaction++}`,
    });
    inventory.createProduct({
      barcode: "000123",
      itemName: "Composite",
      category: "Restorative & Esthetic",
      initialStock: 5,
      lowStockThreshold: 2,
    });
  });

  afterEach(() => database.close());

  function expectNoOfflineMutation(stock = 5): void {
    expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(stock);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM offline_reconciliation_receipts")
        .get(),
    ).toEqual({ count: 0 });
  }

  it("applies one delta to authoritative stock and writes one timestamped OFFLINE movement", () => {
    const result = inventory.reconcileOfflineEvent(pendingEvent());

    expect(result).toEqual({
      status: "APPLIED",
      receipt: {
        eventId: "off-ABCDEF123456-0000000000000001",
        transactionId: "offline-tx-1",
        productId: 1,
        barcode: "000123",
        itemName: "Composite",
        category: "Restorative & Esthetic",
        action: "RESTOCK",
        delta: 1,
        previousStock: 5,
        newTotal: 6,
        status: "HIGH",
        offlineResultingStock: 42,
        offlineStockStatus: "HIGH",
        timestamp: "2026-09-09 10:11:12",
        cacheGeneration: GENERATION,
      },
    });
    expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(6);
    expect(inventory.listMovementHistory()).toEqual([
      expect.objectContaining({
        transactionId: "offline-tx-1",
        action: "RESTOCK",
        quantity: 1,
        previousStock: 5,
        newTotal: 6,
        occurredAt: "2026-09-09 10:11:12",
        source: "OFFLINE",
      }),
    ]);
  });

  it("ignores cached resulting stock when applying a checkout", () => {
    const result = inventory.reconcileOfflineEvent(
      pendingEvent({
        action: "CHECKOUT",
        delta: -1,
        resultingStock: 1,
        stockStatus: "LOW",
      }),
    );

    expect(result.receipt).toMatchObject({
      previousStock: 5,
      newTotal: 4,
      status: "HIGH",
      offlineResultingStock: 1,
      offlineStockStatus: "LOW",
    });
    expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(4);
  });

  it.each([
    {
      label: "LOW",
      currentStock: 1,
      threshold: 2,
      action: "RESTOCK" as const,
      delta: 1 as const,
      offlineResultingStock: 50,
      offlineStockStatus: "HIGH" as const,
      expectedStock: 2,
      expectedStatus: "LOW" as const,
    },
    {
      label: "EMPTY",
      currentStock: 1,
      threshold: 2,
      action: "CHECKOUT" as const,
      delta: -1 as const,
      offlineResultingStock: 0,
      offlineStockStatus: "EMPTY" as const,
      expectedStock: 0,
      expectedStatus: "EMPTY" as const,
    },
  ])(
    "derives $label from authoritative SQLite stock instead of the cached status",
    ({
      currentStock,
      threshold,
      action,
      delta,
      offlineResultingStock,
      offlineStockStatus,
      expectedStock,
      expectedStatus,
    }) => {
      database
        .prepare("UPDATE products SET current_stock = ?, low_stock_threshold = ? WHERE id = 1")
        .run(currentStock, threshold);

      const result = inventory.reconcileOfflineEvent(
        pendingEvent({
          action,
          delta,
          resultingStock: offlineResultingStock,
          stockStatus: offlineStockStatus,
        }),
      );

      expect(result.receipt).toMatchObject({
        previousStock: currentStock,
        newTotal: expectedStock,
        status: expectedStatus,
        offlineResultingStock,
        offlineStockStatus,
      });
      expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(expectedStock);
    },
  );

  it("returns an exact durable replay after closing and reopening SQLite", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "dental-offline-replay-"));
    const databasePath = join(directory, "inventory.db");
    try {
      database = initializeDatabase({ databasePath });
      inventory = createInventoryService(database, {
        createTransactionId: () => "durable-offline-tx",
      });
      const product = inventory.createProduct({
        barcode: "reopen-001",
        itemName: "Reopen Product",
        category: "General",
        initialStock: 2,
        lowStockThreshold: 1,
      });
      const event = pendingEvent({ productId: String(product.id), barcode: "reopen-001" });
      const applied = inventory.reconcileOfflineEvent(event);
      database.close();

      database = initializeDatabase({ databasePath });
      inventory = createInventoryService(database, {
        createTransactionId: () => "must-not-be-used",
      });
      expect(inventory.reconcileOfflineEvent(event)).toEqual({
        status: "ALREADY_APPLIED",
        receipt: applied.receipt,
      });
      expect(inventory.findProductByBarcode("reopen-001")?.currentStock).toBe(3);
      expect(inventory.listMovementHistory()).toHaveLength(1);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM offline_reconciliation_receipts")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
      database = initializeDatabase({ databasePath: ":memory:" });
    }
  });

  it("rejects a changed replay under the same event ID", () => {
    inventory.reconcileOfflineEvent(pendingEvent());

    expect(() =>
      inventory.reconcileOfflineEvent(
        pendingEvent({ cacheGeneration: `v1-${"b".repeat(64)}` }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<OfflineReconciliationConflictError>>({
        code: "EVENT_ID_CONFLICT",
      }),
    );
    expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(6);
    expect(inventory.listMovementHistory()).toHaveLength(1);
  });

  it.each([
    {
      name: "a missing product",
      event: pendingEvent({ productId: "999" }),
      code: "PRODUCT_NOT_ACTIVE",
    },
    {
      name: "an exact product identity mismatch",
      event: pendingEvent({ barcode: "000124" }),
      code: "PRODUCT_IDENTITY_CONFLICT",
    },
  ])("fails closed for $name", ({ event, code }) => {
    expect(() => inventory.reconcileOfflineEvent(event)).toThrowError(
      expect.objectContaining({ code }),
    );
    expectNoOfflineMutation();
  });

  it("fails closed when the referenced product was soft-deleted", () => {
    inventory.deleteProduct({ id: 1 });

    expect(() => inventory.reconcileOfflineEvent(pendingEvent())).toThrowError(
      expect.objectContaining({ code: "PRODUCT_NOT_ACTIVE" }),
    );
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM offline_reconciliation_receipts")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed for a zero-stock checkout", () => {
    inventory.updateProduct({
      id: 1,
      itemName: "Composite",
      category: "Restorative & Esthetic",
      currentStock: 0,
      lowStockThreshold: 2,
    });
    const historyBefore = inventory.listMovementHistory();

    expect(() =>
      inventory.reconcileOfflineEvent(
        pendingEvent({
          action: "CHECKOUT",
          delta: -1,
          resultingStock: 0,
          stockStatus: "EMPTY",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_STOCK" }));
    expect(inventory.findProductByBarcode("000123")?.currentStock).toBe(0);
    expect(inventory.listMovementHistory()).toEqual(historyBefore);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM offline_reconciliation_receipts").get(),
    ).toEqual({ count: 0 });
  });

  it("returns INVALID_EVENT for an action/delta mismatch without mutating", () => {
    const invalid = { ...pendingEvent(), action: "CHECKOUT", delta: 1 } as OfflinePendingEvent;
    expect(() => inventory.reconcileOfflineEvent(invalid)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expectNoOfflineMutation();
  });

  it("rolls back stock when movement insertion fails", () => {
    database.exec(`
      CREATE TRIGGER fail_offline_movement
      BEFORE INSERT ON transactions
      WHEN NEW.source = 'OFFLINE'
      BEGIN
        SELECT RAISE(ABORT, 'injected movement failure');
      END;
    `);
    expect(() => inventory.reconcileOfflineEvent(pendingEvent())).toThrow(
      /injected movement failure/,
    );
    expectNoOfflineMutation();
  });

  it("rolls back stock and movement when receipt insertion fails", () => {
    database.exec(`
      CREATE TRIGGER fail_offline_receipt
      BEFORE INSERT ON offline_reconciliation_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt failure');
      END;
    `);
    expect(() => inventory.reconcileOfflineEvent(pendingEvent())).toThrow(
      /injected receipt failure/,
    );
    expectNoOfflineMutation();
  });
});
