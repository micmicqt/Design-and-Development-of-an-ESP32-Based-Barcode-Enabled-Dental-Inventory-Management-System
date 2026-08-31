import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { applyDatabaseMigrations } from "./migrate";
import type { DatabaseOptions, SqliteDatabase } from "./types";

export const DATABASE_RELATIVE_PATH = join("data", "inventory.db");

/**
 * Electron's main process supplies `app.getPath("userData")`; keeping Electron
 * out of this module makes the database location injectable in unit tests.
 */
export function getProductionDatabasePath(userDataPath: string): string {
  if (userDataPath.trim().length === 0) {
    throw new Error("Electron userData path must not be empty.");
  }

  return resolve(userDataPath, DATABASE_RELATIVE_PATH);
}

export function initializeDatabase(options: DatabaseOptions): SqliteDatabase {
  const { databasePath, readonly = false } = options;

  if (databasePath.trim().length === 0) {
    throw new Error("Database path must not be empty.");
  }

  if (databasePath !== ":memory:" && !readonly) {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const database = new BetterSqlite3(databasePath, {
    readonly,
    fileMustExist: readonly,
  });

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");

    if (!readonly) {
      if (databasePath !== ":memory:") {
        database.pragma("journal_mode = WAL");
      }
      database.pragma("synchronous = NORMAL");
      applyDatabaseMigrations(database);
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeProductionDatabase(
  userDataPath: string,
): SqliteDatabase {
  return initializeDatabase({
    databasePath: getProductionDatabasePath(userDataPath),
  });
}

