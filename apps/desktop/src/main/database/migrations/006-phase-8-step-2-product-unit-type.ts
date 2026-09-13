import { PRODUCT_UNIT_TYPES } from '../../../shared/ipc-contract'
import type { DatabaseMigration } from './types'

const unitTypeValues = PRODUCT_UNIT_TYPES.map(
  (unitType) => `'${unitType.replaceAll("'", "''")}'`
).join(', ')

/** Adds descriptive stock units without rebuilding or rewriting existing products. */
export const phase8Step2ProductUnitTypeMigration: DatabaseMigration = {
  version: 6,
  name: 'phase_8_step_2_product_unit_type',
  up(database) {
    database.exec(`
      ALTER TABLE products
        ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'Piece'
          CHECK (unit_type IN (${unitTypeValues}));
    `)
  }
}
