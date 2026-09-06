// @vitest-environment node

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqliteDatabase } from '../../src/main/database'
import { initialSchemaMigration } from '../../src/main/database/migrations/001-initial-schema'
import { phase2InventoryMigration } from '../../src/main/database/migrations/002-phase-2-inventory'
import { phase5Step2HardwareTransactionsMigration } from '../../src/main/database/migrations/003-phase-5-step-2-hardware-transactions'
import { phase5Step3ResultDeliveryMigration } from '../../src/main/database/migrations/004-phase-5-step-3-result-delivery'

describe('Phase 5 Step 3 result-delivery migration', () => {
  let database: SqliteDatabase

  beforeEach(() => {
    database = new BetterSqlite3(':memory:')
    database.pragma('foreign_keys = ON')
    initialSchemaMigration.up(database)
    phase2InventoryMigration.up(database)
    phase5Step2HardwareTransactionsMigration.up(database)
  })

  afterEach(() => database.close())

  function insertReceipt(): void {
    const productId = Number(
      database
        .prepare(`
          INSERT INTO products (
            barcode, item_name, category, current_stock, low_stock_threshold
          ) VALUES ('00001234', 'Existing Product', 'General', 12, 3)
        `)
        .run().lastInsertRowid
    )
    database
      .prepare(`
        INSERT INTO transactions (
          transaction_id, product_id, barcode, item_name, category, action,
          quantity, previous_stock, new_total, occurred_at, source
        ) VALUES ('movement-1', ?, '00001234', 'Existing Product', 'General',
          'RESTOCK', 2, 10, 12, '2026-09-05 08:00:00', 'ONLINE')
      `)
      .run(productId)
    database
      .prepare(`
        INSERT INTO processed_hardware_events (
          event_id, transaction_id, resulting_status
        ) VALUES ('event-1', 'movement-1', 'HIGH')
      `)
      .run()
  }

  it('adds a nullable delivery marker without changing an existing receipt', () => {
    insertReceipt()

    phase5Step3ResultDeliveryMigration.up(database)

    expect(database.prepare('PRAGMA table_info(processed_hardware_events)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'result_delivered_at', notnull: 0 })
      ])
    )
    expect(
      database
        .prepare(`
          SELECT event_id, transaction_id, resulting_status, result_delivered_at
          FROM processed_hardware_events
        `)
        .get()
    ).toEqual({
      event_id: 'event-1',
      transaction_id: 'movement-1',
      resulting_status: 'HIGH',
      result_delivered_at: null
    })
  })

  it('accepts a valid delivery timestamp and rejects malformed values', () => {
    insertReceipt()
    phase5Step3ResultDeliveryMigration.up(database)

    database
      .prepare(`
        UPDATE processed_hardware_events
        SET result_delivered_at = '2026-09-05T10:00:00.000Z'
        WHERE event_id = 'event-1'
      `)
      .run()
    expect(
      database
        .prepare(`
          SELECT result_delivered_at FROM processed_hardware_events
          WHERE event_id = 'event-1'
        `)
        .get()
    ).toEqual({ result_delivered_at: '2026-09-05T10:00:00.000Z' })

    expect(() =>
      database
        .prepare(`
          UPDATE processed_hardware_events
          SET result_delivered_at = 'invalid'
          WHERE event_id = 'event-1'
        `)
        .run()
    ).toThrow(/CHECK constraint failed/i)
  })
})
