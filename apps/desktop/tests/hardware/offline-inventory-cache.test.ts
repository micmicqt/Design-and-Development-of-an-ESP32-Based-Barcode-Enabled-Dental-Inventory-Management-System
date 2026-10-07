// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../../src/main/database'
import type {
  OfflineInventoryCacheGateway,
  OfflineInventoryCacheSnapshot
} from '../../src/main/hardware/hardware-gateway'
import {
  buildOfflineInventoryCacheSnapshot,
  createOfflineInventoryCacheCoordinator
} from '../../src/main/hardware/offline-inventory-cache'
import { HardwareGatewayError } from '../../src/main/hardware/esp32-http-gateway'
import { createInventoryService } from '../../src/main/inventory'

function createGateway() {
  return {
    getStatus: vi.fn(async () => ({ device: 'dental-inventory-esp32' as const, online: true as const,
      mode: 'idle' as const, rtc: true, sd: true, pendingSyncItems: 0 })),
    installOfflineInventoryCache: vi.fn<OfflineInventoryCacheGateway['installOfflineInventoryCache']>(
      async (snapshot) => ({
        generation: snapshot.generation,
        itemCount: snapshot.products.length,
        alreadyCurrent: false
      })
    )
  }
}

describe('offline inventory cache snapshot', () => {
  it('uses only authoritative active products and preserves exact barcode and stock data', () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    try {
      const empty = inventory.createProduct({
        barcode: '0000000000123',
        itemName: 'Etchant',
        category: 'Restorative & Esthetic',
        initialStock: 0,
        lowStockThreshold: 0
      })
      const low = inventory.createProduct({
        barcode: 'CASE-sensitive-02',
        itemName: 'File Set',
        category: 'Endodontics',
        initialStock: 3,
        lowStockThreshold: 5
      })
      const deleted = inventory.createProduct({
        barcode: 'deleted-03',
        itemName: 'Removed Item',
        category: 'General',
        initialStock: 99,
        lowStockThreshold: 1
      })
      inventory.deleteProduct({ id: deleted.id })

      const snapshot = buildOfflineInventoryCacheSnapshot(inventory)

      expect(snapshot.generation).toBe(
        'v1-f1ea8dfc32ad66d094005378e131882c92c9ffb7d246399cea9189e66061f619'
      )
      expect(snapshot.products).toEqual([
        {
          id: String(empty.id),
          barcode: '0000000000123',
          name: 'Etchant',
          category: 'Restorative & Esthetic',
          currentStock: 0,
          lowStockThreshold: 0,
          status: 'EMPTY'
        },
        {
          id: String(low.id),
          barcode: 'CASE-sensitive-02',
          name: 'File Set',
          category: 'Endodontics',
          currentStock: 3,
          lowStockThreshold: 5,
          status: 'LOW'
        }
      ])
      expect(snapshot.products).not.toContainEqual(expect.objectContaining({
        barcode: deleted.barcode
      }))
    } finally {
      database.close()
    }
  })

  it('produces the same generation for unchanged data and a new generation for cache data changes', () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    try {
      const item = inventory.createProduct({
        barcode: '00123',
        itemName: 'Gloves',
        category: 'General',
        initialStock: 10,
        lowStockThreshold: 2
      })
      const first = buildOfflineInventoryCacheSnapshot(inventory)
      const unchanged = buildOfflineInventoryCacheSnapshot(inventory)
      expect(unchanged).toEqual(first)
      expect(first.products[0]).toMatchObject({
        currentStock: 10,
        lowStockThreshold: 2,
        status: 'HIGH'
      })

      inventory.updateProduct({
        id: item.id,
        itemName: item.itemName,
        category: item.category,
        currentStock: 2,
        lowStockThreshold: item.lowStockThreshold
      })
      const changed = buildOfflineInventoryCacheSnapshot(inventory)
      expect(changed.generation).not.toBe(first.generation)
      expect(changed.products[0]).toMatchObject({ currentStock: 2, status: 'LOW' })
    } finally {
      database.close()
    }
  })
})

describe('offline inventory cache coordinator', () => {
  it('coalesces a heartbeat/final-sync overlap into one identical publication', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      const gateway = createGateway()
      let complete!: () => void
      gateway.installOfflineInventoryCache.mockImplementationOnce(async (snapshot) => {
        await new Promise<void>((resolve) => { complete = resolve })
        return { generation: snapshot.generation, itemCount: snapshot.products.length, alreadyCurrent: false }
      })
      const coordinator = createOfflineInventoryCacheCoordinator({ gateway, inventoryService: createInventoryService(database) })
      const heartbeat = coordinator.refreshIfNeeded()
      await vi.waitFor(() => expect(complete).toBeDefined())
      const finalSync = coordinator.refresh()
      complete()
      await heartbeat; await finalSync
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledOnce()
    } finally { database.close() }
  })
  it.each([
    { pendingSyncItems: 2, offlineAckState: 'IDLE' as const },
    { pendingSyncItems: undefined, offlineAckState: 'IDLE' as const },
    { pendingSyncItems: 0, offlineAckState: 'RUNNING' as const },
    { pendingSyncItems: 0, offlineAckState: 'VERIFYING' as const },
  ])('defers without any POST while retirement is not confirmed (%j)', async (state) => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      const gateway = { ...createGateway(), getStatus: vi.fn(async () => ({
        device: 'dental-inventory-esp32' as const, online: true as const, mode: 'idle' as const,
        rtc: true, sd: true, ...state,
      })) }
      let now = 1000
      const coordinator = createOfflineInventoryCacheCoordinator({
        gateway, inventoryService: createInventoryService(database), now: () => now,
      })
      await expect(coordinator.refreshIfNeeded()).rejects.toThrow(/deferred/)
      for (let i = 0; i < 7; ++i) { now += 4000; await coordinator.refreshIfNeeded() }
      expect(gateway.installOfflineInventoryCache).not.toHaveBeenCalled()
      expect(gateway.getStatus).toHaveBeenCalledOnce()
      gateway.getStatus.mockResolvedValue({ device: 'dental-inventory-esp32', online: true,
        mode: 'idle', rtc: true, sd: true, pendingSyncItems: 0, offlineAckState: 'IDLE' })
      await coordinator.refresh() // explicit final-sync signal bypasses deferred cooldown
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledOnce()
    } finally { database.close() }
  })
  it('does not publish when fresh status retrieval fails', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    try {
      const gateway = { ...createGateway(), getStatus: vi.fn(async () => { throw new Error('status unavailable') }) }
      await expect(createOfflineInventoryCacheCoordinator({ gateway, inventoryService: createInventoryService(database) }).refresh())
        .rejects.toThrow('status unavailable')
      expect(gateway.installOfflineInventoryCache).not.toHaveBeenCalled()
    } finally { database.close() }
  })
  it('coalesces overlapping signals and sends one trailing authoritative snapshot', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    const item = inventory.createProduct({
      barcode: '00042',
      itemName: 'Mask',
      category: 'Surgery',
      initialStock: 4,
      lowStockThreshold: 2
    })
    const gateway = createGateway()
    let finishFirst!: () => void
    let firstSnapshot: OfflineInventoryCacheSnapshot | undefined
    vi.mocked(gateway.installOfflineInventoryCache)
      .mockImplementationOnce(async (snapshot) => {
        firstSnapshot = snapshot
        await new Promise<void>((resolve) => { finishFirst = resolve })
        return {
          generation: snapshot.generation,
          itemCount: snapshot.products.length,
          alreadyCurrent: false
        }
      })
      .mockImplementationOnce(async (snapshot) => ({
        generation: snapshot.generation,
        itemCount: snapshot.products.length,
        alreadyCurrent: false
      }))
    const coordinator = createOfflineInventoryCacheCoordinator({
      inventoryService: inventory,
      gateway
    })

    try {
      const initial = coordinator.refresh()
      await vi.waitFor(() => expect(firstSnapshot).toBeDefined())
      inventory.updateProduct({
        id: item.id,
        itemName: item.itemName,
        category: item.category,
        currentStock: 7,
        lowStockThreshold: item.lowStockThreshold
      })
      const trailing = coordinator.refresh()
      expect(trailing).toBe(initial)
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledOnce()

      finishFirst()
      await expect(initial).resolves.toMatchObject({ itemCount: 1 })
      await expect(trailing).resolves.toMatchObject({ itemCount: 1 })
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledTimes(2)
      expect(firstSnapshot?.products[0]).toMatchObject({ currentStock: 4, status: 'HIGH' })
      expect(vi.mocked(gateway.installOfflineInventoryCache).mock.calls[1]?.[0].products[0])
        .toMatchObject({ currentStock: 7, status: 'HIGH' })
    } finally {
      database.close()
    }
  })

  it('keeps a pending-journal rejection harmless and suppresses four-second heartbeat retries', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    inventory.createProduct({
      barcode: '0099',
      itemName: 'Wipes',
      category: 'General',
      initialStock: 9,
      lowStockThreshold: 3
    })
    const gateway = createGateway()
    let currentTime = 1_000
    vi.mocked(gateway.installOfflineInventoryCache)
      .mockRejectedValueOnce(
        new HardwareGatewayError('REJECTED', 'Pending offline transactions preserve the cache.')
      )
    const coordinator = createOfflineInventoryCacheCoordinator({
      inventoryService: inventory,
      gateway,
      now: () => currentTime,
      failureRetryDelayMs: 30_000
    })

    try {
      await expect(coordinator.refreshIfNeeded()).rejects.toMatchObject({ code: 'REJECTED' })
      expect(inventory.findProductByBarcode('0099')).toMatchObject({ currentStock: 9 })
      expect(inventory.listMovementHistory()).toHaveLength(0)

      for (let heartbeat = 0; heartbeat < 7; heartbeat += 1) {
        currentTime += 4_000
        await expect(coordinator.refreshIfNeeded()).resolves.toBeNull()
      }
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledOnce()

      currentTime = 31_000
      await expect(coordinator.refreshIfNeeded()).resolves.toMatchObject({ itemCount: 1 })
      await expect(coordinator.refreshIfNeeded()).resolves.toMatchObject({ itemCount: 1 })
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledTimes(2)
    } finally {
      database.close()
    }
  })

  it('lets an authoritative inventory mutation bypass a failed-refresh cooldown', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    const gateway = createGateway()
    vi.mocked(gateway.installOfflineInventoryCache)
      .mockRejectedValueOnce(new Error('ESP32 unavailable'))
    const coordinator = createOfflineInventoryCacheCoordinator({
      inventoryService: inventory,
      gateway,
      now: () => 1_000,
      failureRetryDelayMs: 30_000
    })

    try {
      await expect(coordinator.refreshIfNeeded()).rejects.toThrow('ESP32 unavailable')
      inventory.createProduct({
        barcode: '0007',
        itemName: 'Mirror',
        category: 'General',
        initialStock: 5,
        lowStockThreshold: 1
      })

      await expect(coordinator.refresh()).resolves.toMatchObject({ itemCount: 1 })
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledTimes(2)
      expect(vi.mocked(gateway.installOfflineInventoryCache).mock.calls[1]?.[0].products)
        .toEqual([expect.objectContaining({ barcode: '0007' })])
    } finally {
      database.close()
    }
  })

  it('requires one new installation after the hardware connection is marked stale', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventory = createInventoryService(database)
    const gateway = createGateway()
    const listProducts = vi.spyOn(inventory, 'listProducts')
    const coordinator = createOfflineInventoryCacheCoordinator({
      inventoryService: inventory,
      gateway
    })

    try {
      await coordinator.refreshIfNeeded()
      await coordinator.refreshIfNeeded()
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledOnce()
      expect(listProducts).toHaveBeenCalledOnce()

      coordinator.markStale()
      await coordinator.refreshIfNeeded()
      expect(gateway.installOfflineInventoryCache).toHaveBeenCalledTimes(2)
      expect(listProducts).toHaveBeenCalledTimes(2)
    } finally {
      database.close()
    }
  })
})
