import { describe, expect, it } from 'vitest'
import { parseDeviceIdentity } from '../../src/shared/device-discovery-protocol'

describe('non-secret Inventory Device discovery identity', () => {
  it('parses Wi-Fi address and stable short ID', () => {
    expect(parseDeviceIdentity('@ATD:DEVICE:1:ATD-3A7F21AB:1:192.168.1.105:0.1.0\r\n'))
      .toEqual({ deviceId: 'ATD-3A7F21AB', name: 'Any Time Dental Inventory Device',
        firmware: '0.1.0', wifiConnected: true, ipAddress: '192.168.1.105' })
  })

  it('reports disconnected Wi-Fi without inventing an address', () => {
    expect(parseDeviceIdentity('@ATD:DEVICE:1:ATD-3A7F21AB:0:-:0.1.0'))
      .toMatchObject({ wifiConnected: false, ipAddress: null })
    expect(parseDeviceIdentity('@ATD:DEVICE:1:ATD-3A7F21AB:1:0.0.0.0:0.1.0')).toBeNull()
  })

  it('rejects debug text, arbitrary devices, malformed fields and secret additions', () => {
    for (const frame of [
      'WiFi connected', '@ATD:DEVICE:1:ATD-3A7F21AB:1:192.168.1.105:0.1.0:token',
      '@ATD:DEVICE:1:ATD-3A7F21AB:1:999.1.1.1:0.1.0',
      '@ATD:DEVICE:1:ATD-3A7F21AB:0:192.168.1.105:0.1.0',
      '@ATD:DEVICE:1:NOT-OURS:1:192.168.1.105:0.1.0',
      '@ATD:DEVICE:1:ATD-3A7F21AB:1:192.168.1.105:0.1.0'.repeat(3)
    ]) expect(parseDeviceIdentity(frame)).toBeNull()
  })
})
