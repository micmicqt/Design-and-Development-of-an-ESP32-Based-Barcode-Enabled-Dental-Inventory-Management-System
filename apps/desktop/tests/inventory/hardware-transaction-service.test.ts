// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HardwareTransactionEvent } from "../../src/shared/ipc-contract";
import {
  initializeDatabase,
  type SqliteDatabase,
} from "../../src/main/database";
import {
  InventoryValidationError,
  ProductNotFoundError,
  createInventoryService,
  type InventoryService,
} from "../../src/main/inventory";

const restockEvent: HardwareTransactionEvent = {
  eventId: "device-session-restock-1",
  mode: "restock",
  barcode: "0000123456",
  timestamp: "2026-09-05 09:30:00",
};

const checkoutEvent: HardwareTransactionEvent = {
  eventId: "device-session-checkout-1",
  mode: "checkout",
  barcode: "0000123456",
  timestamp: "2026-09-05 09:31:00",
};

describe("InventoryService hardware transactions", () => {
  let database: SqliteDatabase;
  let inventory: InventoryService;
  let transactionSequence: number;

  beforeEach(() => {
    database = initializeDatabase({ databasePath: ":memory:" });
    transactionSequence = 0;
    inventory = createInventoryService(database, {
      createTransactionId: () => `hardware-movement-${++transactionSequence}`,
    });
  });

  afterEach(() => {
    database.close();
  });

  function createProduct(options: {
    barcode?: string;
    stock?: number;
    threshold?: number;
  } = {}) {
    return inventory.createProduct({
      barcode: options.barcode ?? "0000123456",
      itemName: "Composite Resin",
      category: "Restorative & Esthetic",
      initialStock: options.stock ?? 10,
      lowStockThreshold: options.threshold ?? 4,
    });
  }

  function receiptCount(): number {
    return (
      database
        .prepare("SELECT COUNT(*) AS count FROM processed_hardware_events")
        .get() as { count: number }
    ).count;
  }

  it("atomically restocks, derives status, and inserts exactly one history snapshot", () => {
    const product = createProduct({ stock: 3, threshold: 4 });

    const receipt = inventory.processHardwareTransaction({
      event: restockEvent,
      quantity: 2,
    });

    expect(receipt).toEqual({
      ...restockEvent,
      transactionId: "hardware-movement-1",
      productId: product.id,
      itemName: product.itemName,
      category: product.category,
      quantity: 2,
      previousStock: 3,
      newTotal: 5,
      status: "HIGH",
      resultDeliveredToHardware: false,
    });
    expect(inventory.findProductByBarcode(product.barcode)).toMatchObject({
      currentStock: 5,
      status: "HIGH",
    });
    expect(inventory.listMovementHistory()).toEqual([
      expect.objectContaining({
        transactionId: "hardware-movement-1",
        productId: product.id,
        barcode: product.barcode,
        itemName: product.itemName,
        category: product.category,
        action: "RESTOCK",
        quantity: 2,
        previousStock: 3,
        newTotal: 5,
        occurredAt: restockEvent.timestamp,
        source: "ONLINE",
      }),
    ]);
    expect(inventory.findHardwareTransactionReceipt(restockEvent.eventId)).toEqual(receipt);
  });

  it("checks out to exactly zero and records EMPTY without negative stock", () => {
    const product = createProduct({ stock: 2, threshold: 4 });

    const receipt = inventory.processHardwareTransaction({
      event: checkoutEvent,
      quantity: 2,
    });

    expect(receipt).toMatchObject({
      productId: product.id,
      previousStock: 2,
      newTotal: 0,
      status: "EMPTY",
      mode: "checkout",
      quantity: 2,
    });
    expect(inventory.findProductByBarcode(product.barcode)).toMatchObject({
      currentStock: 0,
      status: "EMPTY",
    });
    expect(inventory.listMovementHistory()).toEqual([
      expect.objectContaining({
        action: "CHECKOUT",
        quantity: 2,
        previousStock: 2,
        newTotal: 0,
      }),
    ]);
  });

  it("rejects insufficient and zero checkout stock without any partial write", () => {
    const product = createProduct({ stock: 2 });

    expect(() =>
      inventory.processHardwareTransaction({ event: checkoutEvent, quantity: 3 }),
    ).toThrow(/Insufficient stock.*2 available/i);
    expect(inventory.findProductByBarcode(product.barcode)?.currentStock).toBe(2);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);

    inventory.updateProduct({
      id: product.id,
      itemName: product.itemName,
      category: product.category,
      currentStock: 0,
      lowStockThreshold: product.lowStockThreshold,
    });
    const historyBefore = inventory.listMovementHistory();

    expect(() =>
      inventory.processHardwareTransaction({
        event: { ...checkoutEvent, eventId: "device-session-checkout-zero" },
        quantity: 1,
      }),
    ).toThrow(/Insufficient stock.*0 available/i);
    expect(inventory.findProductByBarcode(product.barcode)?.currentStock).toBe(0);
    expect(inventory.listMovementHistory()).toEqual(historyBefore);
    expect(receiptCount()).toBe(0);
  });

  it("re-reads current stock instead of trusting an earlier product snapshot", () => {
    const product = createProduct({ stock: 10 });
    inventory.updateProduct({
      id: product.id,
      itemName: product.itemName,
      category: product.category,
      currentStock: 1,
      lowStockThreshold: product.lowStockThreshold,
    });
    const historyBefore = inventory.listMovementHistory();

    expect(() =>
      inventory.processHardwareTransaction({ event: checkoutEvent, quantity: 2 }),
    ).toThrow(/Only 1 available/i);
    expect(inventory.findProductByBarcode(product.barcode)?.currentStock).toBe(1);
    expect(inventory.listMovementHistory()).toEqual(historyBefore);
    expect(receiptCount()).toBe(0);
  });

  it("preserves exact barcode text and leading zeroes when selecting the product", () => {
    const padded = createProduct({ barcode: "0000123456", stock: 4 });
    const unpadded = createProduct({ barcode: "123456", stock: 20 });

    const receipt = inventory.processHardwareTransaction({
      event: restockEvent,
      quantity: 1,
    });

    expect(receipt).toMatchObject({ productId: padded.id, barcode: "0000123456" });
    expect(inventory.findProductByBarcode("0000123456")?.currentStock).toBe(5);
    expect(inventory.findProductByBarcode("123456")?.currentStock).toBe(20);
    expect(receipt.productId).not.toBe(unpadded.id);
  });

  it("rejects unknown and deleted barcodes without creating history or receipts", () => {
    const deleted = createProduct();
    inventory.deleteProduct({ id: deleted.id });

    expect(() =>
      inventory.processHardwareTransaction({
        event: { ...restockEvent, eventId: "unknown-event", barcode: "unknown" },
        quantity: 1,
      }),
    ).toThrow(ProductNotFoundError);
    expect(() =>
      inventory.processHardwareTransaction({
        event: { ...restockEvent, eventId: "deleted-event" },
        quantity: 1,
      }),
    ).toThrow(ProductNotFoundError);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["decimal", 1.5],
    ["too large", 10_001],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["text", "2"],
  ])("rejects %s quantity before writing", (_label, quantity) => {
    createProduct();

    expect(() =>
      inventory.processHardwareTransaction({
        event: restockEvent,
        quantity: quantity as number,
      }),
    ).toThrow(InventoryValidationError);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it.each([
    ["event ID", { eventId: "bad event" }],
    ["mode", { mode: "remove" }],
    ["barcode", { barcode: "invalid,barcode" }],
    ["timestamp format", { timestamp: "2026-09-05T09:30:00Z" }],
    ["timestamp date", { timestamp: "2026-02-29 09:30:00" }],
  ])("rejects an invalid hardware %s before writing", (_label, override) => {
    createProduct();

    expect(() =>
      inventory.processHardwareTransaction({
        event: { ...restockEvent, ...override } as HardwareTransactionEvent,
        quantity: 1,
      }),
    ).toThrow(InventoryValidationError);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it("rolls back before history when the stock update fails", () => {
    createProduct();
    database.exec(`
      CREATE TRIGGER fail_hardware_stock_update
      BEFORE UPDATE OF current_stock ON products
      BEGIN
        SELECT RAISE(ABORT, 'injected stock update failure');
      END;
    `);

    expect(() =>
      inventory.processHardwareTransaction({ event: restockEvent, quantity: 1 }),
    ).toThrow(/injected stock update failure/i);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it("rolls stock back when history insertion fails", () => {
    createProduct();
    database.exec(`
      CREATE TRIGGER fail_hardware_history_insert
      BEFORE INSERT ON transactions
      WHEN NEW.action IN ('RESTOCK', 'CHECKOUT')
      BEGIN
        SELECT RAISE(ABORT, 'injected history failure');
      END;
    `);

    expect(() =>
      inventory.processHardwareTransaction({ event: restockEvent, quantity: 1 }),
    ).toThrow(/injected history failure/i);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it("rolls stock and history back when durable receipt insertion fails", () => {
    createProduct();
    database.exec(`
      CREATE TRIGGER fail_hardware_receipt_insert
      BEFORE INSERT ON processed_hardware_events
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt failure');
      END;
    `);

    expect(() =>
      inventory.processHardwareTransaction({ event: restockEvent, quantity: 1 }),
    ).toThrow(/injected receipt failure/i);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });

  it("returns the same durable receipt for an exact retry without mutating twice", () => {
    createProduct();
    const input = { event: restockEvent, quantity: 2 };

    const first = inventory.processHardwareTransaction(input);
    const retry = inventory.processHardwareTransaction(input);

    expect(retry).toEqual(first);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(12);
    expect(inventory.listMovementHistory()).toHaveLength(1);
    expect(receiptCount()).toBe(1);
    expect(transactionSequence).toBe(1);
  });

  it("durably marks result delivery without changing stock or history", () => {
    createProduct();
    const committed = inventory.processHardwareTransaction({
      event: restockEvent,
      quantity: 2,
    });

    expect(committed.resultDeliveredToHardware).toBe(false);
    const delivered = inventory.markHardwareTransactionResultDelivered(
      restockEvent.eventId,
    );
    expect(delivered).toEqual({ ...committed, resultDeliveredToHardware: true });
    expect(
      inventory.markHardwareTransactionResultDelivered(restockEvent.eventId),
    ).toEqual(delivered);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(12);
    expect(inventory.listMovementHistory()).toHaveLength(1);
    expect(receiptCount()).toBe(1);
  });

  it("cannot mark result delivery without a committed receipt", () => {
    expect(() =>
      inventory.markHardwareTransactionResultDelivered(restockEvent.eventId),
    ).toThrow(/No committed transaction/i);
  });

  it("rejects a reused event ID with different transaction details", () => {
    createProduct();
    inventory.processHardwareTransaction({ event: restockEvent, quantity: 2 });

    expect(() =>
      inventory.processHardwareTransaction({ event: restockEvent, quantity: 3 }),
    ).toThrow(/already processed with different transaction details/i);
    expect(() =>
      inventory.processHardwareTransaction({
        event: { ...restockEvent, mode: "checkout" },
        quantity: 2,
      }),
    ).toThrow(/already processed with different transaction details/i);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(12);
    expect(inventory.listMovementHistory()).toHaveLength(1);
    expect(receiptCount()).toBe(1);
  });

  it("rejects RESTOCK overflow without writing", () => {
    createProduct({ stock: Number.MAX_SAFE_INTEGER });

    expect(() =>
      inventory.processHardwareTransaction({ event: restockEvent, quantity: 1 }),
    ).toThrow(/supported inventory range/i);
    expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(inventory.listMovementHistory()).toEqual([]);
    expect(receiptCount()).toBe(0);
  });
});

describe("InventoryService durable hardware idempotency", () => {
  it("survives database close and reopen without a second stock mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "dental-phase5-step2-"));
    const databasePath = join(directory, "isolated-inventory.db");
    let database: SqliteDatabase | null = null;

    try {
      database = initializeDatabase({ databasePath });
      let transactionSequence = 0;
      let inventory = createInventoryService(database, {
        createTransactionId: () => `reopen-movement-${++transactionSequence}`,
      });
      inventory.createProduct({
        barcode: restockEvent.barcode,
        itemName: "Persistent Product",
        category: "General",
        initialStock: 8,
        lowStockThreshold: 3,
      });
      const first = inventory.processHardwareTransaction({
        event: restockEvent,
        quantity: 2,
      });
      const delivered = inventory.markHardwareTransactionResultDelivered(
        restockEvent.eventId,
      );
      expect(delivered).toEqual({ ...first, resultDeliveredToHardware: true });
      database.close();
      database = null;

      database = initializeDatabase({ databasePath });
      inventory = createInventoryService(database, {
        createTransactionId: () => {
          throw new Error("A duplicate must not allocate another transaction ID.");
        },
      });

      expect(inventory.findHardwareTransactionReceipt(restockEvent.eventId)).toEqual(delivered);
      expect(
        inventory.processHardwareTransaction({ event: restockEvent, quantity: 2 }),
      ).toEqual(delivered);
      expect(inventory.findProductByBarcode(restockEvent.barcode)?.currentStock).toBe(10);
      expect(inventory.listMovementHistory()).toHaveLength(1);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM processed_hardware_events")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
