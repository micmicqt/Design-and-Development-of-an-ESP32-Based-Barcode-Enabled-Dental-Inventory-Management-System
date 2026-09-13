// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateBarcodeError,
  InventoryValidationError,
  ProductNotFoundError,
  createInventoryService,
  type CreateProductInput,
  type InventoryService,
} from "../../src/main/inventory";
import {
  initializeDatabase,
  type SqliteDatabase,
} from "../../src/main/database";

const FIRST_IMAGE =
  "product-images/00000000-0000-4000-8000-000000000001.jpg";
const SECOND_IMAGE =
  "product-images/00000000-0000-4000-8000-000000000002.png";

describe("InventoryService", () => {
  let database: SqliteDatabase;
  let inventory: InventoryService;
  let transactionSequence: number;

  beforeEach(() => {
    database = initializeDatabase({ databasePath: ":memory:" });
    transactionSequence = 0;
    inventory = createInventoryService(database, {
      now: () => new Date("2026-08-31T01:02:03.000Z"),
      createTransactionId: () => {
        transactionSequence += 1;
        return `correction-${transactionSequence}`;
      },
    });
  });

  afterEach(() => {
    database.close();
  });

  function createProduct(
    overrides: Partial<CreateProductInput> = {},
  ) {
    return inventory.createProduct({
      barcode: "0000123456",
      itemName: "Composite Resin",
      category: "Restorative & Esthetic",
      unitType: "Piece",
      initialStock: 10,
      lowStockThreshold: 4,
      ...overrides,
    });
  }

  describe("findProductByBarcode", () => {
    it("returns the exact active product with its existing image and derived status", () => {
      const product = createProduct({
        managedImagePath: FIRST_IMAGE,
        initialStock: 3,
        lowStockThreshold: 4,
      });

      expect(inventory.findProductByBarcode(product.barcode)).toEqual(product);
      expect(inventory.findProductByBarcode(product.barcode)).toMatchObject({
        imagePath: FIRST_IMAGE,
        currentStock: 3,
        status: "LOW",
      });
    });

    it("distinguishes leading-zero barcodes from their numeric-looking counterpart", () => {
      const padded = createProduct({ barcode: "0000123456" });
      const unpadded = createProduct({ barcode: "123456" });

      expect(inventory.findProductByBarcode("0000123456")).toEqual(padded);
      expect(inventory.findProductByBarcode("123456")).toEqual(unpadded);
      expect(inventory.findProductByBarcode("00123456")).toBeNull();
    });

    it.each([
      "sku-AbC-001",
      "SKU-ABC-001",
      " SKU-AbC-001",
      "SKU-AbC-001 ",
      "AbC-001",
      "SKU-AbC-001-extra",
    ])("does not normalize or partially match %j", (barcode) => {
      createProduct({ barcode: "SKU-AbC-001" });
      expect(inventory.findProductByBarcode(barcode)).toBeNull();
    });

    it("preserves whitespace when it is actually present in stored barcode text", () => {
      const product = createProduct({ barcode: "space-sensitive" });
      // Fixture establishes stored text without changing createProduct's
      // pre-existing normalization behavior.
      database
        .prepare("UPDATE products SET barcode = ? WHERE id = ?")
        .run(" space-sensitive ", product.id);

      expect(inventory.findProductByBarcode(" space-sensitive ")).toMatchObject({
        id: product.id,
        barcode: " space-sensitive ",
      });
      expect(inventory.findProductByBarcode("space-sensitive")).toBeNull();
    });

    it.each(["SKU%_001", "' OR 1=1 --", 'ABC"\\001'])(
      "matches SQL-special characters literally for %j",
      (barcode) => {
        const product = createProduct({ barcode });
        createProduct({ barcode: "unrelated" });

        expect(inventory.findProductByBarcode(barcode)).toEqual(product);
        expect(inventory.findProductByBarcode(`${barcode}%`)).toBeNull();
      },
    );

    it("returns null for unknown and soft-deleted barcodes", () => {
      const product = createProduct();
      inventory.deleteProduct({ id: product.id });

      expect(inventory.findProductByBarcode("unknown")).toBeNull();
      expect(inventory.findProductByBarcode(product.barcode)).toBeNull();
    });

    it("accepts the maximum supported barcode length without truncating it", () => {
      const barcode = `00${"x".repeat(254)}`;
      const product = createProduct({ barcode });
      expect(inventory.findProductByBarcode(barcode)).toEqual(product);
      expect(inventory.findProductByBarcode(barcode.slice(1))).toBeNull();
    });

    it.each([
      ["blank", ""],
      ["whitespace only", "   "],
      ["numeric", 123456],
      ["null", null],
      ["undefined", undefined],
      ["overlong", "x".repeat(257)],
      ["NUL", "abc\u0000def"],
      ["tab", "abc\tdef"],
      ["newline", "abc\ndef"],
      ["carriage return", "abc\rdef"],
      ["DEL", "abc\u007Fdef"],
    ])("rejects %s lookup input", (_label, barcode) => {
      expect(() => inventory.findProductByBarcode(barcode as string)).toThrow(
        InventoryValidationError,
      );
    });

    it("performs read-only lookups without changing products or permanent history", () => {
      const product = createProduct({ managedImagePath: FIRST_IMAGE });
      inventory.updateProduct({
        id: product.id,
        itemName: product.itemName,
        category: product.category,
        currentStock: 2,
        lowStockThreshold: product.lowStockThreshold,
      });
      const productsBefore = database.prepare("SELECT * FROM products").all();
      const historyBefore = database.prepare("SELECT * FROM transactions").all();
      const changesBefore = database.prepare("SELECT total_changes() AS count").get();
      database.pragma("query_only = ON");

      expect(inventory.findProductByBarcode(product.barcode)).toMatchObject({
        currentStock: 2,
        status: "LOW",
      });
      expect(inventory.findProductByBarcode("unknown")).toBeNull();
      expect(inventory.findProductByBarcode("' OR 1=1 --")).toBeNull();
      expect(() => inventory.findProductByBarcode(123 as unknown as string)).toThrow(
        InventoryValidationError,
      );
      expect(database.prepare("SELECT * FROM products").all()).toEqual(productsBefore);
      expect(database.prepare("SELECT * FROM transactions").all()).toEqual(historyBefore);
      expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(changesBefore);
      expect(inventory.listProducts()).toHaveLength(1);
      expect(inventory.listMovementHistory()).toHaveLength(1);
      expect(transactionSequence).toBe(1);
    });
  });

  it("creates a persistent product while preserving leading zeroes", () => {
    const created = createProduct({ managedImagePath: FIRST_IMAGE });

    expect(created).toMatchObject({
      barcode: "0000123456",
      itemName: "Composite Resin",
      category: "Restorative & Esthetic",
      unitType: "Piece",
      imagePath: FIRST_IMAGE,
      currentStock: 10,
      lowStockThreshold: 4,
      status: "HIGH",
    });
    expect(inventory.listProducts()).toEqual([created]);

    expect(
      database.prepare("SELECT barcode, image_path, unit_type FROM products").get(),
    ).toEqual({ barcode: "0000123456", image_path: FIRST_IMAGE, unit_type: "Piece" });
  });

  it("creates and edits a supported unit type without changing stock arithmetic", () => {
    const original = createProduct({ unitType: "Bottle" });
    const updated = inventory.updateProduct({
      id: original.id,
      itemName: original.itemName,
      category: original.category,
      unitType: "Pack",
      currentStock: original.currentStock,
      lowStockThreshold: original.lowStockThreshold,
    });

    expect(updated).toMatchObject({ unitType: "Pack", currentStock: 10, status: "HIGH" });
    expect(database.prepare("SELECT unit_type FROM products WHERE id = ?").pluck().get(original.id))
      .toBe("Pack");
    expect(inventory.listMovementHistory()).toEqual([]);
  });

  it("allows an omitted optional reference image", () => {
    expect(createProduct().imagePath).toBe("");
  });

  it("rejects duplicate barcodes without overwriting the first product", () => {
    const original = createProduct();

    expect(() =>
      createProduct({ itemName: "Replacement Attempt" }),
    ).toThrow(DuplicateBarcodeError);
    expect(inventory.listProducts()).toEqual([original]);
  });

  it("rejects categories outside the fixed list", () => {
    expect(() => createProduct({ category: "Consumables" })).toThrow(
      InventoryValidationError,
    );
  });

  it.each([
    ["negative initial stock", { initialStock: -1 }],
    ["fractional initial stock", { initialStock: 1.5 }],
    ["negative threshold", { lowStockThreshold: -1 }],
  ] as const)("rejects %s", (_label, override) => {
    expect(() => createProduct(override)).toThrow(InventoryValidationError);
  });

  it("validates managed image metadata instead of accepting arbitrary paths", () => {
    expect(() =>
      createProduct({ managedImagePath: "C:/Users/hp/Pictures/item.jpg" }),
    ).toThrow(/not managed by the application/i);
    expect(() =>
      createProduct({ managedImagePath: "product-images/../secret.png" }),
    ).toThrow(/not managed by the application/i);
  });

  it("searches names and barcodes and filters by exact category", () => {
    createProduct();
    createProduct({
      barcode: "009999",
      itemName: "Surgical Forceps",
      category: "Surgery",
    });
    createProduct({
      barcode: "literal-percent",
      itemName: "Etch 10% Gel",
      category: "General",
    });

    expect(inventory.listProducts({ search: "resin" }).map((item) => item.barcode)).toEqual([
      "0000123456",
    ]);
    expect(inventory.listProducts({ search: "0099" }).map((item) => item.barcode)).toEqual([
      "009999",
    ]);
    expect(inventory.listProducts({ category: "Surgery" }).map((item) => item.barcode)).toEqual([
      "009999",
    ]);
    expect(inventory.listProducts({ search: "%" }).map((item) => item.barcode)).toEqual([
      "literal-percent",
    ]);
    expect(() => inventory.listProducts({ category: "Unknown" })).toThrow(
      InventoryValidationError,
    );
  });

  it("edits allowed fields, retains an immutable barcode, and derives status", () => {
    const original = createProduct({ managedImagePath: FIRST_IMAGE });

    const updated = inventory.updateProduct({
      id: original.id,
      itemName: "Composite Resin Syringe",
      category: "General",
      currentStock: original.currentStock,
      lowStockThreshold: 12,
      managedImagePath: SECOND_IMAGE,
    });

    expect(updated).toMatchObject({
      barcode: "0000123456",
      itemName: "Composite Resin Syringe",
      category: "General",
      imagePath: SECOND_IMAGE,
      currentStock: 10,
      lowStockThreshold: 12,
      status: "LOW",
    });
    expect(inventory.listMovementHistory()).toEqual([]);
  });

  it("retains the current image when update image metadata is omitted", () => {
    const original = createProduct({ managedImagePath: FIRST_IMAGE });

    expect(
      inventory.updateProduct({
        id: original.id,
        itemName: original.itemName,
        category: original.category,
        currentStock: original.currentStock,
        lowStockThreshold: original.lowStockThreshold,
      }).imagePath,
    ).toBe(FIRST_IMAGE);
  });

  it("clears only the managed image reference when explicitly requested", () => {
    const original = createProduct({ managedImagePath: FIRST_IMAGE });

    const updated = inventory.updateProduct({
      id: original.id,
      itemName: original.itemName,
      category: original.category,
      currentStock: original.currentStock,
      lowStockThreshold: original.lowStockThreshold,
      managedImagePath: null,
    });

    expect(updated).toMatchObject({
      id: original.id,
      barcode: original.barcode,
      itemName: original.itemName,
      category: original.category,
      imagePath: "",
      currentStock: original.currentStock,
      lowStockThreshold: original.lowStockThreshold,
    });
    expect(inventory.listMovementHistory()).toEqual([]);
  });

  it("atomically creates a movement snapshot for an administrative stock correction", () => {
    const original = createProduct();

    const updated = inventory.updateProduct({
      id: original.id,
      itemName: "Updated Name",
      category: "Endodontics",
      currentStock: 3,
      lowStockThreshold: 3,
    });

    expect(updated).toMatchObject({ currentStock: 3, status: "LOW" });
    expect(inventory.listMovementHistory()).toEqual([
      {
        transactionId: "correction-1",
        productId: original.id,
        barcode: "0000123456",
        itemName: "Updated Name",
        category: "Endodontics",
        action: "STOCK_CORRECTION",
        quantity: -7,
        previousStock: 10,
        newTotal: 3,
        occurredAt: "2026-08-31T01:02:03.000Z",
        recordedAt: expect.any(String),
        source: "ONLINE",
      },
    ]);
  });

  it("rolls back the product update if movement insertion fails", () => {
    const fixedIdService = createInventoryService(database, {
      now: () => new Date("2026-08-31T01:02:03.000Z"),
      createTransactionId: () => "same-transaction-id",
    });
    const first = createProduct({ barcode: "first" });
    const second = createProduct({ barcode: "second" });

    fixedIdService.updateProduct({
      id: first.id,
      itemName: first.itemName,
      category: first.category,
      currentStock: 8,
      lowStockThreshold: first.lowStockThreshold,
    });

    expect(() =>
      fixedIdService.updateProduct({
        id: second.id,
        itemName: second.itemName,
        category: second.category,
        currentStock: 7,
        lowStockThreshold: second.lowStockThreshold,
      }),
    ).toThrow(/UNIQUE constraint failed/i);
    expect(
      fixedIdService.listProducts({ search: "second" })[0]?.currentStock,
    ).toBe(10);
  });

  it("rejects invalid edits and missing products", () => {
    const product = createProduct();
    expect(() =>
      inventory.updateProduct({
        id: product.id,
        itemName: product.itemName,
        category: product.category,
        currentStock: -1,
        lowStockThreshold: product.lowStockThreshold,
      }),
    ).toThrow(InventoryValidationError);

    expect(() =>
      inventory.updateProduct({
        id: product.id,
        itemName: product.itemName,
        category: product.category,
        currentStock: product.currentStock,
        lowStockThreshold: -1,
      }),
    ).toThrow(InventoryValidationError);

    expect(() =>
      inventory.updateProduct({
        id: 999,
        itemName: "Missing",
        category: "General",
        currentStock: 0,
        lowStockThreshold: 0,
      }),
    ).toThrow(ProductNotFoundError);
  });

  it("lists movement history newest first", () => {
    const product = createProduct();
    const timestamps = [
      new Date("2026-08-31T01:00:00.000Z"),
      new Date("2026-08-31T02:00:00.000Z"),
    ];
    const orderedService = createInventoryService(database, {
      now: () => timestamps.shift() ?? new Date("2026-08-31T03:00:00.000Z"),
      createTransactionId: () => `ordered-${timestamps.length}`,
    });

    orderedService.updateProduct({
      id: product.id,
      itemName: product.itemName,
      category: product.category,
      currentStock: 9,
      lowStockThreshold: product.lowStockThreshold,
    });
    orderedService.updateProduct({
      id: product.id,
      itemName: product.itemName,
      category: product.category,
      currentStock: 7,
      lowStockThreshold: product.lowStockThreshold,
    });

    expect(orderedService.listMovementHistory().map((movement) => movement.occurredAt)).toEqual([
      "2026-08-31T02:00:00.000Z",
      "2026-08-31T01:00:00.000Z",
    ]);
  });

  it("soft-deletes a product while retaining its permanent movement history", () => {
    const product = createProduct();
    inventory.updateProduct({
      id: product.id,
      itemName: product.itemName,
      category: product.category,
      currentStock: 11,
      lowStockThreshold: product.lowStockThreshold,
    });

    expect(inventory.deleteProduct({ id: product.id })).toMatchObject({
      id: product.id,
      barcode: "0000123456",
    });
    expect(inventory.listProducts()).toEqual([]);
    expect(inventory.listMovementHistory()).toHaveLength(1);
    expect(inventory.listMovementHistory()[0]).toMatchObject({
      barcode: "0000123456",
      itemName: "Composite Resin",
      action: "STOCK_CORRECTION",
      newTotal: 11,
    });

    const stored = database
      .prepare("SELECT deleted_at FROM products WHERE id = ?")
      .get(product.id) as { deleted_at: string | null };
    expect(stored.deleted_at).not.toBeNull();
    expect(() => inventory.deleteProduct({ id: product.id })).toThrow(
      ProductNotFoundError,
    );
    expect(() => createProduct()).toThrow(DuplicateBarcodeError);
  });
});
