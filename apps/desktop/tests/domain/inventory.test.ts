// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  INVENTORY_CATEGORIES,
  deriveStockStatus,
  isInventoryCategory,
} from "../../src/main/domain";

describe("inventory categories", () => {
  it("contains exactly the six fixed categories in specification order", () => {
    expect(INVENTORY_CATEGORIES).toEqual([
      "General",
      "Restorative & Esthetic",
      "Endodontics",
      "Prosthodontics",
      "Surgery",
      "Orthodontics",
    ]);
  });

  it("does not accept a user-defined category", () => {
    expect(isInventoryCategory("General")).toBe(true);
    expect(isInventoryCategory("Consumables")).toBe(false);
  });
});

describe("deriveStockStatus", () => {
  it.each([
    [-4, 5, "EMPTY"],
    [0, 5, "EMPTY"],
    [1, 5, "LOW"],
    [5, 5, "LOW"],
    [6, 5, "HIGH"],
    [1, 0, "HIGH"],
  ] as const)(
    "maps stock %i with threshold %i to %s",
    (stock, threshold, expected) => {
      expect(deriveStockStatus(stock, threshold)).toBe(expected);
    },
  );

  it("rejects invalid threshold values", () => {
    expect(() => deriveStockStatus(1, -1)).toThrow(/non-negative integer/i);
    expect(() => deriveStockStatus(1, 1.5)).toThrow(/non-negative integer/i);
  });
});

