// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import type { HardwareTransactionEventGateway } from '../../src/main/hardware/hardware-gateway'
import { registerHardwareIpcHandlers } from '../../src/main/ipc/register-hardware-handlers'
import {
  IPC_CHANNELS,
  type HardwareStatusDto
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

describe('authenticated hardware IPC boundary', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.handle.mockClear()
    electronMock.removeHandler.mockClear()
  })

  function setup(gateway: HardwareTransactionEventGateway | null = createGateway()) {
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
      authSession,
      getMainWindow: () => mainWindow
    })
    const handler = electronMock.handlers.get(IPC_CHANNELS.hardwareGetStatus)
    if (handler === undefined) throw new Error('Hardware status handler was not registered.')
    const next = electronMock.handlers.get(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    const acknowledge = electronMock.handlers.get(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    if (next === undefined || acknowledge === undefined) {
      throw new Error('Hardware event handlers were not registered.')
    }
    return { authSession, trustedEvent, handler, next, acknowledge, dispose, gateway }
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
      acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
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

  it('acknowledges only the requested event through the backend gateway', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, acknowledge } = setup(gateway)
    authSession.signIn('admin')

    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toEqual({
      ok: true,
      value: { eventId: hardwareEvent.eventId }
    })
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(hardwareEvent.eventId)
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
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
      expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    }
  )

  it('blocks both event routes when signed out, from another window, or from a subframe', async () => {
    const gateway = createGateway()
    const { authSession, trustedEvent, next, acknowledge } = setup(gateway)
    await expect(next(trustedEvent)).resolves.toBeNull()
    await expect(acknowledge(trustedEvent, hardwareEvent.eventId)).resolves.toMatchObject({
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
    expect(electronMock.handlers.size).toBe(0)
  })
})
