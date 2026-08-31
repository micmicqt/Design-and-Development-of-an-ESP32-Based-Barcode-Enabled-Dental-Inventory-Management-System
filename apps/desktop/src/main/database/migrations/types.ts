import type { SqliteDatabase } from "../types";

export interface DatabaseMigration {
  version: number;
  name: string;
  up(database: SqliteDatabase): void;
}

