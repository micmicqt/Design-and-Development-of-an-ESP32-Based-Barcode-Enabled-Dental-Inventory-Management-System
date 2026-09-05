import type { DatabaseMigration } from "./types";

/**
 * Stores the durable link between one ESP32 event and its committed movement.
 * Transaction details remain in the existing permanent movement snapshot; the
 * resulting status is retained here because a product threshold can change
 * after the event has been processed.
 */
export const phase5Step2HardwareTransactionsMigration: DatabaseMigration = {
  version: 3,
  name: "phase_5_step_2_hardware_transactions",
  up(database) {
    database.exec(`
      CREATE TABLE processed_hardware_events (
        event_id TEXT PRIMARY KEY
          CHECK (length(event_id) BETWEEN 1 AND 63),
        transaction_id TEXT NOT NULL UNIQUE,
        resulting_status TEXT NOT NULL
          CHECK (resulting_status IN ('HIGH', 'LOW', 'EMPTY')),
        processed_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      ) STRICT;
    `);
  },
};
