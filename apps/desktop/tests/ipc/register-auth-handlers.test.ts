// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import {
  createAuthenticationService,
  createFirstRunAdminService
} from '../../src/main/application/create-authentication-service'
import { initializeAdminCredentials } from '../../src/main/auth'
import { initializeDatabase, type SqliteDatabase } from '../../src/main/database'
import { registerAuthIpcHandlers } from '../../src/main/ipc/register-auth-handlers'
import { IPC_CHANNELS } from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler
  }
}))

describe('first-run administrator IPC boundary', () => {
  let database: SqliteDatabase
  let dispose: () => void
  let trustedEvent: IpcMainInvokeEvent

  beforeEach(() => {
    electronMock.handlers.clear()
    database = initializeDatabase({ databasePath: ':memory:' })
    const mainFrame = {}
    const webContents = { isDestroyed: () => false, mainFrame }
    const mainWindow = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    trustedEvent = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
    dispose = registerAuthIpcHandlers(
      createAuthenticationService(database),
      createFirstRunAdminService(database),
      createAuthSessionController(),
      () => mainWindow
    )
  })

  afterEach(() => {
    dispose()
    database.close()
  })

  function invoke(channel: string, event: IpcMainInvokeEvent, payload?: unknown): Promise<unknown> {
    const handler = electronMock.handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return Promise.resolve(handler(event, payload))
  }

  it('allows one trusted first administrator, then returns to ordinary login', async () => {
    expect(await invoke(IPC_CHANNELS.authGetSetupState, trustedEvent)).toBe(true)
    expect(await invoke(IPC_CHANNELS.authLogin, trustedEvent, {
      username: 'clinic-admin', password: 'a secure clinic password'
    })).toMatchObject({ ok: false, message: 'Access Denied' })

    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, trustedEvent, {
      username: 'clinic-admin', password: 'a secure clinic password'
    })).toEqual({ ok: true })
    expect(await invoke(IPC_CHANNELS.authGetSetupState, trustedEvent)).toBe(false)
    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, trustedEvent, {
      username: 'second-admin', password: 'another secure password'
    })).toEqual({ ok: false, code: 'ALREADY_CONFIGURED' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM configured_admin').get()).toEqual({ count: 1 })
    expect(await invoke(IPC_CHANNELS.authLogin, trustedEvent, {
      username: 'clinic-admin', password: 'wrong password'
    })).toMatchObject({ ok: false, message: 'Access Denied' })
    expect(await invoke(IPC_CHANNELS.authLogin, trustedEvent, {
      username: 'clinic-admin', password: 'a secure clinic password'
    })).toMatchObject({ ok: true, session: { authenticated: true, username: 'clinic-admin' } })
  })

  it('rejects malformed credentials and any untrusted setup request', async () => {
    const untrustedEvent = {
      ...trustedEvent,
      senderFrame: {}
    } as IpcMainInvokeEvent
    expect(await invoke(IPC_CHANNELS.authGetSetupState, untrustedEvent)).toBe(false)
    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, untrustedEvent, {
      username: 'attacker', password: 'a secure password'
    })).toEqual({ ok: false, code: 'UNAVAILABLE' })
    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, trustedEvent, {
      username: 'admin', password: 'short'
    })).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' })
    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, trustedEvent, {
      username: 'x'.repeat(101), password: 'a secure password'
    })).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM configured_admin').get()).toEqual({ count: 0 })
  })

  it('never replaces an administrator already present in an existing database', async () => {
    await initializeAdminCredentials(database, {
      username: 'existing-admin', password: 'original secure password'
    })
    expect(await invoke(IPC_CHANNELS.authGetSetupState, trustedEvent)).toBe(false)
    expect(await invoke(IPC_CHANNELS.authCreateFirstAdmin, trustedEvent, {
      username: 'replacement-admin', password: 'replacement password'
    })).toEqual({ ok: false, code: 'ALREADY_CONFIGURED' })
    expect(await invoke(IPC_CHANNELS.authLogin, trustedEvent, {
      username: 'existing-admin', password: 'original secure password'
    })).toMatchObject({ ok: true })
  })
})
