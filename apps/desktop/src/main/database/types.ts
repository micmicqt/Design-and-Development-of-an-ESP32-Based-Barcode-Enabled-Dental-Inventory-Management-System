import type BetterSqlite3 from "better-sqlite3";

export type SqliteDatabase = BetterSqlite3.Database;

export interface DatabaseOptions {
  /** Use `:memory:` in tests or an absolute file path in production. */
  databasePath: string;
  readonly?: boolean;
}

