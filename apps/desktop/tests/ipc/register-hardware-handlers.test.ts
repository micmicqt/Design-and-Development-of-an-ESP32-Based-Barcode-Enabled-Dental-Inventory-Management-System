// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import { initializeDatabase } from '../../src/main/database'
import type { HardwareTransactionEventGateway } from '../../src/main/hardware/hardware-gateway'
import {
  createHardwareTransactionCoordinator,
  type HardwareTransactionCoordinator
} from '../../src/main/hardware/hardware-transaction-coordinator'
import {
  createInventoryService as createSqliteInventoryService,
  type InventoryService
} from '../../src/main/inventory'
import { registerHardwareIpcHandlers } from '../../src/main/ipc/register-hardware-handlers'
import {
  IPC_CHANNELS,
  type HardwareStatusDto,
  type HardwareTransactionReceipt
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

describe('authenticated hardware IPC boundary', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.handle.mockClear()
    electronMock.removeHandler.mockClear()
  })

  function setup(
    gateway: HardwareTransactionEventGateway | null = createGateway(),
    inventoryService: InventoryService = createInventoryService(),
    transactionCoordinator: HardwareTransactionCoordinator = createTransactionCoordinator()
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
      getMainWindow: () => mainWindow
    })
    const handler = electronMock.handlers.get(IPC_CHANNELS.hardwareGetStatus)
    if (handler === undefined) throw new Error('Hardware status handler was not registered.')
    const next = electronMock.handlers.get(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    const acknowledge = electronMock.handlers.get(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    const getReceipt = electronMock.handlers.get(IPC_CHANNELS.hardwareGetTransactionReceipt)
    const process = electronMock.handlers.get(IPC_CHANNELS.hardwareProcessTransaction)
    const retryAck = electronMock.handlers.get(IPC_CHANNELS.hardwareRetryTransactionAcknowledgement)
    const retryResult = electronMock.handlers.get(IPC_CHANNELS.hardwareRetryTransactionResultDelivery)
    if (
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
      next,
      acknowledge,
      getReceipt,
      process,
      retryResult,
      retryAck,
      dispose,
      gateway,
      inventoryService,
      transactionCoordinator
    }
  }

  function createGateway(): HardwareTransactionEventGateway {
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
        sd: true
      }),
      getNextTransactionEvent: vi.fn().mockResolvedValue(hardwareEvent),
      deliverTransactionResult: vi.fn().mockResolvedValue(undefined),
      acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
    }
  }

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
      processHardwareTransaction: vi.fn()
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

  it('returns validated status to the authenticated trusted renderer', async () => {
    const { authSession, trustedEvent, handler, dispose } = setup()
    authSession.signIn('admin')

    await expect(handler(trustedEvent)).resolves.toEqual<HardwareStatusDto>({
      connection: 'CONNECTED',
      device: 'dental-inventory-esp32',
      mode: 'restock',
      rtc: true,
      sd: true
    })
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

  it('delivers a scan without implicitly acknowledging it', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, next } = setup(gateway)
    authSession.signIn('admin')

    await expect(next(trustedEvent)).resolves.toEqual(hardwareEvent)
    expect(gateway.getNextTransactionEvent).toHaveBeenCalledExactlyOnceWith()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
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
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(hardwareEvent.eventId)
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
      new Error('The old event ID is not in the recent-ACK receipt.')
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
      hardwareEvent.eventId
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
    expect(coordinator.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith(hardwareEvent.eventId)
    expect(coordinator.processTransaction).toHaveBeenCalledExactlyOnceWith({
      eventId: hardwareEvent.eventId,
      quantity: 2
    })
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
