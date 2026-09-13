import { randomUUID } from "node:crypto";
import type {
  HardwareTransactionEvent,
  HardwareTransactionReceipt,
  OfflinePendingEvent,
  OfflineReconciliationConflictCode,
  OfflineReconciliationReceipt,
} from "../../shared/ipc-contract";
import { MAX_TRANSACTION_QUANTITY } from "../../shared/transaction-quantity";
import type { SqliteDatabase } from "../database";
import {
  deriveStockStatus,
  isInventoryCategory,
  isProductUnitType,
  type InventoryCategory,
  type ProductUnitType,
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

export class OfflineReconciliationConflictError extends Error {
  constructor(
    public readonly code: OfflineReconciliationConflictCode,
    message: string,
    public readonly eventId: string,
  ) {
    super(message);
    this.name = "OfflineReconciliationConflictError";
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
  unitType?: string;
  initialStock: number;
  lowStockThreshold: number;
  managedImagePath?: string | null;
}

export interface UpdateProductInput {
  id: number;
  itemName: string;
  category: string;
  unitType?: string;
  currentStock: number;
  lowStockThreshold: number;
  /** Undefined retains the existing image; null removes it. */
  managedImagePath?: string | null;
}

export interface DeleteProductInput {
  id: number;
}

export interface ProcessHardwareTransactionServiceInput {
  event: HardwareTransactionEvent;
  quantity: number;
}

export interface OfflineReconciliationResult {
  status: "APPLIED" | "ALREADY_APPLIED";
  receipt: OfflineReconciliationReceipt;
}

export interface ProductRecord {
  id: number;
  barcode: string;
  itemName: string;
  category: InventoryCategory;
  unitType: ProductUnitType;
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
  unit_type: ProductUnitType;
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

interface HardwareTransactionReceiptRow {
  event_id: string;
  transaction_id: string;
  product_id: number;
  barcode: string;
  item_name: string;
  category: InventoryCategory;
  action: "RESTOCK" | "CHECKOUT";
  quantity: number;
  previous_stock: number;
  new_total: number;
  occurred_at: string;
  resulting_status: StockStatus;
  result_delivered_at: string | null;
}

interface OfflineReconciliationReceiptRow {
  event_id: string;
  transaction_id: string;
  product_id: number;
  barcode: string;
  item_name: string;
  category: InventoryCategory;
  action: "RESTOCK" | "CHECKOUT";
  delta: 1 | -1;
  previous_stock: number;
  new_total: number;
  occurred_at: string;
  cached_resulting_stock: number;
  cached_stock_status: StockStatus;
  cache_generation: string;
  resulting_status: StockStatus;
}

interface NormalizedProductQuery {
  searchPattern: string | null;
  category: InventoryCategory | null;
}

interface NormalizedCreateProductInput {
  barcode: string;
  itemName: string;
  category: InventoryCategory;
  unitType: ProductUnitType;
  initialStock: number;
  lowStockThreshold: number;
  imagePath: string;
}

interface NormalizedUpdateProductInput {
  id: number;
  itemName: string;
  category: InventoryCategory;
  unitType?: ProductUnitType;
  currentStock: number;
  lowStockThreshold: number;
  imagePath: string | null | undefined;
}

interface NormalizedOfflinePendingEvent {
  eventId: string;
  timestamp: string;
  productId: number;
  barcode: string;
  action: "RESTOCK" | "CHECKOUT";
  delta: 1 | -1;
  resultingStock: number;
  stockStatus: StockStatus;
  cacheGeneration: string;
}

export interface InventoryServiceOptions {
  now?: () => Date;
  createTransactionId?: () => string;
}

export interface InventoryService {
  listProducts(query?: ProductQuery): ProductRecord[];
  findProductByBarcode(barcode: string): ProductRecord | null;
  createProduct(input: CreateProductInput): ProductRecord;
  updateProduct(input: UpdateProductInput): ProductRecord;
  deleteProduct(input: DeleteProductInput): ProductRecord;
  listMovementHistory(): MovementHistoryRecord[];
  findHardwareTransactionReceipt(eventId: string): HardwareTransactionReceipt | null;
  processHardwareTransaction(
    input: ProcessHardwareTransactionServiceInput,
  ): HardwareTransactionReceipt;
  markHardwareTransactionResultDelivered(eventId: string): HardwareTransactionReceipt;
  reconcileOfflineEvent(event: OfflinePendingEvent): OfflineReconciliationResult;
}

const HARDWARE_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HARDWARE_BARCODE_PATTERN = /^[\x20-\x7E]+$/;
const RTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFLINE_EVENT_ID_PATTERN = /^off-[0-9A-F]{12}-[0-9A-F]{16}$/;
const OFFLINE_PRODUCT_ID_PATTERN = /^[1-9]\d*$/;
const OFFLINE_CACHE_GENERATION_PATTERN = /^v1-[0-9a-f]{64}$/;
const OFFLINE_PENDING_EVENT_KEYS = [
  "eventId",
  "timestamp",
  "productId",
  "barcode",
  "action",
  "delta",
  "resultingStock",
  "stockStatus",
  "cacheGeneration",
] as const;

function validateHardwareEventId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 63 ||
    !HARDWARE_EVENT_ID_PATTERN.test(value)
  ) {
    throw new InventoryValidationError("The hardware transaction event ID is invalid.");
  }

  return value;
}

function isValidHardwareTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 2000 ||
    year > 2099 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return false;
  }

  return true;
}

function validateHardwareTimestamp(value: unknown): string {
  if (!isValidHardwareTimestamp(value)) {
    throw new InventoryValidationError("The hardware transaction timestamp is invalid.");
  }
  return value;
}

function validateHardwareTransactionInput(
  input: ProcessHardwareTransactionServiceInput,
): ProcessHardwareTransactionServiceInput {
  if (typeof input !== "object" || input === null) {
    throw new InventoryValidationError("The hardware transaction is invalid.");
  }

  const event = input.event;
  if (typeof event !== "object" || event === null) {
    throw new InventoryValidationError("The hardware transaction event is invalid.");
  }

  const eventId = validateHardwareEventId(event.eventId);
  if (event.mode !== "restock" && event.mode !== "checkout") {
    throw new InventoryValidationError("The hardware transaction mode is invalid.");
  }

  const barcode = validateLookupBarcode(event.barcode);
  if (!HARDWARE_BARCODE_PATTERN.test(barcode) || barcode.includes(",")) {
    throw new InventoryValidationError("The hardware transaction barcode is invalid.");
  }

  const timestamp = validateHardwareTimestamp(event.timestamp);
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_TRANSACTION_QUANTITY
  ) {
    throw new InventoryValidationError(
      `Quantity must be a positive whole number not exceeding ${MAX_TRANSACTION_QUANTITY}.`,
    );
  }

  return {
    event: { eventId, mode: event.mode, barcode, timestamp },
    quantity: input.quantity,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyOfflineEventKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...OFFLINE_PENDING_EVENT_KEYS].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function conflictEventId(value: unknown): string {
  if (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    value.eventId.length <= 63
  ) {
    return value.eventId;
  }
  return "";
}

function invalidOfflineEvent(value: unknown): OfflineReconciliationConflictError {
  return new OfflineReconciliationConflictError(
    "INVALID_EVENT",
    "The offline transaction event is invalid.",
    conflictEventId(value),
  );
}

function validateOfflinePendingEvent(value: unknown): NormalizedOfflinePendingEvent {
  if (!isRecord(value) || !hasExactlyOfflineEventKeys(value)) {
    throw invalidOfflineEvent(value);
  }

  if (
    typeof value.eventId !== "string" ||
    !OFFLINE_EVENT_ID_PATTERN.test(value.eventId) ||
    value.eventId.endsWith("0000000000000000") ||
    !isValidHardwareTimestamp(value.timestamp) ||
    typeof value.productId !== "string" ||
    value.productId.length === 0 ||
    value.productId.length > 31 ||
    !OFFLINE_PRODUCT_ID_PATTERN.test(value.productId) ||
    typeof value.barcode !== "string" ||
    value.barcode.length === 0 ||
    value.barcode.length > MAX_BARCODE_LENGTH ||
    value.barcode.trim().length === 0 ||
    !HARDWARE_BARCODE_PATTERN.test(value.barcode) ||
    value.barcode.includes(",") ||
    (value.action !== "RESTOCK" && value.action !== "CHECKOUT") ||
    (value.action === "RESTOCK" ? value.delta !== 1 : value.delta !== -1) ||
    !Number.isSafeInteger(value.resultingStock) ||
    (value.resultingStock as number) < 0 ||
    (value.stockStatus !== "HIGH" &&
      value.stockStatus !== "LOW" &&
      value.stockStatus !== "EMPTY") ||
    ((value.resultingStock === 0) !== (value.stockStatus === "EMPTY")) ||
    typeof value.cacheGeneration !== "string" ||
    !OFFLINE_CACHE_GENERATION_PATTERN.test(value.cacheGeneration)
  ) {
    throw invalidOfflineEvent(value);
  }

  const productId = Number(value.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw invalidOfflineEvent(value);
  }

  return {
    eventId: value.eventId,
    timestamp: value.timestamp,
    productId,
    barcode: value.barcode,
    action: value.action,
    delta: value.delta as 1 | -1,
    resultingStock: value.resultingStock as number,
    stockStatus: value.stockStatus,
    cacheGeneration: value.cacheGeneration,
  };
}

function validateLookupBarcode(value: unknown): string {
  if (typeof value !== "string") {
    throw new InventoryValidationError("Barcode / SKU must be text.");
  }
  if (!/\S/u.test(value)) {
    throw new InventoryValidationError("Barcode / SKU is required.");
  }
  if (value.length > MAX_BARCODE_LENGTH) {
    throw new InventoryValidationError(
      `Barcode / SKU must contain at most ${MAX_BARCODE_LENGTH} characters.`,
    );
  }
  if (Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new InventoryValidationError("Barcode / SKU must not contain control characters.");
  }

  // Lookup must preserve the exact scanner text, including leading zeroes,
  // case and surrounding spaces. The existing create/search normalization is
  // intentionally not reused or changed here.
  return value;
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

function normalizeUnitType(value: unknown): ProductUnitType {
  if (!isProductUnitType(value)) {
    throw new InventoryValidationError("Select one of the supported unit types.");
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
    unitType: input.unitType === undefined ? "Piece" : normalizeUnitType(input.unitType),
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
    unitType: input.unitType === undefined ? undefined : normalizeUnitType(input.unitType),
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
    unitType: row.unit_type,
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

function hardwareTransactionReceiptFromRow(
  row: HardwareTransactionReceiptRow,
): HardwareTransactionReceipt {
  return {
    eventId: row.event_id,
    transactionId: row.transaction_id,
    productId: row.product_id,
    mode: row.action === "RESTOCK" ? "restock" : "checkout",
    barcode: row.barcode,
    itemName: row.item_name,
    category: row.category,
    timestamp: row.occurred_at,
    quantity: row.quantity,
    previousStock: row.previous_stock,
    newTotal: row.new_total,
    status: row.resulting_status,
    resultDeliveredToHardware: row.result_delivered_at !== null,
  };
}

function offlineReconciliationReceiptFromRow(
  row: OfflineReconciliationReceiptRow,
): OfflineReconciliationReceipt {
  return {
    eventId: row.event_id,
    transactionId: row.transaction_id,
    productId: row.product_id,
    barcode: row.barcode,
    itemName: row.item_name,
    category: row.category,
    action: row.action,
    delta: row.delta,
    previousStock: row.previous_stock,
    newTotal: row.new_total,
    status: row.resulting_status,
    offlineResultingStock: row.cached_resulting_stock,
    offlineStockStatus: row.cached_stock_status,
    timestamp: row.occurred_at,
    cacheGeneration: row.cache_generation,
  };
}

function isSameHardwareTransaction(
  receipt: HardwareTransactionReceipt,
  input: ProcessHardwareTransactionServiceInput,
): boolean {
  return (
    receipt.eventId === input.event.eventId &&
    receipt.mode === input.event.mode &&
    receipt.barcode === input.event.barcode &&
    receipt.timestamp === input.event.timestamp &&
    receipt.quantity === input.quantity
  );
}

function isSameOfflineEvent(
  receipt: OfflineReconciliationReceipt,
  event: NormalizedOfflinePendingEvent,
): boolean {
  return (
    receipt.eventId === event.eventId &&
    receipt.timestamp === event.timestamp &&
    receipt.productId === event.productId &&
    receipt.barcode === event.barcode &&
    receipt.action === event.action &&
    receipt.delta === event.delta &&
    receipt.offlineResultingStock === event.resultingStock &&
    receipt.offlineStockStatus === event.stockStatus &&
    receipt.cacheGeneration === event.cacheGeneration
  );
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
    unit_type,
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
  const findActiveProductByBarcodeStatement = database.prepare(`
    SELECT ${productColumns}
    FROM products
    WHERE barcode = ? COLLATE BINARY AND deleted_at IS NULL
  `);
  const insertProductStatement = database.prepare(`
    INSERT INTO products (
      barcode,
      item_name,
      category,
      unit_type,
      image_path,
      current_stock,
      low_stock_threshold
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProductStatement = database.prepare(`
    UPDATE products
    SET
      item_name = ?,
      category = ?,
      unit_type = ?,
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
  const findHardwareTransactionReceiptStatement = database.prepare(`
    SELECT
      processed.event_id,
      movements.transaction_id,
      movements.product_id,
      movements.barcode,
      movements.item_name,
      movements.category,
      movements.action,
      movements.quantity,
      movements.previous_stock,
      movements.new_total,
      movements.occurred_at,
      processed.resulting_status,
      processed.result_delivered_at
    FROM processed_hardware_events AS processed
    INNER JOIN transactions AS movements
      ON movements.transaction_id = processed.transaction_id
    WHERE processed.event_id = ?
  `);
  const findOfflineReconciliationReceiptStatement = database.prepare(`
    SELECT
      receipts.event_id,
      movements.transaction_id,
      receipts.product_id,
      receipts.barcode,
      movements.item_name,
      movements.category,
      receipts.action,
      receipts.delta,
      movements.previous_stock,
      movements.new_total,
      receipts.event_timestamp AS occurred_at,
      receipts.cached_resulting_stock,
      receipts.cached_stock_status,
      receipts.cache_generation,
      receipts.resulting_status
    FROM offline_reconciliation_receipts AS receipts
    INNER JOIN transactions AS movements
      ON movements.transaction_id = receipts.transaction_id
    WHERE receipts.event_id = ?
  `);
  const updateHardwareStockStatement = database.prepare(`
    UPDATE products
    SET
      current_stock = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
      AND deleted_at IS NULL
      AND current_stock = ?
  `);
  const updateOfflineStockStatement = database.prepare(`
    UPDATE products
    SET
      current_stock = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
      AND deleted_at IS NULL
      AND current_stock = ?
  `);
  const insertHardwareMovementStatement = database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ONLINE')
  `);
  const insertProcessedHardwareEventStatement = database.prepare(`
    INSERT INTO processed_hardware_events (
      event_id,
      transaction_id,
      resulting_status
    ) VALUES (?, ?, ?)
  `);
  const insertOfflineMovementStatement = database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'OFFLINE')
  `);
  const insertOfflineReconciliationReceiptStatement = database.prepare(`
    INSERT INTO offline_reconciliation_receipts (
      event_id,
      transaction_id,
      event_timestamp,
      product_id,
      barcode,
      action,
      delta,
      cached_resulting_stock,
      cached_stock_status,
      cache_generation,
      resulting_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markHardwareTransactionResultDeliveredStatement = database.prepare(`
    UPDATE processed_hardware_events
    SET result_delivered_at = COALESCE(
      result_delivered_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    WHERE event_id = ?
  `);

  const getActiveProduct = (id: number): ProductRecord | null => {
    const row = getActiveProductStatement.get(id) as ProductRow | undefined;
    return row ? productFromRow(row) : null;
  };

  const findHardwareTransactionReceipt = (
    eventId: string,
  ): HardwareTransactionReceipt | null => {
    const row = findHardwareTransactionReceiptStatement.get(
      validateHardwareEventId(eventId),
    ) as HardwareTransactionReceiptRow | undefined;
    return row ? hardwareTransactionReceiptFromRow(row) : null;
  };

  const findOfflineReconciliationReceipt = (
    eventId: string,
  ): OfflineReconciliationReceipt | null => {
    const row = findOfflineReconciliationReceiptStatement.get(
      eventId,
    ) as OfflineReconciliationReceiptRow | undefined;
    return row ? offlineReconciliationReceiptFromRow(row) : null;
  };

  const markHardwareTransactionResultDelivered = (
    eventId: string,
  ): HardwareTransactionReceipt => {
    const validatedEventId = validateHardwareEventId(eventId);
    const result = markHardwareTransactionResultDeliveredStatement.run(validatedEventId);
    if (result.changes !== 1) {
      throw new InventoryValidationError(
        "No committed transaction was found for this hardware event.",
      );
    }

    const receipt = findHardwareTransactionReceipt(validatedEventId);
    if (receipt === null) {
      throw new Error("The committed hardware transaction receipt is unavailable.");
    }
    return receipt;
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
        input.unitType ?? previousProduct.unitType,
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

  const processHardwareTransactionInTransaction = database.transaction(
    (
      input: ProcessHardwareTransactionServiceInput,
    ): HardwareTransactionReceipt => {
      const existingReceipt = findHardwareTransactionReceipt(input.event.eventId);
      if (existingReceipt !== null) {
        if (!isSameHardwareTransaction(existingReceipt, input)) {
          throw new InventoryValidationError(
            "This hardware event ID was already processed with different transaction details.",
          );
        }
        return existingReceipt;
      }

      const productRow = findActiveProductByBarcodeStatement.get(
        input.event.barcode,
      ) as ProductRow | undefined;
      if (productRow === undefined) throw new ProductNotFoundError();

      const previousStock = productRow.current_stock;
      if (!Number.isSafeInteger(previousStock) || previousStock < 0) {
        throw new InventoryValidationError("The stored product stock is invalid.");
      }
      if (input.event.mode === "checkout" && input.quantity > previousStock) {
        throw new InventoryValidationError(
          `Insufficient stock. Only ${previousStock} available for checkout.`,
        );
      }

      const newTotal =
        input.event.mode === "restock"
          ? previousStock + input.quantity
          : previousStock - input.quantity;
      if (!Number.isSafeInteger(newTotal) || newTotal < 0) {
        throw new InventoryValidationError(
          "The resulting stock would exceed the supported inventory range.",
        );
      }

      const status = deriveStockStatus(newTotal, productRow.low_stock_threshold);
      const stockUpdate = updateHardwareStockStatement.run(
        newTotal,
        productRow.id,
        previousStock,
      );
      if (stockUpdate.changes !== 1) {
        throw new InventoryServiceError(
          "VALIDATION_ERROR",
          "The product changed while the hardware transaction was being processed.",
        );
      }

      const transactionId = createTransactionId();
      insertHardwareMovementStatement.run(
        transactionId,
        productRow.id,
        productRow.barcode,
        productRow.item_name,
        productRow.category,
        input.event.mode === "restock" ? "RESTOCK" : "CHECKOUT",
        input.quantity,
        previousStock,
        newTotal,
        input.event.timestamp,
      );
      insertProcessedHardwareEventStatement.run(
        input.event.eventId,
        transactionId,
        status,
      );

      const receipt = findHardwareTransactionReceipt(input.event.eventId);
      if (receipt === null) {
        throw new Error("The committed hardware transaction receipt is unavailable.");
      }
      return receipt;
    },
  );

  const reconcileOfflineEventInTransaction = database.transaction(
    (event: NormalizedOfflinePendingEvent): OfflineReconciliationResult => {
      const existingReceipt = findOfflineReconciliationReceipt(event.eventId);
      if (existingReceipt !== null) {
        if (!isSameOfflineEvent(existingReceipt, event)) {
          throw new OfflineReconciliationConflictError(
            "EVENT_ID_CONFLICT",
            "This offline event ID was already reconciled with different event details.",
            event.eventId,
          );
        }
        return { status: "ALREADY_APPLIED", receipt: existingReceipt };
      }

      const productRow = getActiveProductStatement.get(
        event.productId,
      ) as ProductRow | undefined;
      if (productRow === undefined) {
        throw new OfflineReconciliationConflictError(
          "PRODUCT_NOT_ACTIVE",
          "The product referenced by this offline event is not active.",
          event.eventId,
        );
      }
      if (productRow.barcode !== event.barcode) {
        throw new OfflineReconciliationConflictError(
          "PRODUCT_IDENTITY_CONFLICT",
          "The offline event product ID and barcode do not match the active product.",
          event.eventId,
        );
      }

      const previousStock = productRow.current_stock;
      if (
        !Number.isSafeInteger(previousStock) ||
        previousStock < 0 ||
        !Number.isSafeInteger(productRow.low_stock_threshold) ||
        productRow.low_stock_threshold < 0
      ) {
        throw new OfflineReconciliationConflictError(
          "STOCK_OVERFLOW",
          "The authoritative product stock is outside the supported inventory range.",
          event.eventId,
        );
      }
      if (event.delta === -1 && previousStock === 0) {
        throw new OfflineReconciliationConflictError(
          "INSUFFICIENT_STOCK",
          "The offline checkout cannot be applied because authoritative stock is empty.",
          event.eventId,
        );
      }

      const newTotal = previousStock + event.delta;
      if (!Number.isSafeInteger(newTotal) || newTotal < 0) {
        throw new OfflineReconciliationConflictError(
          "STOCK_OVERFLOW",
          "The offline event would exceed the supported inventory range.",
          event.eventId,
        );
      }

      const status = deriveStockStatus(newTotal, productRow.low_stock_threshold);
      const stockUpdate = updateOfflineStockStatement.run(
        newTotal,
        productRow.id,
        previousStock,
      );
      if (stockUpdate.changes !== 1) {
        throw new OfflineReconciliationConflictError(
          "PRODUCT_NOT_ACTIVE",
          "The active product changed while the offline event was being reconciled.",
          event.eventId,
        );
      }

      const transactionId = createTransactionId();
      insertOfflineMovementStatement.run(
        transactionId,
        productRow.id,
        productRow.barcode,
        productRow.item_name,
        productRow.category,
        event.action,
        previousStock,
        newTotal,
        event.timestamp,
      );
      insertOfflineReconciliationReceiptStatement.run(
        event.eventId,
        transactionId,
        event.timestamp,
        productRow.id,
        event.barcode,
        event.action,
        event.delta,
        event.resultingStock,
        event.stockStatus,
        event.cacheGeneration,
        status,
      );

      const receipt = findOfflineReconciliationReceipt(event.eventId);
      if (receipt === null) {
        throw new Error("The committed offline reconciliation receipt is unavailable.");
      }
      return { status: "APPLIED", receipt };
    },
  );

  return {
    listProducts(query) {
      const normalized = normalizeQuery(query);
      const rows = listProductsStatement.all(normalized) as ProductRow[];
      return rows.map(productFromRow);
    },

    findProductByBarcode(barcode) {
      const row = findActiveProductByBarcodeStatement.get(
        validateLookupBarcode(barcode),
      ) as ProductRow | undefined;
      return row ? productFromRow(row) : null;
    },

    createProduct(input) {
      const normalized = normalizeCreateInput(input);

      try {
        const result = insertProductStatement.run(
          normalized.barcode,
          normalized.itemName,
          normalized.category,
          normalized.unitType,
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

    findHardwareTransactionReceipt,

    markHardwareTransactionResultDelivered,

    processHardwareTransaction(input) {
      return processHardwareTransactionInTransaction(
        validateHardwareTransactionInput(input),
      );
    },

    reconcileOfflineEvent(event) {
      return reconcileOfflineEventInTransaction(validateOfflinePendingEvent(event));
    },
  };
}
