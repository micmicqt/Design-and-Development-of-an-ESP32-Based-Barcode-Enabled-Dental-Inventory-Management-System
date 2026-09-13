import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initialSchemaMigration } from '../../src/main/database/migrations/001-initial-schema'
import { phase2InventoryMigration } from '../../src/main/database/migrations/002-phase-2-inventory'
import { phase5Step2HardwareTransactionsMigration } from '../../src/main/database/migrations/003-phase-5-step-2-hardware-transactions'
import { phase5Step3ResultDeliveryMigration } from '../../src/main/database/migrations/004-phase-5-step-3-result-delivery'
import { phase7Step2OfflineReconciliationMigration } from '../../src/main/database/migrations/005-phase-7-step-2-offline-reconciliation'
import { phase8Step2ProductUnitTypeMigration } from '../../src/main/database/migrations/006-phase-8-step-2-product-unit-type'

describe('Phase 8 Step 2 product unit type migration', () => {
  let database: BetterSqlite3.Database

  beforeEach(() => {
    database = new BetterSqlite3(':memory:')
    database.pragma('foreign_keys = ON')
    initialSchemaMigration.up(database)
    phase2InventoryMigration.up(database)
    phase5Step2HardwareTransactionsMigration.up(database)
    phase5Step3ResultDeliveryMigration.up(database)
    phase7Step2OfflineReconciliationMigration.up(database)
  })

  afterEach(() => database.close())

  it('preserves existing products and assigns Piece as their default unit', () => {
    database.prepare(`
      INSERT INTO products (
        barcode, item_name, category, current_stock, low_stock_threshold
      ) VALUES ('000123', 'Composite', 'Restorative & Esthetic', 5, 2)
    `).run()

    phase8Step2ProductUnitTypeMigration.up(database)

    expect(database.prepare(
      'SELECT barcode, current_stock, unit_type FROM products'
    ).get()).toEqual({ barcode: '000123', current_stock: 5, unit_type: 'Piece' })
  })

  it('accepts only the approved unit values', () => {
    phase8Step2ProductUnitTypeMigration.up(database)

    database.prepare(`
      INSERT INTO products (
        barcode, item_name, category, unit_type, current_stock, low_stock_threshold
      ) VALUES ('BOTTLE-1', 'Mouthwash', 'General', 'Bottle', 3, 1)
    `).run()
    expect(database.prepare('SELECT unit_type FROM products').pluck().get()).toBe('Bottle')

    expect(() => database.prepare(`
      INSERT INTO products (
        barcode, item_name, category, unit_type, current_stock, low_stock_threshold
      ) VALUES ('INVALID-1', 'Invalid', 'General', 'Case', 1, 0)
    `).run()).toThrow(/CHECK constraint failed/i)
  })
})
