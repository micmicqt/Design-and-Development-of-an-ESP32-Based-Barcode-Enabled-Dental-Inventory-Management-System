// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminAlreadyConfiguredError,
  hasConfiguredAdmin,
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

  it("starts with no valid login and requires first administrator setup", async () => {
    expect(hasConfiguredAdmin(database)).toBe(false);
    await expect(
      verifyAdminCredentials(database, { username: "admin", password: "any password" }),
    ).resolves.toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM configured_admin").get()).toEqual({ count: 0 });
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
    expect(hasConfiguredAdmin(database)).toBe(true);
    await expect(
      verifyAdminCredentials(database, {
        username: "admin",
        password: "a secure development password",
      }),
    ).resolves.toBe(true);
  });

  it("allows only one first administrator when setup submissions race", async () => {
    const results = await Promise.allSettled([
      initializeAdminCredentials(database, {
        username: "first-admin", password: "first secure password",
      }),
      initializeAdminCredentials(database, {
        username: "second-admin", password: "second secure password",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(AdminAlreadyConfiguredError) });
    expect(database.prepare("SELECT COUNT(*) AS count FROM configured_admin").get()).toEqual({ count: 1 });
  });

  it("preserves existing inventory while the first administrator is created", async () => {
    database.prepare(`INSERT INTO products
      (barcode, item_name, category, current_stock, low_stock_threshold)
      VALUES (?, ?, ?, ?, ?)`).run("0004806016001569", "Cleanser", "General", 12, 3);

    await initializeAdminCredentials(database, {
      username: "clinic-admin",
      password: "a secure clinic password",
    });

    expect(database.prepare("SELECT barcode, current_stock FROM products").get()).toEqual({
      barcode: "0004806016001569",
      current_stock: 12,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({ count: 0 });
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

describe("first administrator survives application and SQLite restart", () => {
  it("reopens with setup disabled and the original password still valid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dental-first-admin-"));
    const path = join(directory, "inventory.db");
    try {
      const first = initializeDatabase({ databasePath: path });
      try {
        expect(hasConfiguredAdmin(first)).toBe(false);
        await initializeAdminCredentials(first, {
          username: "clinic-admin",
          password: "a secure clinic password",
        });
      } finally {
        first.close();
      }

      const reopened = initializeDatabase({ databasePath: path });
      try {
        expect(hasConfiguredAdmin(reopened)).toBe(true);
        await expect(verifyAdminCredentials(reopened, {
          username: "clinic-admin", password: "a secure clinic password",
        })).resolves.toBe(true);
        await expect(verifyAdminCredentials(reopened, {
          username: "clinic-admin", password: "incorrect password",
        })).resolves.toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

