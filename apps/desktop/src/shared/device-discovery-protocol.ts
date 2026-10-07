import type { DiscoveredInventoryDevice } from './ipc-contract'

export const DENTAL_BLE_SERVICE_UUID = '4e6a1000-8eab-4c73-9c6e-1f749d86a0d1'
export const DENTAL_BLE_INFO_UUID = '4e6a1001-8eab-4c73-9c6e-1f749d86a0d1'
export const USB_IDENTIFY_REQUEST = '@ATD:IDENTIFY:1\n'

function validIpv4(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4 && octets.every((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
  ) && value !== '0.0.0.0'
}

/** The same bounded, non-secret identity frame is used by USB and BLE. */
export function parseDeviceIdentity(raw: string): DiscoveredInventoryDevice | null {
  if (raw.length > 112 || !raw.startsWith('@ATD:DEVICE:1:')) return null
  const fields = raw.trimEnd().split(':')
  if (fields.length !== 7) return null
  const [prefix, kind, version, deviceId, connectedFlag, ip, firmware] = fields
  if (prefix !== '@ATD' || kind !== 'DEVICE' || version !== '1' ||
      deviceId === undefined || connectedFlag === undefined || ip === undefined ||
      firmware === undefined || !/^ATD-[0-9A-F]{8}$/.test(deviceId) ||
      !/^(0|1)$/.test(connectedFlag) || !/^\d+\.\d+\.\d+$/.test(firmware)) return null
  const wifiConnected = connectedFlag === '1'
  if ((wifiConnected && !validIpv4(ip)) || (!wifiConnected && ip !== '-')) {
    return null
  }
  return {
    deviceId,
    name: 'Any Time Dental Inventory Device',
    firmware,
    wifiConnected,
    ipAddress: wifiConnected ? ip : null
  }
}
