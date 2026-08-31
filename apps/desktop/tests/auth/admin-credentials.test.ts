// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminAlreadyConfiguredError,
  initializeAdminCredentials,
  resetAdminCredentials,
  verifyAdminCredentials,
} from "../../src/main/auth";
import {
  initializeDatabase,
  type SqliteDatabase,
} from "../../src/main/database";

describe("administrator credential service", () => {
  let database: SqliteDatabase;

  beforeEach(() => {
    database = initializeDatabase({ databasePath: ":memory:" });
  });

  afterEach(() => {
    database.close();
  });

  it("stores a hash and verifies a valid password", async () => {
    const password = "correct horse battery staple";
    await initializeAdminCredentials(database, {
      username: "admin",
      password,
    });

    const stored = database
      .prepare("SELECT password_hash FROM configured_admin WHERE id = 1")
      .get() as { password_hash: string };

    expect(stored.password_hash).not.toBe(password);
    expect(stored.password_hash).not.toContain(password);
    await expect(
      verifyAdminCredentials(database, { username: "admin", password }),
    ).resolves.toBe(true);
  });

  it("rejects an invalid administrator password", async () => {
    await initializeAdminCredentials(database, {
      username: "admin",
      password: "a secure development password",
    });

    await expect(
      verifyAdminCredentials(database, {
        username: "admin",
        password: "definitely incorrect",
      }),
    ).resolves.toBe(false);
  });

  it("allows only one configured administrator", async () => {
    await initializeAdminCredentials(database, {
      username: "admin",
      password: "a secure development password",
    });

    await expect(
      initializeAdminCredentials(database, {
        username: "second-admin",
        password: "another secure password",
      }),
    ).rejects.toBeInstanceOf(AdminAlreadyConfiguredError);
  });

  it("can reset credentials through the maintenance-only service", async () => {
    await initializeAdminCredentials(database, {
      username: "admin",
      password: "original secure password",
    });
    await resetAdminCredentials(database, {
      username: "admin",
      password: "replacement secure password",
    });

    await expect(
      verifyAdminCredentials(database, {
        username: "admin",
        password: "original secure password",
      }),
    ).resolves.toBe(false);
    await expect(
      verifyAdminCredentials(database, {
        username: "admin",
        password: "replacement secure password",
      }),
    ).resolves.toBe(true);
  });
});

