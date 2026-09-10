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
        gateway: cacheGateway
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
      expect(gateway.getStatus).toHaveBeenCalledExactlyOnceWith()
      expect(operations.slice(-3)).toEqual(['next:none', 'status:0', 'cache:10'])

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
