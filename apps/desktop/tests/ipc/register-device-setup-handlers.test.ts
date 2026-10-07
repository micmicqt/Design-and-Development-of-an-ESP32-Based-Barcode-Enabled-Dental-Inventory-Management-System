// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import { DeviceConfigurationStore } from '../../src/main/hardware/device-configuration-store'
import { HardwareGatewayError } from '../../src/main/hardware/esp32-http-gateway'
import { registerDeviceSetupIpcHandlers } from '../../src/main/ipc/register-device-setup-handlers'
import { IPC_CHANNELS } from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
  return { handlers, handle: vi.fn((key: string, handler: (event: unknown, arg?: unknown) => unknown) => {
    handlers.set(key, handler)
  }), removeHandler: vi.fn((key: string) => handlers.delete(key)) }
})
vi.mock('electron', () => ({ ipcMain: {
  handle: electronMock.handle, removeHandler: electronMock.removeHandler
} }))

const TOKEN = 'clinic-device-token-with-more-than-32-characters'
const directories: string[] = []
afterEach(() => {
  electronMock.handlers.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(canActivate?: () => boolean, discovery?: {
  listSerialPorts?: () => Promise<{ path: string; manufacturer: string | null; product: string | null }[]>
  identifyUsb?: (port: string) => Promise<{
    deviceId: string; name: 'Any Time Dental Inventory Device'; firmware: string;
    wifiConnected: boolean; ipAddress: string | null
  }>
  selectBluetooth?: (id: unknown) => boolean
}) {
  const directory = mkdtempSync(join(tmpdir(), 'dental-device-ipc-'))
  directories.push(directory)
  const store = new DeviceConfigurationStore(directory, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString()
  }, {})
  const authSession = createAuthSessionController()
  authSession.signIn('admin')
  const sender = { isDestroyed: () => false }
  const frame = {}
  const window = { isDestroyed: () => false, webContents: { ...sender, mainFrame: frame } }
  const event = { sender: window.webContents, senderFrame: frame } as IpcMainInvokeEvent
  const activate = vi.fn()
  const healthCheck = vi.fn().mockResolvedValue({ status: 'ok', device: 'dental-inventory-esp32', phase: 4 })
  const createGateway = vi.fn(() => ({ healthCheck }))
  const dispose = registerDeviceSetupIpcHandlers({
    store, authSession, getMainWindow: () => window as unknown as BrowserWindow,
    activate, createGateway, canActivate, ...discovery
  })
  const call = (channel: string, arg?: unknown): Promise<unknown> =>
    Promise.resolve(electronMock.handlers.get(channel)?.(event, arg))
  return { store, call, activate, healthCheck, createGateway, dispose, authSession, event }
}

describe('trusted device setup IPC', () => {
  it('lists ports and identifies only a selected COM device without exposing secrets', async () => {
    const listSerialPorts = vi.fn().mockResolvedValue([{ path: 'COM5', manufacturer: 'USB', product: null }])
    const identifyUsb = vi.fn().mockResolvedValue({
      deviceId: 'ATD-1234ABCD', name: 'Any Time Dental Inventory Device',
      firmware: '0.1.0', wifiConnected: true, ipAddress: '192.168.1.105'
    })
    const { call } = setup(undefined, { listSerialPorts, identifyUsb })
    await expect(call(IPC_CHANNELS.deviceSetupListSerialPorts)).resolves.toMatchObject({
      ok: true, value: [{ path: 'COM5' }]
    })
    await expect(call(IPC_CHANNELS.deviceSetupIdentifyUsb, 'COM5')).resolves.toMatchObject({
      ok: true, value: { deviceId: 'ATD-1234ABCD', ipAddress: '192.168.1.105' }
    })
    expect(identifyUsb).toHaveBeenCalledWith('COM5')
    expect(JSON.stringify(await call(IPC_CHANNELS.deviceSetupIdentifyUsb, 'COM5')))
      .not.toContain(TOKEN)
    await expect(call(IPC_CHANNELS.deviceSetupIdentifyUsb, 'COM5/../')).resolves
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('requires authenticated trusted IPC for discovery and BLE selection', async () => {
    const listSerialPorts = vi.fn().mockResolvedValue([])
    const selectBluetooth = vi.fn().mockReturnValue(true)
    const { call, authSession } = setup(undefined, { listSerialPorts, selectBluetooth })
    expect(await call(IPC_CHANNELS.deviceSetupSelectBluetooth, 'device-id')).toBe(true)
    authSession.signOut()
    await expect(call(IPC_CHANNELS.deviceSetupListSerialPorts)).resolves
      .toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(await call(IPC_CHANNELS.deviceSetupSelectBluetooth, 'device-id')).toBe(false)
    expect(listSerialPorts).not.toHaveBeenCalled()
    expect(selectBluetooth).toHaveBeenCalledTimes(1)
  })
  it('starts unconfigured and never exposes token on read', async () => {
    const { call } = setup()
    await expect(call(IPC_CHANNELS.deviceSetupGet)).resolves.toEqual({ ok: true, value: {
      address: null, tokenConfigured: false, source: 'none'
    } })
  })

  it('tests the currently entered address using only read-only health', async () => {
    const { call, createGateway, healthCheck } = setup()
    await expect(call(IPC_CHANNELS.deviceSetupTest, ' http://192.168.1.106/ '))
      .resolves.toEqual({ ok: true, value: { status: 'CONNECTED' } })
    expect(createGateway).toHaveBeenCalledWith('http://192.168.1.106')
    expect(healthCheck).toHaveBeenCalledOnce()
  })

  it('distinguishes network failure and timeout without leaking raw diagnostics', async () => {
    const { call, healthCheck } = setup()
    healthCheck.mockRejectedValueOnce(new HardwareGatewayError('UNAVAILABLE', 'secret URL', 'NETWORK_FAILURE'))
    await expect(call(IPC_CHANNELS.deviceSetupTest, 'http://device'))
      .resolves.toEqual({ ok: true, value: { status: 'UNAVAILABLE' } })
    healthCheck.mockRejectedValueOnce(new HardwareGatewayError('UNAVAILABLE', 'secret URL', 'REQUEST_TIMEOUT'))
    await expect(call(IPC_CHANNELS.deviceSetupTest, 'http://device'))
      .resolves.toEqual({ ok: true, value: { status: 'TIMEOUT' } })
  })

  it('saves and activates a new gateway without returning the token', async () => {
    const { call, activate, store } = setup()
    const result = await call(IPC_CHANNELS.deviceSetupSave, {
      address: ' http://device/ ', token: TOKEN
    })
    expect(result).toEqual({ ok: true, value: {
      address: 'http://device', tokenConfigured: true, source: 'saved'
    } })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(activate).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'http://device', deviceToken: TOKEN })
    expect(store.resolve().configuration?.deviceToken).toBe(TOKEN)
  })

  it('rejects untrusted, unauthenticated, and malformed requests', async () => {
    const { call, authSession, event, activate } = setup()
    await expect(call(IPC_CHANNELS.deviceSetupSave, { address: 'ftp://x', token: TOKEN }))
      .resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(call(IPC_CHANNELS.deviceSetupSave, { address: 'http://x', token: 'short' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(activate).not.toHaveBeenCalled()
    authSession.signOut()
    await expect(call(IPC_CHANNELS.deviceSetupGet))
      .resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    const untrusted = { ...event, senderFrame: {} }
    expect(electronMock.handlers.get(IPC_CHANNELS.deviceSetupGet)?.(untrusted))
      .toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
  })

  it('refuses to switch devices during a pending stock or sync operation', async () => {
    const { call, activate, store } = setup(() => false)
    await expect(call(IPC_CHANNELS.deviceSetupSave, { address: 'http://new-device', token: TOKEN }))
      .resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(activate).not.toHaveBeenCalled()
    expect(store.resolve().configuration).toBeNull()
  })
})
