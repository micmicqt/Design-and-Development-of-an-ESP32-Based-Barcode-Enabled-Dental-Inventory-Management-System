import type { SqliteDatabase } from "../database";
import { hashPassword, verifyPassword } from "./password";

export const DEFAULT_ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD_MINIMUM_LENGTH = 8;

export interface AdminCredentials {
  username: string;
  password: string;
}

interface AdminRow {
  username: string;
  password_hash: string;
}

export class AdminAlreadyConfiguredError extends Error {
  constructor() {
    super("Administrator credentials are already configured.");
    this.name = "AdminAlreadyConfiguredError";
  }
}

function normalizeUsername(username: string): string {
  if (typeof username !== "string") {
    throw new TypeError("Administrator username must be a string.");
  }

  const normalized = username.trim().normalize("NFKC");

  if (normalized.length < 1 || normalized.length > 100) {
    throw new Error("Administrator username must contain 1 to 100 characters.");
  }

  return normalized;
}

function validatePassword(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < ADMIN_PASSWORD_MINIMUM_LENGTH ||
    password.length > 1_024
  ) {
    throw new Error(
      `Administrator password must contain ${ADMIN_PASSWORD_MINIMUM_LENGTH} to 1024 characters.`,
    );
  }
}

export function hasConfiguredAdmin(database: SqliteDatabase): boolean {
  const row = database
    .prepare("SELECT 1 AS configured FROM configured_admin WHERE id = 1")
    .get() as { configured: number } | undefined;
  return row?.configured === 1;
}

export async function initializeAdminCredentials(
  database: SqliteDatabase,
  credentials: AdminCredentials,
): Promise<void> {
  const username = normalizeUsername(credentials.username);
  validatePassword(credentials.password);

  if (hasConfiguredAdmin(database)) {
    throw new AdminAlreadyConfiguredError();
  }

  const passwordHash = await hashPassword(credentials.password);

  database
    .prepare(
      `INSERT INTO configured_admin (id, username, password_hash)
       VALUES (1, ?, ?)`,
    )
    .run(username, passwordHash);
}

/** Development/maintenance entry point; never expose this function over IPC. */
export async function resetAdminCredentials(
  database: SqliteDatabase,
  credentials: AdminCredentials,
): Promise<void> {
  const username = normalizeUsername(credentials.username);
  validatePassword(credentials.password);
  const passwordHash = await hashPassword(credentials.password);

  database
    .prepare(
      `INSERT INTO configured_admin (id, username, password_hash)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         password_hash = excluded.password_hash,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(username, passwordHash);
}

export async function verifyAdminCredentials(
  database: SqliteDatabase,
  credentials: AdminCredentials,
): Promise<boolean> {
  let username: string;
  try {
    username = normalizeUsername(credentials.username);
  } catch {
    return false;
  }

  const row = database
    .prepare(
      `SELECT username, password_hash
       FROM configured_admin
       WHERE id = 1 AND username = ? COLLATE NOCASE`,
    )
    .get(username) as AdminRow | undefined;

  if (!row) {
    return false;
  }

  return verifyPassword(credentials.password, row.password_hash);
}
