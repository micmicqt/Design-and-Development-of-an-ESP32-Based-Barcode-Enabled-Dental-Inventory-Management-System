import {
  INVENTORY_CATEGORIES,
  PRODUCT_UNIT_TYPES,
  STOCK_STATUSES,
  type InventoryCategory,
  type ProductUnitType,
  type StockStatus,
} from "../../shared/ipc-contract";

/**
 * The inventory categories are part of the capstone specification and are not
 * user-extensible. Keep this tuple as the single TypeScript source of truth.
 */
export { INVENTORY_CATEGORIES, PRODUCT_UNIT_TYPES, STOCK_STATUSES };
export type { InventoryCategory, ProductUnitType, StockStatus };

export function isInventoryCategory(value: unknown): value is InventoryCategory {
  return (
    typeof value === "string" &&
    (INVENTORY_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isProductUnitType(value: unknown): value is ProductUnitType {
  return (
    typeof value === "string" &&
    (PRODUCT_UNIT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Derive status instead of persisting it, preventing a stale status column.
 */
export function deriveStockStatus(
  currentStock: number,
  lowStockThreshold: number,
): StockStatus {
  if (!Number.isInteger(currentStock)) {
    throw new TypeError("Current stock must be an integer.");
  }

  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
    throw new RangeError("Low-stock threshold must be a non-negative integer.");
  }

  if (currentStock <= 0) {
    return "EMPTY";
  }

  if (currentStock <= lowStockThreshold) {
    return "LOW";
  }

  return "HIGH";
}
