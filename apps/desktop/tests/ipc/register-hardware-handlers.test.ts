// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import type { HardwareStatusGateway } from '../../src/main/hardware/hardware-gateway'
import { registerHardwareIpcHandlers } from '../../src/main/ipc/register-hardware-handlers'
import {
  IPC_CHANNELS,
  type HardwareStatusDto
} from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown) => unknown) => {
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

describe('authenticated hardware status IPC boundary', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.handle.mockClear()
    electronMock.removeHandler.mockClear()
  })

  function setup(gateway: HardwareStatusGateway | null = createGateway()) {
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
    return { authSession, trustedEvent, handler, dispose, gateway }
  }

  function createGateway(): HardwareStatusGateway {
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

  it('removes its IPC handler when disposed', () => {
    const { dispose } = setup()
    dispose()
    expect(electronMock.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.hardwareGetStatus)
  })
})
