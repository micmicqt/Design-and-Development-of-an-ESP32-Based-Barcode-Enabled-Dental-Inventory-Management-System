import { DATABASE_MIGRATIONS } from "./migrations";
import type { SqliteDatabase } from "./types";

const createMigrationsTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
`;

interface AppliedMigrationRow {
  version: number;
  name: string;
}

export function applyDatabaseMigrations(database: SqliteDatabase): void {
  database.exec(createMigrationsTableSql);

  const orderedMigrations = [...DATABASE_MIGRATIONS].sort(
    (left, right) => left.version - right.version,
  );
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();

  for (const migration of orderedMigrations) {
    if (seenVersions.has(migration.version) || seenNames.has(migration.name)) {
      throw new Error(
        `Duplicate database migration metadata: ${migration.version}/${migration.name}`,
      );
    }

    seenVersions.add(migration.version);
    seenNames.add(migration.name);
  }

  const appliedRows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as AppliedMigrationRow[];
  const appliedByVersion = new Map(
    appliedRows.map((migration) => [migration.version, migration.name]),
  );

  for (const [version, appliedName] of appliedByVersion) {
    const knownMigration = orderedMigrations.find(
      (migration) => migration.version === version,
    );

    if (!knownMigration) {
      throw new Error(
        `Database contains unknown migration version ${version} (${appliedName}).`,
      );
    }

    if (knownMigration.name !== appliedName) {
      throw new Error(
        `Migration ${version} name mismatch: expected ${knownMigration.name}, found ${appliedName}.`,
      );
    }
  }

  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of orderedMigrations) {
    if (appliedByVersion.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      insertMigration.run(migration.version, migration.name);
    })();
  }
}

