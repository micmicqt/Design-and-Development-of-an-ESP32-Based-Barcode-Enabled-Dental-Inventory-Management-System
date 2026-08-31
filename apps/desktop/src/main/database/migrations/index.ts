import { initialSchemaMigration } from "./001-initial-schema";
import { phase2InventoryMigration } from "./002-phase-2-inventory";
import type { DatabaseMigration } from "./types";

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  initialSchemaMigration,
  phase2InventoryMigration,
];

export type { DatabaseMigration } from "./types";
