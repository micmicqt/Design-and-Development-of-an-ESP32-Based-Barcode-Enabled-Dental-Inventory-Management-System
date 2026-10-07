import { SerialPort } from 'serialport'
import type { DiscoveredInventoryDevice, SerialPortSummary } from '../../shared/ipc-contract'
import { parseDeviceIdentity, USB_IDENTIFY_REQUEST } from '../../shared/device-discovery-protocol'

const IDENTIFY_TIMEOUT_MS = 7000
const MAX_LINE_BYTES = 128

export class UsbDiscoveryError extends Error {
  constructor(readonly reason: 'PORT' | 'OPEN' | 'DISCONNECTED' | 'TIMEOUT' | 'INVALID') {
    super(reason)
  }
}

export async function listUsbSerialPorts(): Promise<SerialPortSummary[]> {
  const ports = await SerialPort.list()
  return ports.filter((port) => /^COM[1-9]\d{0,2}$/i.test(port.path))
    .map((port) => ({
      path: port.path.toUpperCase(),
      manufacturer: port.manufacturer ?? null,
      product: port.friendlyName ?? null
    })).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
}

export async function identifyUsbDevice(rawPath: string): Promise<DiscoveredInventoryDevice> {
  if (!/^COM[1-9]\d{0,2}$/i.test(rawPath)) throw new UsbDiscoveryError('PORT')
  const path = rawPath.toUpperCase()
  if (!(await listUsbSerialPorts()).some((port) => port.path === path)) {
    throw new UsbDiscoveryError('PORT')
  }
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false, rtscts: false })
  try {
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()))
  } catch {
    throw new UsbDiscoveryError('OPEN')
  }
  try {
    // Most USB-UART bridges expose these modem lines. Keep both inactive;
    // opening a serial port can still reset some ESP32 boards, so allow boot time.
    await new Promise<void>((resolve) => port.set({ dtr: false, rts: false }, () => resolve()))
    return await new Promise<DiscoveredInventoryDevice>((resolve, reject) => {
      let buffer = ''
      let invalidIdentity = false
      let finished = false
      const finish = (error: UsbDiscoveryError | null, device?: DiscoveredInventoryDevice): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearInterval(retry)
        port.off('data', onData)
        port.off('error', onError)
        port.off('close', onClose)
        if (error) reject(error)
        else if (device) resolve(device)
      }
      const onError = (): void => finish(new UsbDiscoveryError('DISCONNECTED'))
      const onClose = (): void => finish(new UsbDiscoveryError('DISCONNECTED'))
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 10) {
            const line = buffer.replace(/\r$/, '')
            buffer = ''
            if (!line.startsWith('@ATD:DEVICE:')) continue // USB debug log
            const device = parseDeviceIdentity(line)
            if (device) { finish(null, device); return }
            invalidIdentity = true
          } else if (byte >= 32 && byte <= 126 && buffer.length < MAX_LINE_BYTES) {
            buffer += String.fromCharCode(byte)
          } else if (byte === 13) {
            if (buffer.length < MAX_LINE_BYTES) buffer += '\r'
          } else {
            buffer = '' // binary boot output or overlong log line
          }
        }
      }
      const timer = setTimeout(() => finish(new UsbDiscoveryError(
        invalidIdentity ? 'INVALID' : 'TIMEOUT'
      )), IDENTIFY_TIMEOUT_MS)
      const retry = setInterval(() => {
        if (port.isOpen) port.write(USB_IDENTIFY_REQUEST, (error) => { if (error) onError() })
      }, 1800)
      port.on('data', onData)
      port.on('error', onError)
      port.on('close', onClose)
      port.write(USB_IDENTIFY_REQUEST, (error) => { if (error) onError() })
    })
  } finally {
    if (port.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()))
  }
}
