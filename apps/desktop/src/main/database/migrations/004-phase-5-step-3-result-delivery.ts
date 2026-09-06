import type { DatabaseMigration } from './types'

/**
 * Records the hand-off boundary between a committed SQLite transaction and the
 * ESP32 result endpoint. A nullable timestamp means result delivery still needs
 * to be retried; once present, recovery performs acknowledgement only.
 */
export const phase5Step3ResultDeliveryMigration: DatabaseMigration = {
  version: 4,
  name: 'phase_5_step_3_result_delivery',
  up(database) {
    database.exec(`
      ALTER TABLE processed_hardware_events
      ADD COLUMN result_delivered_at TEXT
        CHECK (
          result_delivered_at IS NULL OR
          length(result_delivered_at) >= 20
        );
    `)
  }
}
