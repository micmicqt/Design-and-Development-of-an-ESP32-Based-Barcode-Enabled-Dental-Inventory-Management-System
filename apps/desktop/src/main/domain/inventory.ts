/**
 * The inventory categories are part of the capstone specification and are not
 * user-extensible. Keep this tuple as the single TypeScript source of truth.
 */
export const INVENTORY_CATEGORIES = [
  "General",
  "Restorative & Esthetic",
  "Endodontics",
  "Prosthodontics",
  "Surgery",
  "Orthodontics",
] as const;

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export const STOCK_STATUSES = ["HIGH", "LOW", "EMPTY"] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

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

