// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type {
  OfflinePendingEvent,
  OfflineReconciliationReceipt
} from '../../src/shared/ipc-contract'
import type { OfflineInventoryCacheCoordinator } from '../../src/main/hardware/offline-inventory-cache'
import {
  createOfflineSyncCoordinator,
  type OfflineSyncCoordinatorError,
  type OfflineSyncGateway,
  type OfflineSyncInventoryService
} from '../../src/main/hardware/offline-sync-coordinator'
import { OfflineReconciliationConflictError } from '../../src/main/inventory'

const cacheGeneration = `v1-${'a'.repeat(64)}`

function pendingEvent(sequence: number): OfflinePendingEvent {
  return {
    eventId: `off-20500DE58C14-${String(sequence).padStart(16, '0')}`,
    timestamp: `2026-09-04 08:30:0${sequence}`,
    productId: '7',
    barcode: '0000000000000123',
    action: 'CHECKOUT',
    delta: -1,
    resultingStock: 3 - sequence,
    stockStatus: 'LOW',
    cacheGeneration
  }
}

function receipt(event: OfflinePendingEvent): OfflineReconciliationReceipt {
  return {
    eventId: event.eventId,
    transactionId: `movement-${event.eventId}`,
    productId: 7,
    barcode: event.barcode,
    itemName: 'Cleanser',
    category: 'General',
    action: event.action,
    delta: event.delta,
    previousStock: event.resultingStock + 1,
    newTotal: event.resultingStock,
    status: event.stockStatus,
    offlineResultingStock: event.resultingStock,
    offlineStockStatus: event.stockStatus,
    timestamp: event.timestamp,
    cacheGeneration: event.cacheGeneration
  }
}

function createGateway(): OfflineSyncGateway {
  return {
    getNextOfflineEvent: vi.fn().mockResolvedValue(null),
    acknowledgeOfflineEvent: vi.fn().mockImplementation(async (eventId: string) => ({
      acknowledged: true as const,
      eventId,
      pendingSyncItems: 0,
      alreadyAcknowledged: false
    })),
    getStatus: vi.fn().mockResolvedValue({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      pendingSyncItems: 0,
      offlineReady: true
    })
  }
}

function createInventoryService(): OfflineSyncInventoryService {
  return {
    reconcileOfflineEvent: vi.fn().mockImplementation((event: OfflinePendingEvent) => ({
      status: 'APPLIED' as const,
      receipt: receipt(event)
    }))
  }
}

function createCacheCoordinator(): OfflineInventoryCacheCoordinator {
  return {
    refresh: vi.fn().mockResolvedValue({
      generation: cacheGeneration,
      itemCount: 1,
      alreadyCurrent: false
    }),
    refreshIfNeeded: vi.fn().mockResolvedValue(null),
    markStale: vi.fn()
  }
}

describe('offline sync coordinator', () => {
  it('sequentially commits and ACKs each FIFO head before refreshing the final cache', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: first.eventId,
        pendingSyncItems: 1,
        alreadyAcknowledged: false
      })
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: second.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent)
      .mockReturnValueOnce({ status: 'APPLIED', receipt: receipt(first) })
      .mockReturnValueOnce({ status: 'ALREADY_APPLIED', receipt: receipt(second) })
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toEqual({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 1,
        acknowledgedEvents: 2
      },
      pendingSyncItems: 0,
      cache: {
        generation: cacheGeneration,
        itemCount: 1,
        alreadyCurrent: false
      }
    })

    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(1, first)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(2, second)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(1, first.eventId)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
    expect(vi.mocked(inventoryService.reconcileOfflineEvent).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(gateway.acknowledgeOfflineEvent).mock.invocationCallOrder[0] ?? 0)
    expect(vi.mocked(inventoryService.reconcileOfflineEvent).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(gateway.acknowledgeOfflineEvent).mock.invocationCallOrder[1] ?? 0)
    expect(vi.mocked(gateway.getStatus).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cacheCoordinator.refresh).mock.invocationCallOrder[0] ?? 0)
  })

  it('stops on a reconciliation conflict and never ACKs or refreshes the cache', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent).mockResolvedValueOnce(event)
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent).mockImplementationOnce(() => {
      throw new OfflineReconciliationConflictError(
        'PRODUCT_IDENTITY_CONFLICT',
        'The event does not match the active product.',
        event.eventId
      )
    })
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toEqual({
      status: 'CONFLICT',
      counts: {
        appliedEvents: 0,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 0
      },
      conflict: {
        code: 'PRODUCT_IDENTITY_CONFLICT',
        message: 'The event does not match the active product.',
        eventId: event.eventId
      }
    })
    expect(gateway.acknowledgeOfflineEvent).not.toHaveBeenCalled()
    expect(gateway.getStatus).not.toHaveBeenCalled()
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('stops on a database failure before ACK and exposes no database diagnostics', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent).mockResolvedValueOnce(pendingEvent(1))
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent).mockImplementationOnce(() => {
      throw new Error('SQLITE_IOERR /private/database/path')
    })
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).rejects.toMatchObject<
      Partial<OfflineSyncCoordinatorError>
    >({
      code: 'DATABASE_ERROR',
      message: 'The offline event could not be durably reconciled.'
    })
    expect(gateway.acknowledgeOfflineEvent).not.toHaveBeenCalled()
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('retries a known failed ACK without invoking SQLite reconciliation again', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: event.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toEqual({
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 0
      },
      eventId: event.eventId
    })
    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 1
      }
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(2)
  })

  it('uses the durable replay receipt for ACK recovery after a coordinator restart', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('ACK response lost before restart'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: event.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent)
      .mockReturnValueOnce({ status: 'APPLIED', receipt: receipt(event) })
      .mockReturnValueOnce({ status: 'ALREADY_APPLIED', receipt: receipt(event) })
    const firstCacheCoordinator = createCacheCoordinator()
    const beforeRestart = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: firstCacheCoordinator
    })

    await expect(beforeRestart.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: { appliedEvents: 1, acknowledgedEvents: 0 }
    })

    const afterRestart = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator()
    })
    await expect(afterRestart.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 0,
        alreadyAppliedEvents: 1,
        acknowledgedEvents: 1
      }
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(2)
    expect(firstCacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('resolves a lost ACK response when re-fetch reveals the next FIFO head', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: second.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 2,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 2
      }
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(1, first)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(2, second)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(1, first.eventId)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
  })

  it('keeps ACK-only recovery when an empty re-fetch lacks a matching zero status', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.getStatus)
      .mockResolvedValueOnce({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true,
        pendingSyncItems: 1,
        offlineReady: true
      })
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('ambiguous response loss'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: event.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: true
      })
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING',
      eventId: event.eventId
    })
    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 1
      }
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(2)
  })

  it('requires a fresh zero pending count after observing no head', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockResolvedValueOnce({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      pendingSyncItems: 1,
      offlineReady: true
    })
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).rejects.toMatchObject<
      Partial<OfflineSyncCoordinatorError>
    >({ code: 'JOURNAL_NOT_EMPTY' })
    expect(gateway.getStatus).toHaveBeenCalledExactlyOnceWith()
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('treats cache failure distinctly and retries only the final cache snapshot', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(null)
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    vi.mocked(cacheCoordinator.refresh)
      .mockRejectedValueOnce(new Error('MicroSD unavailable'))
      .mockResolvedValueOnce({
        generation: cacheGeneration,
        itemCount: 1,
        alreadyCurrent: true
      })
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    await expect(coordinator.synchronize()).resolves.toEqual({
      status: 'CACHE_REFRESH_FAILED',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 1
      },
      pendingSyncItems: 0
    })
    const readsAfterFailure = vi.mocked(gateway.getNextOfflineEvent).mock.calls.length
    const statusReadsAfterFailure = vi.mocked(gateway.getStatus).mock.calls.length
    const acknowledgementsAfterFailure = vi.mocked(gateway.acknowledgeOfflineEvent).mock.calls.length
    const reconciliationsAfterFailure = vi.mocked(inventoryService.reconcileOfflineEvent).mock.calls.length

    await expect(coordinator.synchronize()).resolves.toEqual({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 1
      },
      pendingSyncItems: 0,
      cache: {
        generation: cacheGeneration,
        itemCount: 1,
        alreadyCurrent: true
      }
    })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(readsAfterFailure)
    expect(gateway.getStatus).toHaveBeenCalledTimes(statusReadsAfterFailure)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(
      acknowledgementsAfterFailure
    )
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledTimes(
      reconciliationsAfterFailure
    )
    expect(cacheCoordinator.refresh).toHaveBeenCalledTimes(2)
  })

  it('coalesces overlapping synchronization calls into one sequential pass', async () => {
    let releaseHead: ((event: OfflinePendingEvent | null) => void) | undefined
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent).mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseHead = resolve
      })
    )
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator
    })

    const first = coordinator.synchronize()
    const second = coordinator.synchronize()
    expect(second).toBe(first)

    releaseHead?.(null)
    await expect(first).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledOnce()
    expect(gateway.getStatus).toHaveBeenCalledOnce()
    expect(cacheCoordinator.refresh).toHaveBeenCalledOnce()
  })

  it('enforces the configured sequential event bound and resumes safely', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    const inventoryService = createInventoryService()
    const cacheCoordinator = createCacheCoordinator()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: cacheCoordinator,
      maxEventsPerRun: 1
    })

    await expect(coordinator.synchronize()).rejects.toMatchObject<
      Partial<OfflineSyncCoordinatorError>
    >({ code: 'SYNC_LIMIT_REACHED' })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(first)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(first.eventId)

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: {
        appliedEvents: 2,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 2
      }
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(2, second)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
  })
})
