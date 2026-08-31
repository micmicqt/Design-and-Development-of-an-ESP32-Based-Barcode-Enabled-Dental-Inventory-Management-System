import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../database";
import {
  deriveStockStatus,
  isInventoryCategory,
  type InventoryCategory,
  type StockStatus,
} from "../domain";

const MAX_BARCODE_LENGTH = 256;
const MAX_ITEM_NAME_LENGTH = 200;
const MAX_SEARCH_LENGTH = 256;
const MANAGED_IMAGE_PATH_PATTERN =
  /^product-images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

export const INVENTORY_ERROR_CODES = [
  "VALIDATION_ERROR",
  "DUPLICATE_BARCODE",
  "PRODUCT_NOT_FOUND",
] as const;

export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number];

export class InventoryServiceError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InventoryServiceError";
  }
}

export class InventoryValidationError extends InventoryServiceError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
    this.name = "InventoryValidationError";
  }
}

export class DuplicateBarcodeError extends InventoryServiceError {
  constructor() {
    super("DUPLICATE_BARCODE", "A product with this barcode already exists.");
    this.name = "DuplicateBarcodeError";
  }
}

export class ProductNotFoundError extends InventoryServiceError {
  constructor() {
    super("PRODUCT_NOT_FOUND", "Product not found.");
    this.name = "ProductNotFoundError";
  }
}

export interface ProductQuery {
  search?: string;
  category?: string | null;
}

export interface CreateProductInput {
  barcode: string;
  itemName: string;
  category: string;
  initialStock: number;
  lowStockThreshold: number;
  managedImagePath?: string | null;
}

export interface UpdateProductInput {
  id: number;
  itemName: string;
  category: string;
  currentStock: number;
  lowStockThreshold: number;
  /** Undefined retains the existing image; null removes it. */
  managedImagePath?: string | null;
}

export interface DeleteProductInput {
  id: number;
}

export interface ProductRecord {
  id: number;
  barcode: string;
  itemName: string;
  category: InventoryCategory;
  imagePath: string;
  currentStock: number;
  lowStockThreshold: number;
  status: StockStatus;
  createdAt: string;
  updatedAt: string;
}

export type MovementAction = "RESTOCK" | "CHECKOUT" | "STOCK_CORRECTION";
export type MovementSource = "ONLINE" | "OFFLINE";

export interface MovementHistoryRecord {
  transactionId: string;
  productId: number;
  barcode: string;
  itemName: string;
  category: InventoryCategory;
  action: MovementAction;
  quantity: number;
  previousStock: number;
  newTotal: number;
  occurredAt: string;
  recordedAt: string;
  source: MovementSource;
}

interface ProductRow {
  id: number;
  barcode: string;
  item_name: string;
  category: InventoryCategory;
  image_path: string;
  current_stock: number;
  low_stock_threshold: number;
  created_at: string;
  updated_at: string;
}

interface MovementRow {
  transaction_id: string;
  product_id: number;
  barcode: string;
  item_name: string;
  category: InventoryCategory;
  action: MovementAction;
  quantity: number;
  previous_stock: number;
  new_total: number;
  occurred_at: string;
  recorded_at: string;
  source: MovementSource;
}

interface NormalizedProductQuery {
  searchPattern: string | null;
  category: InventoryCategory | null;
}

interface NormalizedCreateProductInput {
  barcode: string;
  itemName: string;
  category: InventoryCategory;
  initialStock: number;
  lowStockThreshold: number;
  imagePath: string;
}

interface NormalizedUpdateProductInput {
  id: number;
  itemName: string;
  category: InventoryCategory;
  currentStock: number;
  lowStockThreshold: number;
  imagePath: string | null | undefined;
}

export interface InventoryServiceOptions {
  now?: () => Date;
  createTransactionId?: () => string;
}

export interface InventoryService {
  listProducts(query?: ProductQuery): ProductRecord[];
  createProduct(input: CreateProductInput): ProductRecord;
  updateProduct(input: UpdateProductInput): ProductRecord;
  deleteProduct(input: DeleteProductInput): ProductRecord;
  listMovementHistory(): MovementHistoryRecord[];
}

function normalizeRequiredText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new InventoryValidationError(`${label} must be text.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InventoryValidationError(`${label} is required.`);
  }

  if (normalized.length > maximumLength) {
    throw new InventoryValidationError(
      `${label} must contain at most ${maximumLength} characters.`,
    );
  }

  return normalized;
}

function normalizeCategory(value: unknown): InventoryCategory {
  if (!isInventoryCategory(value)) {
    throw new InventoryValidationError(
      "Category must be one of the six fixed inventory categories.",
    );
  }

  return value;
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InventoryValidationError(
      `${label} must be a non-negative integer.`,
    );
  }

  return value as number;
}

function normalizeProductId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InventoryValidationError("Product ID must be a positive integer.");
  }

  return value as number;
}

function normalizeManagedImagePath(
  value: unknown,
  options: { optional: boolean },
): string | null | undefined {
  if (value === undefined) return options.optional ? undefined : "";
  if (value === null || value === "") return "";

  if (typeof value !== "string" || !MANAGED_IMAGE_PATH_PATTERN.test(value)) {
    throw new InventoryValidationError("Reference image path is not managed by the application.");
  }

  return value;
}

function normalizeQuery(query: ProductQuery | undefined): NormalizedProductQuery {
  const rawSearch = query?.search;
  let searchPattern: string | null = null;

  if (rawSearch !== undefined) {
    if (typeof rawSearch !== "string") {
      throw new InventoryValidationError("Search text must be text.");
    }

    const search = rawSearch.trim();
    if (search.length > MAX_SEARCH_LENGTH) {
      throw new InventoryValidationError(
        `Search text must contain at most ${MAX_SEARCH_LENGTH} characters.`,
      );
    }

    if (search.length > 0) {
      const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
      searchPattern = `%${escapedSearch}%`;
    }
  }

  const rawCategory = query?.category;
  const category =
    rawCategory === undefined || rawCategory === null || rawCategory === ""
      ? null
      : normalizeCategory(rawCategory);

  return { searchPattern, category };
}

function normalizeCreateInput(input: CreateProductInput): NormalizedCreateProductInput {
  return {
    // Barcode remains text throughout; trimming cannot remove leading zeroes.
    barcode: normalizeRequiredText(input.barcode, "Barcode / SKU", MAX_BARCODE_LENGTH),
    itemName: normalizeRequiredText(input.itemName, "Item name", MAX_ITEM_NAME_LENGTH),
    category: normalizeCategory(input.category),
    initialStock: normalizeNonNegativeInteger(input.initialStock, "Initial stock"),
    lowStockThreshold: normalizeNonNegativeInteger(
      input.lowStockThreshold,
      "Low-stock threshold",
    ),
    imagePath:
      normalizeManagedImagePath(input.managedImagePath, { optional: false }) ?? "",
  };
}

function normalizeUpdateInput(input: UpdateProductInput): NormalizedUpdateProductInput {
  return {
    id: normalizeProductId(input.id),
    itemName: normalizeRequiredText(input.itemName, "Item name", MAX_ITEM_NAME_LENGTH),
    category: normalizeCategory(input.category),
    currentStock: normalizeNonNegativeInteger(input.currentStock, "Current stock"),
    lowStockThreshold: normalizeNonNegativeInteger(
      input.lowStockThreshold,
      "Low-stock threshold",
    ),
    imagePath: normalizeManagedImagePath(input.managedImagePath, { optional: true }),
  };
}

function productFromRow(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    barcode: row.barcode,
    itemName: row.item_name,
    category: row.category,
    imagePath: row.image_path,
    currentStock: row.current_stock,
    lowStockThreshold: row.low_stock_threshold,
    status: deriveStockStatus(row.current_stock, row.low_stock_threshold),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function movementFromRow(row: MovementRow): MovementHistoryRecord {
  return {
    transactionId: row.transaction_id,
    productId: row.product_id,
    barcode: row.barcode,
    itemName: row.item_name,
    category: row.category,
    action: row.action,
    quantity:
      row.action === "STOCK_CORRECTION"
        ? row.new_total - row.previous_stock
        : row.quantity,
    previousStock: row.previous_stock,
    newTotal: row.new_total,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    source: row.source,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function createInventoryService(
  database: SqliteDatabase,
  options: InventoryServiceOptions = {},
): InventoryService {
  const now = options.now ?? (() => new Date());
  const createTransactionId = options.createTransactionId ?? randomUUID;

  const productColumns = `
    id,
    barcode,
    item_name,
    category,
    image_path,
    current_stock,
    low_stock_threshold,
    created_at,
    updated_at
  `;

  const listProductsStatement = database.prepare(`
    SELECT ${productColumns}
    FROM products
    WHERE deleted_at IS NULL
      AND (@category IS NULL OR category = @category)
      AND (
        @searchPattern IS NULL
        OR item_name LIKE @searchPattern ESCAPE '\\' COLLATE NOCASE
        OR barcode LIKE @searchPattern ESCAPE '\\'
      )
    ORDER BY item_name COLLATE NOCASE ASC, id ASC
  `);
  const getActiveProductStatement = database.prepare(`
    SELECT ${productColumns}
    FROM products
    WHERE id = ? AND deleted_at IS NULL
  `);
  const insertProductStatement = database.prepare(`
    INSERT INTO products (
      barcode,
      item_name,
      category,
      image_path,
      current_stock,
      low_stock_threshold
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateProductStatement = database.prepare(`
    UPDATE products
    SET
      item_name = ?,
      category = ?,
      image_path = ?,
      current_stock = ?,
      low_stock_threshold = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL
  `);
  const insertStockCorrectionStatement = database.prepare(`
    INSERT INTO transactions (
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
    ) VALUES (?, ?, ?, ?, ?, 'STOCK_CORRECTION', ?, ?, ?, ?, 'ONLINE')
  `);
  const softDeleteProductStatement = database.prepare(`
    UPDATE products
    SET
      deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL
  `);
  const listHistoryStatement = database.prepare(`
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
    FROM transactions
    ORDER BY occurred_at DESC, recorded_at DESC, transaction_id DESC
  `);

  const getActiveProduct = (id: number): ProductRecord | null => {
    const row = getActiveProductStatement.get(id) as ProductRow | undefined;
    return row ? productFromRow(row) : null;
  };

  const updateInTransaction = database.transaction(
    (input: NormalizedUpdateProductInput): ProductRecord => {
      const previousProduct = getActiveProduct(input.id);
      if (previousProduct === null) throw new ProductNotFoundError();

      const imagePath =
        input.imagePath === undefined ? previousProduct.imagePath : input.imagePath;

      updateProductStatement.run(
        input.itemName,
        input.category,
        imagePath,
        input.currentStock,
        input.lowStockThreshold,
        input.id,
      );

      if (input.currentStock !== previousProduct.currentStock) {
        const quantity = Math.abs(input.currentStock - previousProduct.currentStock);
        insertStockCorrectionStatement.run(
          createTransactionId(),
          input.id,
          previousProduct.barcode,
          input.itemName,
          input.category,
          quantity,
          previousProduct.currentStock,
          input.currentStock,
          now().toISOString(),
        );
      }

      const updatedProduct = getActiveProduct(input.id);
      if (updatedProduct === null) throw new ProductNotFoundError();
      return updatedProduct;
    },
  );

  return {
    listProducts(query) {
      const normalized = normalizeQuery(query);
      const rows = listProductsStatement.all(normalized) as ProductRow[];
      return rows.map(productFromRow);
    },

    createProduct(input) {
      const normalized = normalizeCreateInput(input);

      try {
        const result = insertProductStatement.run(
          normalized.barcode,
          normalized.itemName,
          normalized.category,
          normalized.imagePath,
          normalized.initialStock,
          normalized.lowStockThreshold,
        );
        const createdProduct = getActiveProduct(Number(result.lastInsertRowid));
        if (createdProduct === null) throw new ProductNotFoundError();
        return createdProduct;
      } catch (error: unknown) {
        if (isUniqueConstraintError(error)) throw new DuplicateBarcodeError();
        throw error;
      }
    },

    updateProduct(input) {
      return updateInTransaction(normalizeUpdateInput(input));
    },

    deleteProduct(input) {
      const id = normalizeProductId(input.id);
      const product = getActiveProduct(id);
      if (product === null) throw new ProductNotFoundError();

      const result = softDeleteProductStatement.run(id);
      if (result.changes !== 1) throw new ProductNotFoundError();
      return product;
    },

    listMovementHistory() {
      return (listHistoryStatement.all() as MovementRow[]).map(movementFromRow);
    },
  };
}
