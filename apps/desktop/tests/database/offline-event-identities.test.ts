// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../../src/main/database'
import { offlineEventIdentitiesMigration } from '../../src/main/database/migrations/007-offline-event-identities'
import { createInventoryService } from '../../src/main/inventory'
import { offlineEventFingerprint } from '../../src/main/inventory/offline-event-identity'

describe('offline identity migration', () => {
  it('backfills existing receipts without changing their receipt or movement bytes', () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      const inventory = createInventoryService(database)
      const product = inventory.createProduct({ barcode: '0000123', itemName: 'Composite',
        category: 'General', initialStock: 10, lowStockThreshold: 2 })
      const event = { eventId: 'off-148CE50D5020-0000000000000001',
        timestamp: '2026-09-09 20:49:59', productId: String(product.id), barcode: product.barcode,
        action: 'RESTOCK' as const, delta: 1 as const, resultingStock: 3,
        stockStatus: 'LOW' as const, cacheGeneration: `v1-${'a'.repeat(64)}` }
      inventory.reconcileOfflineEvent(event)
      const receipts = database.prepare('SELECT * FROM offline_reconciliation_receipts').all()
      const movements = database.prepare('SELECT * FROM transactions').all()
      database.exec('DROP TABLE offline_event_identities') // isolated fixture models schema 006
      offlineEventIdentitiesMigration.up(database)
      expect(database.prepare('SELECT * FROM offline_reconciliation_receipts').all()).toEqual(receipts)
      expect(database.prepare('SELECT * FROM transactions').all()).toEqual(movements)
      expect(database.prepare('SELECT * FROM offline_event_identities').get()).toEqual({
        receipt_id: event.eventId, wire_event_id: event.eventId,
        payload_fingerprint: offlineEventFingerprint(event), identity_kind: 'NORMAL'
      })
      expect(createInventoryService(database).reconcileOfflineEvent(event).status).toBe('ALREADY_APPLIED')
    } finally { database.close() }
  })
  it('fingerprints every immutable field, preserving leading zeroes and canonical numeric IDs', () => {
    const event = { eventId: 'off-148CE50D5020-0000000000000001', timestamp: '2026-09-09 20:49:59',
      productId: '3', barcode: '0000123', action: 'RESTOCK', delta: 1,
      resultingStock: 3, stockStatus: 'LOW', cacheGeneration: `v1-${'a'.repeat(64)}` }
    expect(offlineEventFingerprint({ ...event, productId: 3 })).toBe(offlineEventFingerprint(event))
    for (const key of Object.keys(event) as (keyof typeof event)[]) {
      const value = event[key]
      expect(offlineEventFingerprint({ ...event, [key]: typeof value === 'number' ? value + 1 : `${value}x` }))
        .not.toBe(offlineEventFingerprint(event))
    }
  })
})
