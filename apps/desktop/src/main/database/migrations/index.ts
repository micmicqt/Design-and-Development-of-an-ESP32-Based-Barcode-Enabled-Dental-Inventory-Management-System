import { initialSchemaMigration } from "./001-initial-schema";
import type { DatabaseMigration } from "./types";

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  initialSchemaMigration,
];

export type { DatabaseMigration } from "./types";

