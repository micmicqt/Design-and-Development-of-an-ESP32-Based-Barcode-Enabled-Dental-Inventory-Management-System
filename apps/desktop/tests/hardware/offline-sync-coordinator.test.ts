// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type {
  OfflinePendingEvent,
  OfflineReconciliationReceipt
} from '../../src/shared/ipc-contract'
import type { OfflineInventoryCacheCoordinator } from '../../src/main/hardware/offline-inventory-cache'
import {
  createOfflineSyncCoordinator as createProductionOfflineSyncCoordinator,
  type CreateOfflineSyncCoordinatorOptions,
  type OfflineSyncCoordinatorError,
  type OfflineSyncGateway,
  type OfflineSyncInventoryService
} from '../../src/main/hardware/offline-sync-coordinator'
import { OfflineReconciliationConflictError } from '../../src/main/inventory'
import { HardwareGatewayError } from '../../src/main/hardware/esp32-http-gateway'

const cacheGeneration = `v1-${'a'.repeat(64)}`

function createOfflineSyncCoordinator(options: CreateOfflineSyncCoordinatorOptions) {
  return createProductionOfflineSyncCoordinator({
    ...options,
    // Keep the production recovery interval while making mocked tests instant.
    waitForAcknowledgementRecovery: async () => undefined
  })
}

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
  it.each(['transaction_active', 'storage_recovering', 'foreground_wait', 'temporarily_unavailable'] as const)(
    'retries explicit %s without treating it as disconnected or mutating stock', async (reason) => {
      const gateway = createGateway()
      vi.mocked(gateway.getNextOfflineEvent).mockRejectedValueOnce(
        new HardwareGatewayError('UNAVAILABLE', 'safe', reason, 409))
      const inventoryService = createInventoryService()
      const coordinator = createOfflineSyncCoordinator({ gateway, inventoryService,
        offlineInventoryCacheCoordinator: createCacheCoordinator() })
      await expect(coordinator.synchronize()).resolves.toMatchObject({ status: 'COMPLETE' })
      expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(2)
      expect(inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
    })
  it.each([
    new HardwareGatewayError('UNAVAILABLE', 'safe', 'REQUEST_TIMEOUT'),
    new HardwareGatewayError('UNAVAILABLE', 'safe', 'unauthorized', 401),
    new HardwareGatewayError('INVALID_RESPONSE', 'safe')
  ])('preserves the first fetch failure category and never applies or ACKs', async (error) => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent).mockRejectedValue(error)
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({ gateway, inventoryService,
      offlineInventoryCacheCoordinator: createCacheCoordinator() })
    await expect(coordinator.synchronize()).rejects.toMatchObject({ code: 'HARDWARE_UNAVAILABLE' })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledOnce()
    expect(inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeOfflineEvent).not.toHaveBeenCalled()
  })
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

  it('waits after an ambiguous ACK, tolerates a failed read, then confirms the later FIFO head', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('device is still finishing the ACK'))
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('ACK response timed out'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: second.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    const wait = vi.fn(async (_milliseconds: number) => undefined)
    const coordinator = createProductionOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator(),
      waitForAcknowledgementRecovery: wait
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE',
      counts: { appliedEvents: 2, acknowledgedEvents: 2 }
    })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 2_000)
    expect(wait).toHaveBeenNthCalledWith(2, 2_000)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(1, first.eventId)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledTimes(2)
    expect(vi.mocked(gateway.getNextOfflineEvent).mock.invocationCallOrder[2])
      .toBeLessThan(vi.mocked(inventoryService.reconcileOfflineEvent).mock.invocationCallOrder[1] ?? 0)
  })

  it('keeps an accepted-but-in-progress ACK pending until the exact FIFO head advances', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('ACK retirement in progress'))
      .mockRejectedValueOnce(new Error('ACK retirement in progress'))
      .mockRejectedValueOnce(new Error('ACK retirement in progress'))
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('HTTP 202: accepted but not retired'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: second.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator()
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING', eventId: first.eventId
    })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(first)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(first.eventId)
    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE', counts: { appliedEvents: 2, acknowledgedEvents: 2 }
    })
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
  })

  it('monitors the exact async ACK through status until durable success without rereading the head', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event).mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent).mockRejectedValueOnce(
      Object.assign(new Error('processing'), {
        code: 'UNAVAILABLE', diagnosticCode: 'ACK_IN_PROGRESS'
      })
    )
    const baseStatus = {
      device: 'dental-inventory-esp32' as const, online: true,
      mode: 'idle' as const, rtc: true, sd: true, offlineReady: true
    }
    vi.mocked(gateway.getStatus)
      .mockResolvedValueOnce({ ...baseStatus, pendingSyncItems: 1,
        offlineAckState: 'QUEUED', offlineAckEventId: event.eventId })
      .mockResolvedValueOnce({ ...baseStatus, pendingSyncItems: 1,
        offlineAckState: 'RUNNING', offlineAckEventId: event.eventId })
      .mockResolvedValueOnce({ ...baseStatus, pendingSyncItems: 0,
        offlineAckState: 'SUCCEEDED', offlineAckEventId: event.eventId })
    const inventoryService = createInventoryService()
    const wait = vi.fn().mockResolvedValue(undefined)
    const coordinator = createProductionOfflineSyncCoordinator({
      inventoryService, gateway, offlineInventoryCacheCoordinator: createCacheCoordinator(),
      waitForAcknowledgementRecovery: wait
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE', counts: { appliedEvents: 1, acknowledgedEvents: 1 }
    })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 2_000)
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(2)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
  })

  it.each(['FAILED', 'MISMATCH', 'TIMEOUT'] as const)(
    'keeps the durable SQLite result pending when async ACK monitoring ends in %s',
    async (caseName) => {
      const event = pendingEvent(1)
      const gateway = createGateway()
      vi.mocked(gateway.getNextOfflineEvent).mockResolvedValueOnce(event)
      vi.mocked(gateway.acknowledgeOfflineEvent).mockRejectedValueOnce(
        Object.assign(new Error('processing'), {
          code: 'UNAVAILABLE', diagnosticCode: 'ACK_IN_PROGRESS'
        })
      )
      const baseStatus = {
        device: 'dental-inventory-esp32' as const, online: true,
        mode: 'idle' as const, rtc: true, sd: true, pendingSyncItems: 1,
        offlineReady: true
      }
      vi.mocked(gateway.getStatus).mockResolvedValueOnce({ ...baseStatus,
        offlineAckState: 'RUNNING', offlineAckEventId: event.eventId })
      if (caseName === 'FAILED') {
        vi.mocked(gateway.getStatus).mockResolvedValueOnce({ ...baseStatus,
          offlineAckState: 'FAILED', offlineAckEventId: event.eventId })
      } else if (caseName === 'MISMATCH') {
        vi.mocked(gateway.getStatus).mockResolvedValueOnce({ ...baseStatus,
          offlineAckState: 'SUCCEEDED', offlineAckEventId: pendingEvent(2).eventId })
      } else {
        vi.mocked(gateway.getStatus).mockResolvedValue({ ...baseStatus,
          offlineAckState: 'RUNNING', offlineAckEventId: event.eventId })
      }
      const inventoryService = createInventoryService()
      const coordinator = createProductionOfflineSyncCoordinator({
        inventoryService, gateway, offlineInventoryCacheCoordinator: createCacheCoordinator(),
        waitForAcknowledgementRecovery: async () => undefined,
        acknowledgementMonitorWindowMs: 4_000
      })
      await expect(coordinator.synchronize()).resolves.toMatchObject({
        status: 'ACKNOWLEDGEMENT_PENDING', eventId: event.eventId
      })
      expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
      expect(gateway.getNextOfflineEvent).toHaveBeenCalledExactlyOnceWith()
    }
  )

  it('survives a temporary status network failure during the same ACK job', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event).mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent).mockRejectedValueOnce(
      Object.assign(new Error('processing'), {
        code: 'UNAVAILABLE', diagnosticCode: 'ACK_IN_PROGRESS'
      })
    )
    vi.mocked(gateway.getStatus)
      .mockRejectedValueOnce(new Error('NETWORK_FAILURE'))
      .mockResolvedValueOnce({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: true,
        sd: true, pendingSyncItems: 0, offlineReady: true,
        offlineAckState: 'SUCCEEDED', offlineAckEventId: event.eventId
      })
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService, gateway, offlineInventoryCacheCoordinator: createCacheCoordinator()
    })
    await expect(coordinator.synchronize()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(2)
  })

  it('does not retry an ACK when a later recovery check proves it already retired', async () => {
    const first = pendingEvent(1)
    const second = pendingEvent(2)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeOfflineEvent)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        acknowledged: true,
        eventId: second.eventId,
        pendingSyncItems: 0,
        alreadyAcknowledged: false
      })
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator()
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING', eventId: first.eventId
    })
    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'COMPLETE', counts: { appliedEvents: 2, acknowledgedEvents: 2 }
    })
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenNthCalledWith(2, second.eventId)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(1, first)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenNthCalledWith(2, second)
  })

  it('keeps the committed event in ACK-only recovery when every delayed read is unavailable', async () => {
    const event = pendingEvent(1)
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockRejectedValue(new Error('network unavailable'))
    vi.mocked(gateway.acknowledgeOfflineEvent).mockRejectedValueOnce(new Error('timeout'))
    const inventoryService = createInventoryService()
    const wait = vi.fn(async (_milliseconds: number) => undefined)
    const coordinator = createProductionOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator(),
      waitForAcknowledgementRecovery: wait
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: { appliedEvents: 1, acknowledgedEvents: 0 },
      eventId: event.eventId
    })
    expect(wait).toHaveBeenCalledTimes(3)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
  })

  it.each([
    'off-AAAAAAAAAAAA-0000000000000002',
    'off-20500DE58C14-0000000000000001'
  ])('never treats an unrelated or earlier head as proof of retirement: %s', async (headId) => {
    const event = pendingEvent(2)
    const wrongHead = { ...pendingEvent(1), eventId: headId }
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValue(wrongHead)
    vi.mocked(gateway.acknowledgeOfflineEvent).mockRejectedValueOnce(new Error('timeout'))
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator()
    })

    await expect(coordinator.synchronize()).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING', eventId: event.eventId
    })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(4)
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
  })

  it('coalesces retry calls while one ACK is unresolved', async () => {
    const event = pendingEvent(1)
    let failAck: ((reason: Error) => void) | undefined
    const gateway = createGateway()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(event)
    vi.mocked(gateway.acknowledgeOfflineEvent).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failAck = reject })
    )
    const inventoryService = createInventoryService()
    const coordinator = createOfflineSyncCoordinator({
      inventoryService,
      gateway,
      offlineInventoryCacheCoordinator: createCacheCoordinator()
    })

    const first = coordinator.synchronize()
    const overlapping = coordinator.synchronize()
    expect(overlapping).toBe(first)
    for (let turn = 0; turn < 5 && !failAck; turn += 1) await Promise.resolve()
    expect(failAck).toBeDefined()
    failAck?.(new Error('response lost'))
    await expect(first).resolves.toMatchObject({
      status: 'ACKNOWLEDGEMENT_PENDING', eventId: event.eventId
    })
    expect(gateway.acknowledgeOfflineEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(event)
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
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.getStatus)
      .mockResolvedValueOnce({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: true,
        sd: true, pendingSyncItems: 1, offlineReady: true
      })
      .mockResolvedValueOnce({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true,
        pendingSyncItems: 1,
        offlineReady: true
      })
      .mockResolvedValueOnce({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true,
        pendingSyncItems: 1,
        offlineReady: true
      })
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
