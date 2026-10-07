// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import { createBluetoothSelectionController } from '../../src/main/hardware/bluetooth-selection'

describe('Electron Inventory Device BLE chooser', () => {
  it('filters unrelated devices and permits explicit choice among compatible devices', () => {
    const session = createAuthSessionController()
    session.signIn('admin')
    const webContents = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn> }
    webContents.send = vi.fn()
    const window = new EventEmitter() as EventEmitter & { webContents: typeof webContents }
    window.webContents = webContents
    const controller = createBluetoothSelectionController(session)
    controller.attach(window as unknown as BrowserWindow)
    const callback = vi.fn()
    webContents.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [
      { deviceId: 'other', deviceName: 'Headphones' },
      { deviceId: 'one', deviceName: 'AnyTimeDental-Inventory' },
      { deviceId: 'two', deviceName: 'AnyTimeDental-Inventory 2' }
    ], callback)
    expect(webContents.send).toHaveBeenCalledWith('device-setup:bluetooth-candidates', [
      { id: 'one', name: 'AnyTimeDental-Inventory' },
      { id: 'two', name: 'AnyTimeDental-Inventory 2' }
    ])
    expect(controller.select('other')).toBe(false)
    expect(controller.select('two')).toBe(true)
    expect(callback).toHaveBeenCalledExactlyOnceWith('two')
  })

  it('cancels unauthenticated requests', () => {
    const session = createAuthSessionController()
    const webContents = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn> }
    webContents.send = vi.fn()
    const window = new EventEmitter() as EventEmitter & { webContents: typeof webContents }
    window.webContents = webContents
    createBluetoothSelectionController(session).attach(window as unknown as BrowserWindow)
    const callback = vi.fn()
    webContents.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [
      { deviceId: 'one', deviceName: 'AnyTimeDental-Inventory' }
    ], callback)
    expect(callback).toHaveBeenCalledWith('')
    expect(webContents.send).not.toHaveBeenCalled()
  })
})
