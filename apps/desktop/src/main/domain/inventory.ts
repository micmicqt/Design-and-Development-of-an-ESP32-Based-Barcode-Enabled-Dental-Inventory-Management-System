import {
  INVENTORY_CATEGORIES,
  STOCK_STATUSES,
  type InventoryCategory,
  type StockStatus,
} from "../../shared/ipc-contract";

/**
 * The inventory categories are part of the capstone specification and are not
 * user-extensible. Keep this tuple as the single TypeScript source of truth.
 */
export { INVENTORY_CATEGORIES, STOCK_STATUSES };
export type { InventoryCategory, StockStatus };

export function isInventoryCategory(value: unknown): value is InventoryCategory {
  return (
    typeof value === "string" &&
    (INVENTORY_CATEGORIES as readonly string[]).includes(value)
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
