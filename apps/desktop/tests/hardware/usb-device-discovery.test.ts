// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const serialMock = vi.hoisted(() => ({
  ports: [{ path: 'COM5', manufacturer: 'USB Bridge', friendlyName: 'USB Serial Device' }],
  onWrite: null as null | ((port: EventEmitter, text: string) => void),
  openError: false
}))

vi.mock('serialport', () => ({
  SerialPort: class extends EventEmitter {
    static async list() { return serialMock.ports }
    isOpen = false
    constructor(readonly options: { path: string }) { super() }
    open(callback: (error?: Error) => void) {
      if (serialMock.openError) callback(new Error('busy'))
      else { this.isOpen = true; callback() }
    }
    set(_flags: unknown, callback: () => void) { callback() }
    write(text: string, callback: (error?: Error) => void) {
      serialMock.onWrite?.(this, text)
      callback()
    }
    close(callback: () => void) { this.isOpen = false; callback() }
  }
}))

import { identifyUsbDevice, listUsbSerialPorts, UsbDiscoveryError } from '../../src/main/hardware/usb-device-discovery'

afterEach(() => {
  vi.useRealTimers()
  serialMock.ports = [{ path: 'COM5', manufacturer: 'USB Bridge', friendlyName: 'USB Serial Device' }]
  serialMock.onWrite = null
  serialMock.openError = false
})

describe('USB COM Inventory Device identification', () => {
  it('lists Windows ports and handles an empty list', async () => {
    expect(await listUsbSerialPorts()).toEqual([{ path: 'COM5', manufacturer: 'USB Bridge', product: 'USB Serial Device' }])
    serialMock.ports = []
    expect(await listUsbSerialPorts()).toEqual([])
  })

  it('ignores debug lines, validates the explicit handshake, and extracts the IP', async () => {
    serialMock.onWrite = (port, request) => {
      expect(request).toBe('@ATD:IDENTIFY:1\n')
      port.emit('data', Buffer.from('WiFi connected\n@ATD:DEVICE:1:ATD-1234ABCD:1:192.168.1.105:0.1.0\n'))
    }
    expect(await identifyUsbDevice('COM5')).toMatchObject({
      deviceId: 'ATD-1234ABCD', ipAddress: '192.168.1.105', wifiConnected: true
    })
  })

  it('returns found-without-IP when Wi-Fi is disconnected', async () => {
    serialMock.onWrite = (port) => port.emit('data', Buffer.from('@ATD:DEVICE:1:ATD-1234ABCD:0:-:0.1.0\n'))
    expect(await identifyUsbDevice('COM5')).toMatchObject({ wifiConnected: false, ipAddress: null })
  })

  it('rejects an absent port and an access-denied port', async () => {
    await expect(identifyUsbDevice('COM6')).rejects.toMatchObject({ reason: 'PORT' })
    serialMock.openError = true
    await expect(identifyUsbDevice('COM5')).rejects.toMatchObject({ reason: 'OPEN' })
  })

  it('rejects a physically disconnected port', async () => {
    serialMock.onWrite = (port) => { port.emit('close') }
    await expect(identifyUsbDevice('COM5')).rejects.toMatchObject({ reason: 'DISCONNECTED' })
  })

  it('rejects malformed identity instead of treating it as an ESP32', async () => {
    vi.useFakeTimers()
    serialMock.onWrite = (port) => port.emit('data', Buffer.from('@ATD:DEVICE:1:bad\n'))
    const pending = identifyUsbDevice('COM5')
    const assertion = expect(pending).rejects.toEqual(new UsbDiscoveryError('INVALID'))
    await vi.advanceTimersByTimeAsync(7000)
    await assertion
  })

  it('times out on a random serial device that only emits debug text', async () => {
    vi.useFakeTimers()
    serialMock.onWrite = (port) => port.emit('data', Buffer.from('Other device ready\n'))
    const assertion = expect(identifyUsbDevice('COM5')).rejects
      .toEqual(new UsbDiscoveryError('TIMEOUT'))
    await vi.advanceTimersByTimeAsync(7000)
    await assertion
  })
})
