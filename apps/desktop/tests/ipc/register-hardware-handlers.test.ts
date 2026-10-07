// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import { initializeDatabase } from '../../src/main/database'
import type {
  HardwareTransactionEventGateway,
  OfflinePendingEventGateway,
  RegistrationBarcodeCaptureGateway
} from '../../src/main/hardware/hardware-gateway'
import {
  Esp32HttpGateway,
  HardwareGatewayError,
  type HardwareFetch,
  type HardwareHttpResponse
} from '../../src/main/hardware/esp32-http-gateway'
import type { OfflineInventoryCacheCoordinator } from '../../src/main/hardware/offline-inventory-cache'
import type { OfflineSyncCoordinator } from '../../src/main/hardware/offline-sync-coordinator'
import {
  createRtcRecoveryCoordinator,
  type RtcRecoveryCoordinator
} from '../../src/main/hardware/rtc-recovery-coordinator'
import {
  createHardwareTransactionCoordinator,
  HardwareTransactionCoordinatorError,
  type HardwareTransactionCoordinator
} from '../../src/main/hardware/hardware-transaction-coordinator'
import {
  OfflineReconciliationConflictError,
  createInventoryService as createSqliteInventoryService,
  type InventoryService
} from '../../src/main/inventory'
import { registerHardwareIpcHandlers } from '../../src/main/ipc/register-hardware-handlers'
import {
  IPC_CHANNELS,
  type HardwareStatusDto,
  type HardwareTransactionReceipt,
  type OfflinePendingEvent,
  type OfflineReconciliationReceipt,
  type OfflineSyncOutcome
} from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler
  }
}))

const hardwareEvent = {
  eventId: 'evt-session-1',
  mode: 'restock',
  barcode: '0004806016001569',
  timestamp: '2026-09-04 09:00:00'
} as const

const transactionReceipt: HardwareTransactionReceipt = {
  ...hardwareEvent,
  transactionId: 'movement-1',
  productId: 7,
  itemName: 'Cleanser',
  category: 'General',
  quantity: 2,
  previousStock: 20,
  newTotal: 22,
  status: 'HIGH',
  resultDeliveredToHardware: true
}

const offlinePendingEvent: OfflinePendingEvent = {
  eventId: 'off-20500DE58C14-0000000000000001',
  timestamp: '2026-09-04 08:30:00',
  productId: '7',
  barcode: '0004806016001569',
  action: 'CHECKOUT',
  delta: -1,
  resultingStock: 19,
  stockStatus: 'HIGH',
  cacheGeneration: `v1-${'a'.repeat(64)}`
}

const offlineReconciliationReceipt: OfflineReconciliationReceipt = {
  eventId: offlinePendingEvent.eventId,
  transactionId: 'offline-movement-1',
  productId: 7,
  barcode: offlinePendingEvent.barcode,
  itemName: 'Cleanser',
  category: 'General',
  action: 'CHECKOUT',
  delta: -1,
  previousStock: 20,
  newTotal: 19,
  status: 'HIGH',
  offlineResultingStock: offlinePendingEvent.resultingStock,
  offlineStockStatus: offlinePendingEvent.stockStatus,
  timestamp: offlinePendingEvent.timestamp,
  cacheGeneration: offlinePendingEvent.cacheGeneration
}

function jsonResponse(value: unknown, status = 200): HardwareHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(value)
  }
}

describe('authenticated hardware IPC boundary', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.handle.mockClear()
    electronMock.removeHandler.mockClear()
  })

  function setup(
    gateway: (HardwareTransactionEventGateway &
      OfflinePendingEventGateway &
      Partial<RegistrationBarcodeCaptureGateway>) | null = createGateway(),
    inventoryService: InventoryService = createInventoryService(),
    transactionCoordinator: HardwareTransactionCoordinator = createTransactionCoordinator(),
    offlineInventoryCacheCoordinator: OfflineInventoryCacheCoordinator | null = null,
    offlineSyncCoordinator: OfflineSyncCoordinator | null = null,
    rtcRecoveryCoordinator: RtcRecoveryCoordinator | null = null,
    unconfigured = false
  ) {
    const authSession = createAuthSessionController()
    const mainFrame = {}
    const webContents = { isDestroyed: () => false, mainFrame }
    const mainWindow = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    const trustedEvent = {
      sender: webContents,
      senderFrame: mainFrame
    } as unknown as IpcMainInvokeEvent
    const dispose = registerHardwareIpcHandlers({
      gateway,
      inventoryService,
      transactionCoordinator,
      authSession,
      getMainWindow: () => mainWindow,
      offlineInventoryCacheCoordinator,
      offlineSyncCoordinator,
      rtcRecoveryCoordinator,
      unconfigured
    })
    const handler = electronMock.handlers.get(IPC_CHANNELS.hardwareGetStatus)
    if (handler === undefined) throw new Error('Hardware status handler was not registered.')
    const heartbeat = electronMock.handlers.get(IPC_CHANNELS.hardwareSendDesktopHeartbeat)
    const offlineNext = electronMock.handlers.get(IPC_CHANNELS.hardwareGetNextOfflineEvent)
    const reconcileOffline = electronMock.handlers.get(
      IPC_CHANNELS.hardwareReconcileNextOfflineEvent
    )
    const synchronizeOffline = electronMock.handlers.get(
      IPC_CHANNELS.hardwareSynchronizeOfflineInventory
    )
    const next = electronMock.handlers.get(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    const captureBarcode = electronMock.handlers.get(
      IPC_CHANNELS.hardwareCaptureRegistrationBarcode
    )
    const acknowledge = electronMock.handlers.get(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    const getReceipt = electronMock.handlers.get(IPC_CHANNELS.hardwareGetTransactionReceipt)
    const process = electronMock.handlers.get(IPC_CHANNELS.hardwareProcessTransaction)
    const retryAck = electronMock.handlers.get(IPC_CHANNELS.hardwareRetryTransactionAcknowledgement)
    const retryResult = electronMock.handlers.get(IPC_CHANNELS.hardwareRetryTransactionResultDelivery)
    if (
      heartbeat === undefined ||
      offlineNext === undefined ||
      reconcileOffline === undefined ||
      synchronizeOffline === undefined ||
      captureBarcode === undefined ||
      next === undefined ||
      acknowledge === undefined ||
      getReceipt === undefined ||
      process === undefined ||
      retryResult === undefined ||
      retryAck === undefined
    ) {
      throw new Error('Hardware event handlers were not registered.')
    }
    return {
      authSession,
      trustedEvent,
      handler,
      heartbeat,
      offlineNext,
      reconcileOffline,
      synchronizeOffline,
      captureBarcode,
      next,
      acknowledge,
      getReceipt,
      process,
      retryResult,
      retryAck,
      dispose,
      gateway,
      inventoryService,
      transactionCoordinator,
      offlineInventoryCacheCoordinator,
      rtcRecoveryCoordinator
    }
  }

  function createGateway(): HardwareTransactionEventGateway &
    OfflinePendingEventGateway &
    RegistrationBarcodeCaptureGateway {
    return {
      healthCheck: vi.fn().mockResolvedValue({
        status: 'ok',
        device: 'dental-inventory-esp32',
        phase: 4
      }),
      getStatus: vi.fn().mockResolvedValue({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'restock',
        rtc: true,
        sd: true,
        pendingSyncItems: 4,
        offlineReady: true
      }),
      sendDesktopHeartbeat: vi.fn().mockResolvedValue(undefined),
      captureRegistrationBarcode: vi.fn().mockResolvedValue('000012340056'),
      getNextOfflineEvent: vi.fn().mockResolvedValue(offlinePendingEvent),
      getNextTransactionEvent: vi.fn().mockResolvedValue(hardwareEvent),
      deliverTransactionResult: vi.fn().mockResolvedValue(undefined),
      acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
    }
  }

  it('allows only an authenticated trusted renderer to request isolated barcode capture', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, captureBarcode } = setup(gateway)

    await expect(captureBarcode(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    authSession.signIn('admin')
    await expect(captureBarcode(trustedEvent)).resolves.toEqual({
      ok: true,
      value: { barcode: '000012340056' }
    })
    expect(gateway.captureRegistrationBarcode).toHaveBeenCalledOnce()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  function createInventoryService(): InventoryService {
    return {
      listProducts: vi.fn().mockReturnValue([]),
      findProductByBarcode: vi.fn().mockReturnValue(null),
      createProduct: vi.fn(),
      updateProduct: vi.fn(),
      deleteProduct: vi.fn(),
      listMovementHistory: vi.fn().mockReturnValue([]),
      findHardwareTransactionReceipt: vi.fn().mockReturnValue(null),
      markHardwareTransactionResultDelivered: vi.fn(),
      processHardwareTransaction: vi.fn(),
      reconcileOfflineEvent: vi.fn().mockReturnValue({
        status: 'APPLIED',
        receipt: offlineReconciliationReceipt
      })
    }
  }

  function createTransactionCoordinator(): HardwareTransactionCoordinator {
    return {
      getTransactionReceipt: vi.fn().mockReturnValue(null),
      processTransaction: vi.fn().mockResolvedValue({
        receipt: transactionReceipt,
        acknowledged: true
      }),
      retryTransactionResultDelivery: vi.fn().mockResolvedValue({
        receipt: transactionReceipt,
        acknowledged: true
      }),
      retryTransactionAcknowledgement: vi.fn().mockResolvedValue({
        receipt: transactionReceipt,
        acknowledged: true
      })
    }
  }

  function createOfflineInventoryCacheCoordinator(): OfflineInventoryCacheCoordinator {
    return {
      refresh: vi.fn().mockResolvedValue({
        generation: `v1-${'a'.repeat(64)}`,
        itemCount: 1,
        alreadyCurrent: false
      }),
      refreshIfNeeded: vi.fn().mockResolvedValue(null),
      markStale: vi.fn()
    }
  }

  function createOfflineSyncCoordinator(
    outcome: OfflineSyncOutcome = {
      status: 'COMPLETE',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 1
      },
      pendingSyncItems: 0,
      cache: {
        generation: `v1-${'a'.repeat(64)}`,
        itemCount: 1,
        alreadyCurrent: false
      }
    }
  ): OfflineSyncCoordinator {
    return { synchronize: vi.fn().mockResolvedValue(outcome) }
  }

  it('returns validated status to the authenticated trusted renderer', async () => {
    const { authSession, trustedEvent, handler, dispose } = setup()
    authSession.signIn('admin')

    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'CONNECTED',
      device: 'dental-inventory-esp32',
      mode: 'restock',
      rtc: true,
      sd: true,
      pendingSyncItems: 4,
      offlineReady: true
    })
    dispose()
  })

  it('forwards only the bounded ACK state through authenticated status IPC', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockResolvedValueOnce({
      device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: true,
      sd: true, pendingSyncItems: 1, offlineReady: true,
      offlineAckState: 'RUNNING',
      offlineAckEventId: offlinePendingEvent.eventId
    })
    const { authSession, trustedEvent, handler, dispose } = setup(gateway)
    authSession.signIn('admin')
    await expect(handler(trustedEvent)).resolves.toMatchObject({
      connection: 'CONNECTED', offlineAckState: 'RUNNING',
      offlineAckEventId: offlinePendingEvent.eventId
    })
    dispose()
  })

  it('forwards explicit journal health without inventing pending counts after transport loss', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockResolvedValueOnce({
      device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: true,
      sd: false, offlineJournalState: 'temporarily_unavailable',
      offlineJournalReason: 'remote_sector_read_failed'
    })
    const { authSession, trustedEvent, handler, dispose } = setup(gateway)
    authSession.signIn('admin')
    const status = await handler(trustedEvent)
    expect(status).toMatchObject({ connection: 'CONNECTED', sd: false,
      offlineJournalState: 'temporarily_unavailable',
      offlineJournalReason: 'remote_sector_read_failed' })
    expect(status).not.toHaveProperty('pendingSyncItems')
    dispose()
  })

  it('returns a clean offline state for unavailable hardware', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockRejectedValue(new Error('connection refused'))
    const { authSession, trustedEvent, handler, dispose } = setup(gateway)
    authSession.signIn('admin')

    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'OFFLINE',
      device: null,
      mode: null,
      rtc: null,
      sd: null
    })
    dispose()
  })

  it('reports not configured when no device address exists', async () => {
    const { authSession, trustedEvent, handler, dispose } = setup(
      null, createInventoryService(), createTransactionCoordinator(),
      null, null, null, true
    )
    authSession.signIn('admin')
    await expect(handler(trustedEvent)).resolves.toMatchObject({
      connection: 'NOT_CONFIGURED', device: null, rtc: null, sd: null
    })
    dispose()
  })

  it('distinguishes one unconfirmed status poll from a sustained disconnect', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, handler, next } = setup(gateway)
    authSession.signIn('admin')
    await expect(handler(trustedEvent)).resolves.toMatchObject({ connection: 'CONNECTED' })

    vi.mocked(gateway.getStatus).mockRejectedValue(new Error('status request timed out'))
    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'CHECKING', device: 'dental-inventory-esp32', mode: 'restock',
      rtc: true, sd: true
    })
    // The RAM event endpoint is independent of a failed status refresh and
    // stale offline-sync metadata is never carried into a retry decision.
    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'OFFLINE', device: 'dental-inventory-esp32', mode: 'restock',
      rtc: true, sd: true
    })
    vi.mocked(gateway.getStatus).mockResolvedValueOnce({
      device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: false, sd: false,
      rtcState: 'unavailable', rtcReason: 'communication_failure', offlineReady: false,
      pendingSyncItems: 0
    })
    await expect(handler(trustedEvent)).resolves.toMatchObject({
      connection: 'CONNECTED', rtc: false, sd: false, offlineReady: false
    })
    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
  })
  it('does not let an older status failure erase a newer authoritative count', async () => {
    const gateway = createGateway()
    let rejectOlder!: (reason: Error) => void
    vi.mocked(gateway.getStatus).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOlder = reject
    })).mockResolvedValueOnce({ device: 'dental-inventory-esp32', online: true,
      mode: 'idle', rtc: true, sd: true, pendingSyncItems: 2, offlineReady: true,
      offlineJournalState: 'ready', offlineJournalReason: 'none' })
    const { authSession, trustedEvent, handler } = setup(gateway)
    authSession.signIn('admin')
    const old = handler(trustedEvent)
    await expect(handler(trustedEvent)).resolves.toMatchObject({ connection: 'CONNECTED', pendingSyncItems: 2 })
    rejectOlder(new Error('older timeout'))
    await expect(old).resolves.toMatchObject({ connection: 'CONNECTED', pendingSyncItems: 2 })
  })

  it('continues RAM event retrieval when fresh offline storage readiness is false', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockResolvedValue({
      device: 'dental-inventory-esp32', online: true, mode: 'idle',
      rtc: true, sd: false, offlineReady: false, pendingSyncItems: 0
    })
    const { authSession, trustedEvent, handler, next } = setup(gateway)
    authSession.signIn('admin')
    await expect(handler(trustedEvent)).resolves.toMatchObject({
      connection: 'CONNECTED', sd: false, offlineReady: false
    })
    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledOnce()
  })

  it.each([
    ['timeout', new HardwareGatewayError('UNAVAILABLE', 'Timed out.', 'REQUEST_TIMEOUT')],
    ['network failure', new HardwareGatewayError('UNAVAILABLE', 'Connection failed.', 'NETWORK_FAILURE')],
    ['malformed status', new HardwareGatewayError('INVALID_RESPONSE', 'Malformed status.')],
    ['HTTP error', new HardwareGatewayError('UNAVAILABLE', 'HTTP failed.', undefined, 503)]
  ])('treats one %s as unconfirmed transport, not failed components', async (_name, error) => {
    const gateway = createGateway()
    const { authSession, trustedEvent, handler, next } = setup(gateway)
    authSession.signIn('admin')
    await expect(handler(trustedEvent)).resolves.toMatchObject({
      connection: 'CONNECTED', rtc: true, sd: true
    })
    vi.mocked(gateway.getStatus).mockRejectedValueOnce(error)
    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'CHECKING', device: 'dental-inventory-esp32',
      mode: 'restock', rtc: true, sd: true
    })
    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
  })

  it('omits offline journal metadata when older firmware does not report it', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getStatus).mockResolvedValueOnce({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true
    })
    const { authSession, trustedEvent, handler } = setup(gateway)
    authSession.signIn('admin')

    const status = await handler(trustedEvent)
    expect(status).not.toHaveProperty('pendingSyncItems')
    expect(status).not.toHaveProperty('offlineReady')
  })

  it('does not contact hardware for a signed-out or untrusted renderer', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, handler, dispose } = setup(gateway)

    await expect(handler(trustedEvent)).resolves.toMatchObject({ connection: 'OFFLINE' })
    expect(gateway.getStatus).not.toHaveBeenCalled()

    authSession.signIn('admin')
    const untrustedEvent = {
      sender: { isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    } as unknown as IpcMainInvokeEvent
    await expect(handler(untrustedEvent)).resolves.toMatchObject({ connection: 'OFFLINE' })
    expect(gateway.getStatus).not.toHaveBeenCalled()
    dispose()
  })

  it('renews desktop presence only for the authenticated trusted renderer', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, heartbeat, dispose } = setup(gateway)
    authSession.signIn('admin')

    await expect(heartbeat(trustedEvent)).resolves.toBe(true)
    expect(gateway.sendDesktopHeartbeat).toHaveBeenCalledExactlyOnceWith()
    dispose()
  })

  it('permits backend-owned RTC recovery only after an authenticated heartbeat', async () => {
    const gateway = createGateway()
    const rtcRecoveryCoordinator: RtcRecoveryCoordinator = {
      synchronizeIfNeeded: vi.fn().mockResolvedValue('SYNCHRONIZED')
    }
    const { authSession, trustedEvent, heartbeat, dispose } = setup(
      gateway,
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      null,
      rtcRecoveryCoordinator
    )

    await expect(heartbeat(trustedEvent)).resolves.toBe(false)
    expect(rtcRecoveryCoordinator.synchronizeIfNeeded).not.toHaveBeenCalled()

    authSession.signIn('admin')
    await expect(heartbeat(trustedEvent, { epochSeconds: 0 })).resolves.toBe(true)
    expect(rtcRecoveryCoordinator.synchronizeIfNeeded).toHaveBeenCalledExactlyOnceWith()
    dispose()
  })

  it('keeps an accepted heartbeat valid when RTC recovery remains fail-closed', async () => {
    const gateway = createGateway()
    const rtcRecoveryCoordinator: RtcRecoveryCoordinator = {
      synchronizeIfNeeded: vi.fn().mockRejectedValue(new Error('RTC sync failed'))
    }
    const test = setup(
      gateway,
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      null,
      rtcRecoveryCoordinator
    )
    test.authSession.signIn('admin')

    await expect(test.heartbeat(test.trustedEvent)).resolves.toBe(true)
    expect(gateway.sendDesktopHeartbeat).toHaveBeenCalledOnce()
    test.dispose()
  })

  it('runs the real heartbeat-status-gateway RTC recovery path exactly once without renderer time', async () => {
    const deviceToken = 'a'.repeat(64)
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse({ desktopOnline: true }))
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: false,
        rtcState: 'needs_sync', rtcReason: 'lost_power', sd: true,
        desktopOnline: true, offlineCacheAvailable: true,
        offlineCacheGeneration: `v1-${'a'.repeat(64)}`, offlineCacheItems: 2,
        pendingSyncItems: 2, offlineReady: false
      }))
      .mockResolvedValueOnce(jsonResponse({
        synchronized: true, rtcState: 'ready', alreadyReady: false
      }))
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://esp32.test', deviceToken, fetcher
    })
    const rtcRecoveryCoordinator = createRtcRecoveryCoordinator({
      gateway,
      now: () => Date.UTC(2026, 8, 10, 12, 30, 45),
      logger: { info: vi.fn(), error: vi.fn() }
    })
    const test = setup(
      gateway,
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      null,
      rtcRecoveryCoordinator
    )
    test.authSession.signIn('admin')

    await expect(test.heartbeat(test.trustedEvent, {
      epochSeconds: 0,
      utcOffsetMinutes: -999
    })).resolves.toBe(true)

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://esp32.test/desktop/heartbeat',
      'http://esp32.test/status',
      'http://esp32.test/rtc/sync'
    ])
    const rtcRequest = fetcher.mock.calls[2]?.[1]
    expect(JSON.parse(rtcRequest?.body ?? '')).toEqual({
      epochSeconds: Math.floor(Date.UTC(2026, 8, 10, 12, 30, 45) / 1_000),
      utcOffsetMinutes: -new Date(Date.UTC(2026, 8, 10, 12, 30, 45)).getTimezoneOffset()
    })
    expect(rtcRequest?.headers).toMatchObject({ 'X-Device-Token': deviceToken })
    expect(fetcher.mock.calls.some(([url]) => url.includes('/offline/events/'))).toBe(false)
    expect(test.inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
    test.dispose()
  })

  it('does not renew desktop presence while signed out or from an untrusted frame', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, heartbeat, dispose } = setup(gateway)

    await expect(heartbeat(trustedEvent)).resolves.toBe(false)
    authSession.signIn('admin')
    const untrustedEvent = {
      sender: { isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    } as unknown as IpcMainInvokeEvent
    await expect(heartbeat(untrustedEvent)).resolves.toBe(false)
    expect(gateway.sendDesktopHeartbeat).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps a failed or unconfigured heartbeat harmless and recoverable', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.sendDesktopHeartbeat)
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(undefined)
    const { authSession, trustedEvent, heartbeat, dispose } = setup(gateway)
    authSession.signIn('admin')

    await expect(heartbeat(trustedEvent)).resolves.toBe(false)
    await expect(heartbeat(trustedEvent)).resolves.toBe(true)
    expect(gateway.sendDesktopHeartbeat).toHaveBeenCalledTimes(2)
    dispose()

    const unconfigured = setup(null)
    unconfigured.authSession.signIn('admin')
    await expect(unconfigured.heartbeat(unconfigured.trustedEvent)).resolves.toBe(false)
    unconfigured.dispose()
  })

  it('uses authenticated heartbeats to refresh once when needed and marks a failed link stale', async () => {
    const gateway = createGateway()
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    const { authSession, trustedEvent, heartbeat, dispose } = setup(
      gateway,
      createInventoryService(),
      createTransactionCoordinator(),
      cacheCoordinator
    )
    authSession.signIn('admin')

    await expect(heartbeat(trustedEvent)).resolves.toBe(true)
    await expect(heartbeat(trustedEvent)).resolves.toBe(true)
    expect(cacheCoordinator.refreshIfNeeded).toHaveBeenCalledTimes(2)
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
    expect(cacheCoordinator.markStale).not.toHaveBeenCalled()

    vi.mocked(gateway.sendDesktopHeartbeat).mockRejectedValueOnce(new Error('link lost'))
    await expect(heartbeat(trustedEvent)).resolves.toBe(false)
    expect(cacheCoordinator.markStale).toHaveBeenCalledOnce()
    expect(cacheCoordinator.refreshIfNeeded).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('delivers a scan without implicitly acknowledging it', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, next } = setup(gateway)
    authSession.signIn('admin')

    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledExactlyOnceWith()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('retrieves a pending offline event without mutating hardware, inventory, or receipts', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const transactionCoordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, offlineNext } = setup(
      gateway,
      inventoryService,
      transactionCoordinator
    )
    authSession.signIn('admin')

    await expect(offlineNext(trustedEvent)).resolves.toEqual({
      ok: true,
      value: offlinePendingEvent
    })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledExactlyOnceWith()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(inventoryService.processHardwareTransaction).not.toHaveBeenCalled()
    expect(transactionCoordinator.processTransaction).not.toHaveBeenCalled()
  })

  it('re-fetches and applies only the backend-owned oldest offline event', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService,
      createTransactionCoordinator(),
      cacheCoordinator
    )
    authSession.signIn('admin')

    await expect(
      reconcileOffline(
        trustedEvent,
        {
          eventId: 'off-FORGED',
          resultingStock: 999_999,
          stockStatus: 'HIGH',
          sql: 'UPDATE products SET current_stock = 999999'
        },
        'http://untrusted.example/offline/events/delete',
        'DELETE'
      )
    ).resolves.toEqual({
      ok: true,
      value: { status: 'APPLIED', receipt: offlineReconciliationReceipt }
    })

    expect(gateway.getNextOfflineEvent).toHaveBeenCalledExactlyOnceWith()
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledExactlyOnceWith(
      offlinePendingEvent
    )
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(inventoryService.processHardwareTransaction).not.toHaveBeenCalled()
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
    expect(cacheCoordinator.refreshIfNeeded).not.toHaveBeenCalled()
  })

  it('reports an authoritative empty journal without calling SQLite', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(gateway.getNextOfflineEvent).mockResolvedValueOnce(null)
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService
    )
    authSession.signIn('admin')

    await expect(reconcileOffline(trustedEvent)).resolves.toEqual({
      ok: true,
      value: { status: 'NO_PENDING_EVENT' }
    })
    expect(inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('invokes the backend-owned offline sync without forwarding renderer arguments', async () => {
    const syncCoordinator = createOfflineSyncCoordinator()
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const { authSession, trustedEvent, synchronizeOffline } = setup(
      gateway,
      inventoryService,
      createTransactionCoordinator(),
      null,
      syncCoordinator
    )
    authSession.signIn('admin')

    await expect(synchronizeOffline(
      trustedEvent,
      { eventId: 'off-FORGED', resultingStock: 999_999 },
      'http://untrusted.example/offline/events/ack',
      { method: 'DELETE', products: [{ currentStock: 999_999 }] }
    )).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'COMPLETE',
        counts: { appliedEvents: 1, acknowledgedEvents: 1 },
        pendingSyncItems: 0
      }
    })
    expect(syncCoordinator.synchronize).toHaveBeenCalledExactlyOnceWith()
    expect(gateway.getNextOfflineEvent).not.toHaveBeenCalled()
    expect(inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
  })

  it('blocks offline sync while signed out or outside the trusted main frame', async () => {
    const syncCoordinator = createOfflineSyncCoordinator()
    const { authSession, trustedEvent, synchronizeOffline } = setup(
      createGateway(),
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      syncCoordinator
    )

    await expect(synchronizeOffline(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    authSession.signIn('admin')
    for (const untrustedEvent of [
      { ...trustedEvent, sender: { isDestroyed: () => false, mainFrame: {} } },
      { ...trustedEvent, senderFrame: {} },
      {
        ...trustedEvent,
        sender: { isDestroyed: () => true, mainFrame: trustedEvent.senderFrame }
      }
    ]) {
      await expect(synchronizeOffline(untrustedEvent)).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' }
      })
    }
    expect(syncCoordinator.synchronize).not.toHaveBeenCalled()
  })

  it('sanitizes offline sync failures and leaves the fixed API retryable', async () => {
    const retryOutcome: OfflineSyncOutcome = {
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: {
        appliedEvents: 1,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 0
      },
      eventId: offlinePendingEvent.eventId
    }
    const syncCoordinator = createOfflineSyncCoordinator(retryOutcome)
    vi.mocked(syncCoordinator.synchronize)
      .mockRejectedValueOnce(new Error('SQLITE_IOERR at C:/private/inventory.db'))
      .mockResolvedValueOnce(retryOutcome)
    const { authSession, trustedEvent, synchronizeOffline } = setup(
      createGateway(),
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      syncCoordinator
    )
    authSession.signIn('admin')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(synchronizeOffline(trustedEvent)).resolves.toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to synchronize offline transactions. No completion was assumed; retry is safe.'
      }
    })
    await expect(synchronizeOffline(trustedEvent)).resolves.toEqual({
      ok: true,
      value: retryOutcome
    })
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      'Offline synchronization IPC request failed internally.'
    )
    consoleError.mockRestore()
  })

  it('coalesces concurrent offline sync IPC requests', async () => {
    const completeOutcome: OfflineSyncOutcome = {
      status: 'COMPLETE',
      counts: {
        appliedEvents: 0,
        alreadyAppliedEvents: 0,
        acknowledgedEvents: 0
      },
      pendingSyncItems: 0,
      cache: {
        generation: `v1-${'b'.repeat(64)}`,
        itemCount: 0,
        alreadyCurrent: true
      }
    }
    let release: ((outcome: OfflineSyncOutcome) => void) | undefined
    const syncCoordinator = createOfflineSyncCoordinator()
    vi.mocked(syncCoordinator.synchronize).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const { authSession, trustedEvent, synchronizeOffline } = setup(
      createGateway(),
      createInventoryService(),
      createTransactionCoordinator(),
      null,
      syncCoordinator
    )
    authSession.signIn('admin')

    const first = synchronizeOffline(trustedEvent)
    const second = synchronizeOffline(trustedEvent)
    await Promise.resolve()
    expect(syncCoordinator.synchronize).toHaveBeenCalledOnce()
    release?.(completeOutcome)

    await expect(first).resolves.toEqual({ ok: true, value: completeOutcome })
    await expect(second).resolves.toEqual({ ok: true, value: completeOutcome })
    expect(syncCoordinator.synchronize).toHaveBeenCalledOnce()
  })

  it('reports unconfigured offline sync through the sanitized failure boundary', async () => {
    const { authSession, trustedEvent, synchronizeOffline } = setup(null)
    authSession.signIn('admin')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(synchronizeOffline(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' }
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Offline synchronization IPC request failed internally.'
    )
    consoleError.mockRestore()
  })

  it('returns the durable replay disposition while leaving firmware pending', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent)
      .mockReturnValueOnce({ status: 'APPLIED', receipt: offlineReconciliationReceipt })
      .mockReturnValueOnce({
        status: 'ALREADY_APPLIED',
        receipt: offlineReconciliationReceipt
      })
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService
    )
    authSession.signIn('admin')

    await expect(reconcileOffline(trustedEvent)).resolves.toMatchObject({
      ok: true,
      value: { status: 'APPLIED' }
    })
    await expect(reconcileOffline(trustedEvent)).resolves.toEqual({
      ok: true,
      value: {
        status: 'ALREADY_APPLIED',
        receipt: offlineReconciliationReceipt
      }
    })

    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(2)
    expect(inventoryService.reconcileOfflineEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it.each([
    'INVALID_EVENT',
    'EVENT_ID_CONFLICT',
    'PRODUCT_NOT_ACTIVE',
    'PRODUCT_IDENTITY_CONFLICT',
    'INSUFFICIENT_STOCK',
    'STOCK_OVERFLOW'
  ] as const)('returns a typed %s reconciliation conflict without firmware mutation', async (code) => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.reconcileOfflineEvent).mockImplementationOnce(() => {
      throw new OfflineReconciliationConflictError(
        code,
        'This offline transaction conflicts with current inventory.',
        offlinePendingEvent.eventId
      )
    })
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService
    )
    authSession.signIn('admin')

    await expect(reconcileOffline(trustedEvent)).resolves.toEqual({
      ok: true,
      value: {
        status: 'CONFLICT',
        conflict: {
          code,
          message: 'This offline transaction conflicts with current inventory.',
          eventId: offlinePendingEvent.eventId
        }
      }
    })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
  })

  it('sanitizes offline transport and SQLite failures while preserving retry', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(gateway.getNextOfflineEvent)
      .mockRejectedValueOnce(new Error('http://192.168.1.90/private-route'))
      .mockResolvedValueOnce(offlinePendingEvent)
    vi.mocked(inventoryService.reconcileOfflineEvent).mockImplementationOnce(() => {
      throw new Error('SQLITE_CONSTRAINT secret_table')
    })
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService
    )
    authSession.signIn('admin')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const expectedFailure = {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to reconcile the pending offline transaction. Check the ESP32 and retry.'
      }
    }
    await expect(reconcileOffline(trustedEvent)).resolves.toEqual(expectedFailure)
    await expect(reconcileOffline(trustedEvent)).resolves.toEqual(expectedFailure)
    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledWith(
      'Offline reconciliation IPC request failed internally.'
    )
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('distinguishes authoritative empty offline state from sanitized retryable failure', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, offlineNext } = setup(gateway)
    authSession.signIn('admin')
    vi.mocked(gateway.getNextOfflineEvent)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('private URL or protocol detail'))
      .mockResolvedValueOnce(offlinePendingEvent)

    await expect(offlineNext(trustedEvent)).resolves.toEqual({ ok: true, value: null })
    await expect(offlineNext(trustedEvent)).resolves.toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The offline operation could not be confirmed. It is safe to retry.'
      }
    })
    await expect(offlineNext(trustedEvent)).resolves.toEqual({
      ok: true,
      value: offlinePendingEvent
    })
    expect(gateway.getNextOfflineEvent).toHaveBeenCalledTimes(3)
  })

  it('does not retrieve offline records for signed-out or untrusted renderers', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, offlineNext } = setup(gateway)

    await expect(offlineNext(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    authSession.signIn('admin')
    await expect(offlineNext({
      ...trustedEvent,
      sender: { isDestroyed: () => false, mainFrame: {} }
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    await expect(offlineNext({ ...trustedEvent, senderFrame: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    expect(gateway.getNextOfflineEvent).not.toHaveBeenCalled()
  })

  it('blocks offline reconciliation while signed out or outside the trusted main frame', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const { authSession, trustedEvent, reconcileOffline } = setup(
      gateway,
      inventoryService
    )

    await expect(reconcileOffline(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })

    authSession.signIn('admin')
    for (const untrustedEvent of [
      { ...trustedEvent, sender: { isDestroyed: () => false, mainFrame: {} } },
      { ...trustedEvent, senderFrame: {} },
      {
        ...trustedEvent,
        sender: { isDestroyed: () => true, mainFrame: trustedEvent.senderFrame }
      }
    ]) {
      await expect(reconcileOffline(untrustedEvent)).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' }
      })
    }

    expect(gateway.getNextOfflineEvent).not.toHaveBeenCalled()
    expect(inventoryService.reconcileOfflineEvent).not.toHaveBeenCalled()
  })

  it('reports missing hardware as retryable offline retrieval failure', async () => {
    const { authSession, trustedEvent, offlineNext } = setup(null)
    authSession.signIn('admin')

    await expect(offlineNext(trustedEvent)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' }
    })
  })

  it('reports missing hardware as a sanitized reconciliation failure', async () => {
    const { authSession, trustedEvent, reconcileOffline } = setup(null)
    authSession.signIn('admin')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(reconcileOffline(trustedEvent)).resolves.toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to reconcile the pending offline transaction. Check the ESP32 and retry.'
      }
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Offline reconciliation IPC request failed internally.'
    )
    consoleError.mockRestore()
  })

  it('returns null for an empty queue or a failed poll without acknowledging anything', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, next } = setup(gateway)
    authSession.signIn('admin')
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce(null)
    await expect(next(trustedEvent)).resolves.toBeNull()
    vi.mocked(gateway.getNextTransactionEvent).mockRejectedValueOnce(new Error('private transport detail'))
    await expect(next(trustedEvent)).resolves.toBeNull()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('acknowledges an explicitly rejected unknown event through the backend gateway', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const { authSession, trustedEvent, acknowledge } = setup(gateway, inventoryService)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledExactlyOnceWith()
    expect(inventoryService.findProductByBarcode).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.barcode
    )
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId,
      'unknown_barcode'
    )
  })

  it('acknowledges an explicitly cancelled registered event before any commit', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.findProductByBarcode).mockReturnValue({
      id: 7,
      barcode: hardwareEvent.barcode,
      itemName: 'Cleanser',
      category: 'General',
      imagePath: '',
      currentStock: 20,
      lowStockThreshold: 5,
      status: 'HIGH',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, acknowledge } = setup(
      gateway,
      inventoryService,
      coordinator
    )
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })
    expect(coordinator.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith(hardwareEvent.eventId)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(hardwareEvent.eventId)
    expect(coordinator.processTransaction).not.toHaveBeenCalled()
  })

  it('refuses cancellation after a durable transaction receipt exists', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    vi.mocked(inventoryService.findProductByBarcode).mockReturnValue({
      id: 7,
      barcode: hardwareEvent.barcode,
      itemName: 'Cleanser',
      category: 'General',
      imagePath: '',
      currentStock: 20,
      lowStockThreshold: 5,
      status: 'HIGH',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.getTransactionReceipt).mockReturnValue(transactionReceipt)
    const { authSession, trustedEvent, acknowledge } = setup(
      gateway,
      inventoryService,
      coordinator
    )
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'This inventory transaction is already saved and must finish recovery.'
      }
    })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(coordinator.processTransaction).not.toHaveBeenCalled()
  })

  it('serializes cancellation behind FIFO validation, commit, result delivery, and acknowledgement', async () => {
    const database = initializeDatabase({ databasePath: ':memory:' })
    const inventoryService = createSqliteInventoryService(database, {
      createTransactionId: () => 'movement-serialized-1'
    })
    inventoryService.createProduct({
      barcode: hardwareEvent.barcode,
      itemName: 'Cleanser',
      category: 'General',
      initialStock: 20,
      lowStockThreshold: 5
    })

    const nextEvent = {
      ...hardwareEvent,
      eventId: 'evt-session-2',
      mode: 'checkout'
    } as const
    const hardwareQueue = [hardwareEvent, nextEvent]
    const gateway = createGateway()
    let releaseInitialHead!: () => void
    const initialHead = new Promise<typeof hardwareEvent>((resolve) => {
      releaseInitialHead = () => resolve(hardwareEvent)
    })
    let headRequestCount = 0
    vi.mocked(gateway.getNextTransactionEvent).mockImplementation(async () => {
      headRequestCount += 1
      if (headRequestCount === 1) return initialHead
      return hardwareQueue[0] ?? null
    })
    vi.mocked(gateway.acknowledgeTransactionEvent).mockImplementation(async (eventId) => {
      if (hardwareQueue[0]?.eventId !== eventId) {
        throw new Error('The ACK must never consume a different FIFO head.')
      }
      hardwareQueue.shift()
    })

    let releaseResultDelivery!: () => void
    const resultDelivery = new Promise<void>((resolve) => {
      releaseResultDelivery = resolve
    })
    vi.mocked(gateway.deliverTransactionResult).mockReturnValue(resultDelivery)

    const coordinator = createHardwareTransactionCoordinator({
      inventoryService,
      gateway
    })
    const {
      authSession,
      trustedEvent,
      acknowledge,
      process,
      dispose
    } = setup(gateway, inventoryService, coordinator)
    authSession.signIn('admin')

    try {
      const processing = process(trustedEvent, {
        eventId: hardwareEvent.eventId,
        quantity: 2
      })
      await vi.waitFor(() => {
        expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(1)
      })

      let cancellationSettled = false
      const cancellation = Promise.resolve(
        acknowledge(trustedEvent, hardwareEvent.eventId)
      ).finally(() => {
        cancellationSettled = true
      })
      await Promise.resolve()
      await Promise.resolve()

      // Confirmation owns the FIFO mutation lane from its first authoritative
      // head read. Cancellation cannot overtake it and ACK the same event while
      // confirmation is still validating which event it will commit.
      expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(1)
      expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
      expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
      expect(cancellationSettled).toBe(false)
      expect(hardwareQueue).toEqual([hardwareEvent, nextEvent])
      expect(inventoryService.findProductByBarcode(hardwareEvent.barcode)).toMatchObject({
        currentStock: 20
      })
      expect(inventoryService.listMovementHistory()).toHaveLength(0)
      expect(inventoryService.findHardwareTransactionReceipt(hardwareEvent.eventId)).toBeNull()

      releaseInitialHead()
      await vi.waitFor(() => {
        expect(gateway.deliverTransactionResult).toHaveBeenCalledTimes(1)
      })

      // SQLite is already committed, but result delivery is deliberately held
      // open. A simultaneous Cancel request must remain behind that operation.
      expect(inventoryService.findProductByBarcode(hardwareEvent.barcode)).toMatchObject({
        currentStock: 22
      })
      expect(inventoryService.listMovementHistory()).toHaveLength(1)
      expect(inventoryService.findHardwareTransactionReceipt(hardwareEvent.eventId)).toMatchObject({
        resultDeliveredToHardware: false
      })
      expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(2)
      expect(gateway.deliverTransactionResult).toHaveBeenCalledExactlyOnceWith({
        eventId: hardwareEvent.eventId,
        result: 'success',
        mode: hardwareEvent.mode,
        quantity: 2,
        resultingStock: 22,
        stockStatus: 'HIGH'
      })
      expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
      expect(cancellationSettled).toBe(false)
      expect(hardwareQueue).toEqual([hardwareEvent, nextEvent])

      releaseResultDelivery()

      await expect(processing).resolves.toMatchObject({
        ok: true,
        value: {
          acknowledged: true,
          receipt: {
            eventId: hardwareEvent.eventId,
            newTotal: 22,
            resultDeliveredToHardware: true
          }
        }
      })
      await expect(cancellation).resolves.toEqual({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'This inventory transaction is already saved and must finish recovery.'
        }
      })

      expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(3)
      expect(gateway.deliverTransactionResult).toHaveBeenCalledTimes(1)
      expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
        hardwareEvent.eventId
      )
      expect(hardwareQueue).toEqual([nextEvent])
      expect(inventoryService.findProductByBarcode(hardwareEvent.barcode)).toMatchObject({
        currentStock: 22
      })
      expect(inventoryService.listMovementHistory()).toHaveLength(1)
      expect(inventoryService.findHardwareTransactionReceipt(hardwareEvent.eventId)).toMatchObject({
        newTotal: 22,
        resultDeliveredToHardware: true
      })
    } finally {
      releaseInitialHead()
      releaseResultDelivery()
      dispose()
      database.close()
    }
  })

  it('retries an old cancellation ID when the FIFO advanced after a lost response', async () => {
    const gateway = createGateway()
    const inventoryService = createInventoryService()
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, acknowledge } = setup(
      gateway,
      inventoryService,
      coordinator
    )
    authSession.signIn('admin')

    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce({
      ...hardwareEvent,
      eventId: 'evt-other'
    })
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })

    expect(coordinator.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
    expect(inventoryService.findProductByBarcode).not.toHaveBeenCalled()
  })

  it('rejects a true cancellation mismatch without consuming the current FIFO head', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce({
      ...hardwareEvent,
      eventId: 'evt-other'
    })
    vi.mocked(gateway.acknowledgeTransactionEvent).mockRejectedValueOnce(
      new HardwareGatewayError('REJECTED', 'Old event ID was not acknowledged.',
        'event_id_mismatch', 409)
    )
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'A different hardware scan is currently pending.'
      }
    })
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledExactlyOnceWith()
  })

  it('does not misreport an ACK transport timeout as a different event', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce({
      ...hardwareEvent, eventId: 'evt-other'
    })
    vi.mocked(gateway.acknowledgeTransactionEvent).mockRejectedValueOnce(
      new HardwareGatewayError('UNAVAILABLE', 'private URL', 'REQUEST_TIMEOUT')
    )
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The ESP32 acknowledgement timed out. The scan remains recoverable; please retry or choose Review later.'
      }
    })
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
  })

  it('retries a transient cancellation preflight read without ACKing a different head', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent)
      .mockRejectedValueOnce(new HardwareGatewayError(
        'UNAVAILABLE', 'response delayed', 'REQUEST_TIMEOUT'
      ))
      .mockResolvedValueOnce(hardwareEvent)
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true, value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId, 'unknown_barcode'
    )
  })

  it('retries only the exact event ID after an ambiguous cancellation timeout', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.acknowledgeTransactionEvent)
      .mockRejectedValueOnce(new HardwareGatewayError(
        'UNAVAILABLE', 'response lost', 'REQUEST_TIMEOUT'
      ))
      .mockResolvedValueOnce(undefined)
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true, value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledTimes(2)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenNthCalledWith(
      1, hardwareEvent.eventId, 'unknown_barcode'
    )
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenNthCalledWith(
      2, hardwareEvent.eventId, 'unknown_barcode'
    )
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledOnce()
  })

  it('treats an already-empty uncommitted queue as idempotent cancellation success', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce(null)
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('never retries cancellation after a durable receipt when the FIFO already advanced', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValueOnce({
      ...hardwareEvent,
      eventId: 'evt-other'
    })
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.getTransactionReceipt).mockReturnValue(transactionReceipt)
    const { authSession, trustedEvent, acknowledge } = setup(
      gateway,
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'This inventory transaction is already saved and must finish recovery.'
      }
    })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('reconciles a lost ACK response when the event has already left the FIFO', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent)
      .mockResolvedValueOnce(hardwareEvent)
      .mockResolvedValueOnce(null)
    vi.mocked(gateway.acknowledgeTransactionEvent).mockRejectedValueOnce(
      new Error('Response lost after ESP32 applied ACK')
    )
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId,
      'unknown_barcode'
    )
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledTimes(2)
  })

  it('reports a failed ACK without leaking transport details and allows a retry', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')
    vi.mocked(gateway.acknowledgeTransactionEvent).mockRejectedValueOnce(new Error('private URL/token'))

    const failure = await acknowledge(trustedEvent, hardwareEvent.eventId)
    expect(failure).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to acknowledge this scan. Check the ESP32 connection and retry.'
      }
    })
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({ ok: true })
  })

  it.each([undefined, null, 1, {}, '', ' event', 'event/id', 'x'.repeat(64)])(
    'rejects an invalid ACK ID before contacting hardware: %j',
    async (invalidId) => {
      const gateway = createGateway()
      const { authSession, trustedEvent, acknowledge } = setup(gateway)
      authSession.signIn('admin')
      await expect(acknowledge(trustedEvent, invalidId)).resolves.toMatchObject({
        ok: false, error: { code: 'VALIDATION_ERROR' }
      })
      expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
      expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    }
  )

  it('exposes durable receipt lookup and atomic processing only through the coordinator', async () => {
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.getTransactionReceipt).mockReturnValue(transactionReceipt)
    const { authSession, trustedEvent, getReceipt, process } = setup(
      createGateway(),
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')

    await expect(getReceipt(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: transactionReceipt
    })
    await expect(
      process(trustedEvent, { eventId: hardwareEvent.eventId, quantity: 2, ignored: 'value' })
    ).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: true }
    })
    expect(coordinator.getTransactionReceipt).toHaveBeenCalledTimes(2)
    expect(coordinator.getTransactionReceipt).toHaveBeenNthCalledWith(1, hardwareEvent.eventId)
    expect(coordinator.getTransactionReceipt).toHaveBeenNthCalledWith(2, hardwareEvent.eventId)
    expect(coordinator.processTransaction).toHaveBeenCalledExactlyOnceWith({
      eventId: hardwareEvent.eventId,
      quantity: 2
    })
  })

  it('starts cache refresh only after the Phase 5 transaction coordinator settles', async () => {
    const coordinator = createTransactionCoordinator()
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    let finishTransaction!: () => void
    vi.mocked(coordinator.processTransaction).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishTransaction = () => resolve({
          receipt: transactionReceipt,
          acknowledged: true
        })
      })
    )
    const { authSession, trustedEvent, process } = setup(
      createGateway(),
      createInventoryService(),
      coordinator,
      cacheCoordinator
    )
    authSession.signIn('admin')

    const pending = process(trustedEvent, {
      eventId: hardwareEvent.eventId,
      quantity: 2
    })
    await vi.waitFor(() => expect(coordinator.processTransaction).toHaveBeenCalledOnce())
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()

    finishTransaction()
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: true }
    })
    await vi.waitFor(() => expect(cacheCoordinator.refresh).toHaveBeenCalledOnce())
  })

  it('keeps a committed hardware outcome successful when pending records defer cache refresh', async () => {
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    vi.mocked(cacheCoordinator.refresh).mockRejectedValueOnce(
      new Error('ESP32 has pending offline records')
    )
    const { authSession, trustedEvent, process } = setup(
      createGateway(),
      createInventoryService(),
      createTransactionCoordinator(),
      cacheCoordinator
    )
    authSession.signIn('admin')

    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId,
      quantity: 2
    })).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: true }
    })
    await vi.waitFor(() => expect(cacheCoordinator.refresh).toHaveBeenCalledOnce())
  })

  it('returns committed success without waiting for a slow post-commit cache transfer', async () => {
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    vi.mocked(cacheCoordinator.refresh).mockReturnValue(new Promise(() => undefined))
    const { authSession, trustedEvent, process } = setup(
      createGateway(), createInventoryService(), createTransactionCoordinator(), cacheCoordinator
    )
    authSession.signIn('admin')

    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId, quantity: 2
    })).resolves.toMatchObject({ ok: true, value: { acknowledged: true } })
    await vi.waitFor(() => expect(cacheCoordinator.refresh).toHaveBeenCalledOnce())
  })

  it('reuses pending cache maintenance instead of forcing duplicate refreshes on result and ACK retry', async () => {
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, retryResult, retryAck } = setup(
      createGateway(),
      createInventoryService(),
      coordinator,
      cacheCoordinator
    )
    authSession.signIn('admin')

    await expect(retryResult(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: true
    })
    const resultRecoveryOrder = vi.mocked(
      coordinator.retryTransactionResultDelivery
    ).mock.invocationCallOrder[0]
    await vi.waitFor(() => expect(cacheCoordinator.refreshIfNeeded).toHaveBeenCalledOnce())
    const resultRefreshOrder = vi.mocked(cacheCoordinator.refreshIfNeeded).mock.invocationCallOrder[0]
    expect(resultRecoveryOrder).toBeLessThan(resultRefreshOrder as number)

    await expect(retryAck(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: true
    })
    const ackRecoveryOrder = vi.mocked(
      coordinator.retryTransactionAcknowledgement
    ).mock.invocationCallOrder[0]
    await vi.waitFor(() => expect(cacheCoordinator.refreshIfNeeded).toHaveBeenCalledTimes(2))
    const ackRefreshOrder = vi.mocked(cacheCoordinator.refreshIfNeeded).mock.invocationCallOrder[1]
    expect(ackRecoveryOrder).toBeLessThan(ackRefreshOrder as number)
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('does not refresh after unauthorized, invalid, or failed hardware processing', async () => {
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, process } = setup(
      createGateway(),
      createInventoryService(),
      coordinator,
      cacheCoordinator
    )

    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId,
      quantity: 2
    })).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    authSession.signIn('admin')
    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId,
      quantity: 0
    })).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    vi.mocked(coordinator.processTransaction).mockRejectedValueOnce(new Error('transaction failed'))
    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId,
      quantity: 2
    })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })

    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('reports a pre-commit ESP32 verification failure without exposing transport details', async () => {
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.processTransaction).mockRejectedValueOnce(
      new HardwareTransactionCoordinatorError('HARDWARE_UNAVAILABLE', 'private LAN URL')
    )
    const { authSession, trustedEvent, process } = setup(
      createGateway(), createInventoryService(), coordinator
    )
    authSession.signIn('admin')
    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId, quantity: 2
    })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Inventory was not updated') }
    })
  })

  it('does not force another cache transfer for a previously committed event ID', async () => {
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.getTransactionReceipt).mockReturnValue(transactionReceipt)
    const cacheCoordinator = createOfflineInventoryCacheCoordinator()
    const { authSession, trustedEvent, process } = setup(
      createGateway(), createInventoryService(), coordinator, cacheCoordinator
    )
    authSession.signIn('admin')
    await expect(process(trustedEvent, {
      eventId: hardwareEvent.eventId, quantity: 2
    })).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(cacheCoordinator.refreshIfNeeded).toHaveBeenCalledOnce())
    expect(cacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('preserves DB-success/ACK-failure as a successful committed outcome', async () => {
    const coordinator = createTransactionCoordinator()
    vi.mocked(coordinator.processTransaction).mockResolvedValue({
      receipt: transactionReceipt,
      acknowledged: false
    })
    const { authSession, trustedEvent, process } = setup(
      createGateway(),
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')

    await expect(
      process(trustedEvent, { eventId: hardwareEvent.eventId, quantity: 2 })
    ).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: false }
    })
  })

  it('offers ACK-only retry for an already committed receipt', async () => {
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, retryAck } = setup(
      createGateway(),
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')

    await expect(retryAck(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: true }
    })
    expect(coordinator.retryTransactionAcknowledgement).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
    expect(coordinator.processTransaction).not.toHaveBeenCalled()
  })

  it('offers result-delivery recovery through a separate fixed channel', async () => {
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent, retryResult } = setup(
      createGateway(),
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')

    await expect(retryResult(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { receipt: transactionReceipt, acknowledged: true }
    })
    expect(coordinator.retryTransactionResultDelivery).toHaveBeenCalledExactlyOnceWith(
      hardwareEvent.eventId
    )
    expect(coordinator.processTransaction).not.toHaveBeenCalled()
  })

  it.each([
    [IPC_CHANNELS.hardwareGetTransactionReceipt, 'invalid/id'],
    [IPC_CHANNELS.hardwareProcessTransaction, { eventId: hardwareEvent.eventId, quantity: 0 }],
    [IPC_CHANNELS.hardwareProcessTransaction, { eventId: hardwareEvent.eventId, quantity: 10_001 }],
    [IPC_CHANNELS.hardwareRetryTransactionResultDelivery, 'invalid/id'],
    [IPC_CHANNELS.hardwareRetryTransactionAcknowledgement, 'invalid/id']
  ])('validates %s before calling the transaction coordinator', async (channel, payload) => {
    const coordinator = createTransactionCoordinator()
    const { authSession, trustedEvent } = setup(
      createGateway(),
      createInventoryService(),
      coordinator
    )
    authSession.signIn('admin')
    const route = electronMock.handlers.get(channel)
    if (route === undefined) throw new Error(`Missing route ${channel}`)

    await expect(route(trustedEvent, payload)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(coordinator.getTransactionReceipt).not.toHaveBeenCalled()
    expect(coordinator.processTransaction).not.toHaveBeenCalled()
    expect(coordinator.retryTransactionResultDelivery).not.toHaveBeenCalled()
    expect(coordinator.retryTransactionAcknowledgement).not.toHaveBeenCalled()
  })

  it('blocks both event routes when signed out, from another window, or from a subframe', async () => {
    const gateway = createGateway()
    const {
      authSession,
      trustedEvent,
      next,
      acknowledge,
      getReceipt,
      process,
      retryResult,
      retryAck
    } = setup(gateway)
    await expect(next(trustedEvent)).resolves.toBeNull()
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false, error: { code: 'UNAUTHORIZED' }
    })
    await expect(getReceipt(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false, error: { code: 'UNAUTHORIZED' }
    })
    await expect(
      process(trustedEvent, { eventId: hardwareEvent.eventId, quantity: 2 })
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    await expect(retryAck(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false, error: { code: 'UNAUTHORIZED' }
    })
    await expect(retryResult(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false, error: { code: 'UNAUTHORIZED' }
    })

    authSession.signIn('admin')
    for (const untrustedEvent of [
      { ...trustedEvent, sender: { isDestroyed: () => false, mainFrame: {} } },
      { ...trustedEvent, senderFrame: {} }
    ]) {
      await expect(next(untrustedEvent)).resolves.toBeNull()
      await expect(acknowledge(untrustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
        ok: false, error: { code: 'UNAUTHORIZED' }
      })
      await expect(getReceipt(untrustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
        ok: false, error: { code: 'UNAUTHORIZED' }
      })
      await expect(
        process(untrustedEvent, { eventId: hardwareEvent.eventId, quantity: 2 })
      ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
      await expect(retryAck(untrustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
        ok: false, error: { code: 'UNAUTHORIZED' }
      })
      await expect(retryResult(untrustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
        ok: false, error: { code: 'UNAUTHORIZED' }
      })
    }

    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('handles missing hardware configuration without crashing', async () => {
    const { authSession, trustedEvent, next, acknowledge } = setup(null)
    authSession.signIn('admin')
    await expect(next(trustedEvent)).resolves.toBeNull()
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
      ok: false, error: { code: 'INTERNAL_ERROR' }
    })
  })

  it('removes all hardware IPC handlers when disposed', () => {
    const { dispose } = setup()
    dispose()
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareGetStatus)
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareSendDesktopHeartbeat
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareGetNextOfflineEvent
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareReconcileNextOfflineEvent
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareSynchronizeOfflineInventory
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareCaptureRegistrationBarcode
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareGetTransactionReceipt)
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareProcessTransaction)
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareRetryTransactionResultDelivery
    )
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.hardwareRetryTransactionAcknowledgement
    )
    expect(electronMock.handlers.size).toBe(0)
  })
})
