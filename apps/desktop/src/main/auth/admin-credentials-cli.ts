import { resolve } from "node:path";
import {
  initializeDatabase,
  type SqliteDatabase,
} from "../database";
import {
  DEFAULT_ADMIN_USERNAME,
  initializeAdminCredentials,
  resetAdminCredentials,
} from "./admin-credentials";

type CredentialCommand = "init" | "reset";

function readOption(argumentsList: string[], option: string): string | undefined {
  const index = argumentsList.indexOf(option);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

async function run(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const command = argumentsList[0] as CredentialCommand | undefined;
  const databaseArgument = readOption(argumentsList, "--db");
  const username =
    readOption(argumentsList, "--username") ??
    process.env.DENTAL_ADMIN_USERNAME ??
    DEFAULT_ADMIN_USERNAME;
  const password = process.env.DENTAL_ADMIN_PASSWORD;

  if (command !== "init" && command !== "reset") {
    throw new Error("First argument must be either 'init' or 'reset'.");
  }

  if (!databaseArgument) {
    throw new Error("Provide the target SQLite file with --db <absolute-path>.");
  }

  if (!password) {
    throw new Error(
      "Set DENTAL_ADMIN_PASSWORD in the process environment. Password arguments are intentionally unsupported.",
    );
  }

  let database: SqliteDatabase | undefined;
  try {
    database = initializeDatabase({ databasePath: resolve(databaseArgument) });
    const credentials = { username, password };

    if (command === "init") {
      await initializeAdminCredentials(database, credentials);
    } else {
      await resetAdminCredentials(database, credentials);
    }

    process.stdout.write(`Administrator credentials ${command === "init" ? "initialized" : "reset"}.\n`);
  } finally {
    database?.close();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error.";
  process.stderr.write(`Administrator credential operation failed: ${message}\n`);
  process.exitCode = 1;
});

