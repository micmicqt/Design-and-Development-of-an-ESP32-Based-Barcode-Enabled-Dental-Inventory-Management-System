// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../src/main/database'
import type {
  OfflineInventoryCacheGateway,
  OfflineInventoryCacheSnapshot
} from '../../src/main/hardware/hardware-gateway'
import { createOfflineInventoryCacheCoordinator } from '../../src/main/hardware/offline-inventory-cache'
import {
  createOfflineSyncCoordinator,
  type OfflineSyncGateway
} from '../../src/main/hardware/offline-sync-coordinator'
import { createInventoryService } from '../../src/main/inventory'
import type { OfflinePendingEvent } from '../../src/shared/ipc-contract'

const generation = `v1-${'c'.repeat(64)}`

describe('offline synchronization end-to-end sequence', () => {
  it('retires two reused legacy heads after durable fingerprints; lost ACK never reapplies or publishes early', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      let transaction = 0
      const inventoryService = createInventoryService(database, { createTransactionId: () => `legacy-${++transaction}` })
      const product = inventoryService.createProduct({ barcode: '00001234', itemName: 'Synthetic item',
        category: 'General', initialStock: 10, lowStockThreshold: 3 })
      const old: OfflinePendingEvent = { eventId: 'off-148CE50D5020-0000000000000001',
        timestamp: '2026-09-09 20:49:59', productId: String(product.id), barcode: product.barcode,
        action: 'RESTOCK', delta: 1, resultingStock: 3, stockStatus: 'LOW', cacheGeneration: generation }
      inventoryService.reconcileOfflineEvent(old)
      const events = [{ ...old, timestamp: '2026-10-07 01:07:22', resultingStock: 11, stockStatus: 'HIGH' as const },
        { ...old, eventId: 'off-148CE50D5020-0000000000000002', timestamp: '2026-10-07 01:07:23', resultingStock: 12 }]
      let head = 0
      const order: string[] = []
      const gateway: OfflineSyncGateway & OfflineInventoryCacheGateway = {
        getNextOfflineEvent: async () => { order.push(`fetch:${head}`); return events[head] ?? null },
        getStatus: async () => ({ device: 'dental-inventory-esp32', online: true, mode: 'idle',
          rtc: true, sd: true, pendingSyncItems: 2 - head, offlineAckState: 'IDLE' }),
        acknowledgeOfflineEvent: async (eventId) => {
          expect(inventoryService.reconcileOfflineEvent(events[head]!).status).toBe('ALREADY_APPLIED')
          order.push(`ack:${head}`); head++
          if (head === 1) throw new Error('lost HTTP ACK response') // committed retirement, ambiguous response
          return { acknowledged: true, eventId, pendingSyncItems: 2 - head, alreadyAcknowledged: false }
        },
        installOfflineInventoryCache: async (snapshot) => {
          expect(head).toBe(2); order.push('cache')
          return { generation: snapshot.generation, itemCount: snapshot.products.length, alreadyCurrent: false }
        },
      }
      const cache = createOfflineInventoryCacheCoordinator({ inventoryService, gateway })
      await expect(cache.refresh()).rejects.toThrow(/deferred/)
      const coordinator = createOfflineSyncCoordinator({ inventoryService, gateway,
        offlineInventoryCacheCoordinator: cache, waitForAcknowledgementRecovery: async () => {} })
      await expect(coordinator.synchronize()).resolves.toMatchObject({ status: 'COMPLETE',
        counts: { appliedEvents: 2, alreadyAppliedEvents: 0, acknowledgedEvents: 2 } })
      expect(order.filter((step) => step === 'cache')).toHaveLength(1)
      expect(order.indexOf('cache')).toBeGreaterThan(order.indexOf('ack:1'))
      for (const event of [old, ...events]) expect(inventoryService.reconcileOfflineEvent(event).status).toBe('ALREADY_APPLIED')
      expect(inventoryService.findProductByBarcode(product.barcode)?.currentStock).toBe(13)
      expect(inventoryService.listMovementHistory()).toHaveLength(3)
    } finally { database.close() }
  })
  it.each([0, 1, 2, 10, 50, 100])('drains %i fixture records exactly once; replay never duplicates SQLite', async (size) => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      let sequence = 0
      const inventoryService = createInventoryService(database, { createTransactionId: () => `scale-${++sequence}` })
      const product = inventoryService.createProduct({ barcode: '00001234', itemName: 'Synthetic item',
        category: 'Restorative & Esthetic', initialStock: 10, lowStockThreshold: 3 })
      const events: OfflinePendingEvent[] = Array.from({ length: size }, (_, index) => ({
        eventId: `off-20500DE58C14-${(index + 1).toString(16).toUpperCase().padStart(16, '0')}`,
        timestamp: '2026-10-07 01:07:22', productId: String(product.id), barcode: product.barcode,
        action: 'RESTOCK', delta: 1, resultingStock: 11 + index, stockStatus: 'HIGH', cacheGeneration: generation
      }))
      let head = 0
      const gateway: OfflineSyncGateway = {
        getNextOfflineEvent: async () => events[head] ?? null,
        getStatus: async () => ({ device: 'dental-inventory-esp32', online: true, mode: 'idle',
          rtc: true, sd: true, pendingSyncItems: size - head, offlineReady: true }),
        acknowledgeOfflineEvent: async (eventId) => {
          expect(events[head]?.eventId).toBe(eventId)
          expect(database.prepare('SELECT event_id FROM offline_reconciliation_receipts WHERE event_id=?').get(eventId)).toBeDefined()
          head += 1
          return { acknowledged: true, eventId, pendingSyncItems: size - head, alreadyAcknowledged: false }
        }
      }
      const refresh = vi.fn(async () => ({ generation, itemCount: 1, alreadyCurrent: true }))
      const cacheCoordinator = { refresh, refreshIfNeeded: refresh, markStale: vi.fn() }
      const coordinator = createOfflineSyncCoordinator({ gateway, inventoryService,
        offlineInventoryCacheCoordinator: cacheCoordinator })
      const started = performance.now()
      await expect(coordinator.synchronize()).resolves.toMatchObject({ status: 'COMPLETE',
        counts: { appliedEvents: size, alreadyAppliedEvents: 0, acknowledgedEvents: size } })
      console.info(`SYNC HOST FIXTURE records=${size} totalMs=${(performance.now() - started).toFixed(2)} (mock device, real in-memory SQLite)`)
      for (const event of events) expect(inventoryService.reconcileOfflineEvent(event).status).toBe('ALREADY_APPLIED')
      expect(inventoryService.findProductByBarcode(product.barcode)?.currentStock).toBe(10 + size)
      expect(inventoryService.listMovementHistory()).toHaveLength(size)
      expect(database.prepare('SELECT COUNT(*) AS count FROM offline_reconciliation_receipts').get()).toEqual({ count: size })
      await expect(coordinator.synchronize()).resolves.toMatchObject({ status: 'COMPLETE' })
      expect(inventoryService.listMovementHistory()).toHaveLength(size)
    } finally { database.close() }
  })
  it('reconciles and retires six FIFO events exactly once before caching final SQLite stock', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      let transactionSequence = 0
      const inventoryService = createInventoryService(database, {
        createTransactionId: () => `offline-sequence-${++transactionSequence}`
      })
      const product = inventoryService.createProduct({
        barcode: '0000000000000123',
        itemName: 'Synthetic Composite',
        category: 'Restorative & Esthetic',
        initialStock: 10,
        lowStockThreshold: 3
      })

      const actions = [
        ['CHECKOUT', -1, 9],
        ['CHECKOUT', -1, 8],
        ['RESTOCK', 1, 9],
        ['CHECKOUT', -1, 8],
        ['RESTOCK', 1, 9],
        ['RESTOCK', 1, 10]
      ] as const
      const journal: OfflinePendingEvent[] = actions.map(
        ([action, delta, resultingStock], index) => ({
          eventId: `off-20500DE58C14-${String(index + 1).padStart(16, '0')}`,
          timestamp: `2026-09-04 08:30:0${index + 1}`,
          productId: String(product.id),
          barcode: product.barcode,
          action,
          delta,
          resultingStock,
          stockStatus: 'HIGH',
          cacheGeneration: generation
        })
      )

      // Model a desktop restart after SQLite committed the head but before its
      // firmware ACK completed. The fresh coordinator must observe the durable
      // receipt as ALREADY_APPLIED instead of changing stock a second time.
      expect(inventoryService.reconcileOfflineEvent(journal[0] as OfflinePendingEvent).status)
        .toBe('APPLIED')

      let headIndex = 0
      const retiredEventIds: string[] = []
      const pendingCounts = [journal.length]
      const operations: string[] = []
      const gateway: OfflineSyncGateway = {
        getNextOfflineEvent: vi.fn(async () => {
          const head = journal[headIndex] ?? null
          operations.push(head === null ? 'next:none' : `next:${head.eventId}`)
          return head
        }),
        acknowledgeOfflineEvent: vi.fn(async (eventId: string) => {
          const expectedHead = journal[headIndex]
          if (expectedHead === undefined || expectedHead.eventId !== eventId) {
            throw new Error('The synthetic gateway received an out-of-order ACK.')
          }
          retiredEventIds.push(eventId)
          headIndex += 1
          const pendingSyncItems = journal.length - headIndex
          pendingCounts.push(pendingSyncItems)
          operations.push(`ack:${eventId}:${pendingSyncItems}`)
          return {
            acknowledged: true,
            eventId,
            pendingSyncItems,
            alreadyAcknowledged: false
          }
        }),
        getStatus: vi.fn(async () => {
          const pendingSyncItems = journal.length - headIndex
          operations.push(`status:${pendingSyncItems}`)
          return {
            device: 'dental-inventory-esp32',
            online: true,
            mode: 'idle',
            rtc: true,
            sd: true,
            pendingSyncItems,
            offlineReady: true
          }
        })
      }

      const installedSnapshots: OfflineInventoryCacheSnapshot[] = []
      const cacheGateway: OfflineInventoryCacheGateway = {
        installOfflineInventoryCache: vi.fn(async (snapshot) => {
          installedSnapshots.push(snapshot)
          operations.push(`cache:${snapshot.products[0]?.currentStock ?? 'empty'}`)
          return {
            generation: snapshot.generation,
            itemCount: snapshot.products.length,
            alreadyCurrent: false
          }
        })
      }
      const cacheCoordinator = createOfflineInventoryCacheCoordinator({
        inventoryService,
        gateway: { ...cacheGateway, getStatus: gateway.getStatus }
      })
      const coordinator = createOfflineSyncCoordinator({
        inventoryService,
        gateway,
        offlineInventoryCacheCoordinator: cacheCoordinator
      })

      await expect(coordinator.synchronize()).resolves.toEqual({
        status: 'COMPLETE',
        counts: {
          appliedEvents: 5,
          alreadyAppliedEvents: 1,
          acknowledgedEvents: 6
        },
        pendingSyncItems: 0,
        cache: {
          generation: expect.stringMatching(/^v1-[0-9a-f]{64}$/),
          itemCount: 1,
          alreadyCurrent: false
        }
      })

      expect(retiredEventIds).toEqual(journal.map((event) => event.eventId))
      expect(pendingCounts).toEqual([6, 5, 4, 3, 2, 1, 0])
      expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(6)
      expect(gateway.getStatus).toHaveBeenCalledTimes(2)
      expect(operations.slice(-4)).toEqual(['next:none', 'status:0', 'status:0', 'cache:10'])

      const authoritativeProduct = inventoryService.findProductByBarcode(product.barcode)
      expect(authoritativeProduct).toMatchObject({ currentStock: 10, status: 'HIGH' })
      const movements = inventoryService.listMovementHistory()
      expect(movements).toHaveLength(6)
      expect(new Set(movements.map((movement) => movement.transactionId)).size).toBe(6)
      expect(movements.every((movement) => movement.source === 'OFFLINE')).toBe(true)

      const durableRows = database.prepare(`
        SELECT
          receipts.event_id AS eventId,
          movements.previous_stock AS previousStock,
          movements.new_total AS newTotal,
          movements.source AS source
        FROM offline_reconciliation_receipts AS receipts
        INNER JOIN transactions AS movements
          ON movements.transaction_id = receipts.transaction_id
        ORDER BY receipts.event_timestamp ASC
      `).all()
      expect(durableRows).toEqual([
        { eventId: journal[0]?.eventId, previousStock: 10, newTotal: 9, source: 'OFFLINE' },
        { eventId: journal[1]?.eventId, previousStock: 9, newTotal: 8, source: 'OFFLINE' },
        { eventId: journal[2]?.eventId, previousStock: 8, newTotal: 9, source: 'OFFLINE' },
        { eventId: journal[3]?.eventId, previousStock: 9, newTotal: 8, source: 'OFFLINE' },
        { eventId: journal[4]?.eventId, previousStock: 8, newTotal: 9, source: 'OFFLINE' },
        { eventId: journal[5]?.eventId, previousStock: 9, newTotal: 10, source: 'OFFLINE' }
      ])
      expect(installedSnapshots).toHaveLength(1)
      expect(installedSnapshots[0]?.products).toEqual([
        expect.objectContaining({
          id: String(product.id),
          barcode: product.barcode,
          currentStock: 10,
          status: 'HIGH'
        })
      ])
    } finally {
      database.close()
    }
  })
})
