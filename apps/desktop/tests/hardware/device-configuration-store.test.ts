import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeviceConfigurationStore, validateDeviceAddress, validateDeviceToken,
  type TokenProtection
} from '../../src/main/hardware/device-configuration-store'

const TOKEN = 'clinic-device-token-with-more-than-32-characters'
const protection: TokenProtection = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8')
}
const directories: string[] = []

function store(environment: NodeJS.ProcessEnv = {}): DeviceConfigurationStore {
  const directory = mkdtempSync(join(tmpdir(), 'dental-device-config-'))
  directories.push(directory)
  return new DeviceConfigurationStore(directory, protection, environment)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('device configuration', () => {
  it('distinguishes an unconfigured installation', () => {
    expect(store().resolve()).toEqual({
      configuration: null,
      summary: { address: null, tokenConfigured: false, source: 'none' }
    })
  })

  it('normalizes whitespace and trailing slash, and rejects malformed addresses', () => {
    expect(validateDeviceAddress('  http://192.168.1.105/  ')).toBe('http://192.168.1.105')
    expect(validateDeviceAddress('https://device.example:8443')).toBe('https://device.example:8443')
    for (const value of ['192.168.1.105', 'ftp://host', 'http://host/path',
      'http://user:pass@host', 'http://host/?token=x', 'http://host/#x', 'not a url']) {
      expect(() => validateDeviceAddress(value)).toThrow()
    }
  })

  it('validates token using the existing device-token rules', () => {
    expect(validateDeviceToken(`  ${TOKEN}  `)).toBe(TOKEN)
    for (const value of ['short', 'replace-with-a-random-shared-device-token',
      'contains spaces even though long enough for a device token']) {
      expect(() => validateDeviceToken(value)).toThrow()
    }
  })

  it('persists encrypted settings, preserves the token on an empty replacement, and wins over env', () => {
    const config = store({
      DENTAL_ESP32_BASE_URL: 'http://old-device', DENTAL_DEVICE_TOKEN: TOKEN
    })
    expect(config.resolve().summary.source).toBe('environment')
    config.save(' http://192.168.1.105/ ', TOKEN)
    const disk = readFileSync(config.filePath, 'utf8')
    expect(disk).not.toContain(TOKEN)
    expect(disk).not.toContain('old-device')
    const reopened = new DeviceConfigurationStore(dirname(config.filePath), protection)
    expect(reopened.resolve().configuration?.baseUrl).toBe('http://192.168.1.105')
    expect(config.save('http://192.168.1.106', '').deviceToken).toBe(TOKEN)
    expect(config.resolve().summary).toEqual({
      address: 'http://192.168.1.106', tokenConfigured: true, source: 'saved'
    })
  })

  it('fails closed if secure storage is unavailable or saved ciphertext is corrupt', () => {
    const config = store({ DENTAL_ESP32_BASE_URL: 'http://old-device' })
    const unavailable = new DeviceConfigurationStore(dirname(config.filePath), {
      ...protection, isEncryptionAvailable: () => false
    })
    expect(() => unavailable.save('http://new-device', TOKEN)).toThrow('SECURE_STORAGE_UNAVAILABLE')
    writeFileSync(config.filePath, '{"version":1,"address":"http://new-device","encryptedToken":"bad"}')
    expect(config.resolve().configuration).toBeNull()
    expect(config.resolve().summary.source).toBe('none')
  })

  it('keeps the existing inventory database untouched', () => {
    const config = store()
    const databasePath = join(dirname(config.filePath), 'data', 'inventory.db')
    mkdirSync(dirname(databasePath), { recursive: true })
    writeFileSync(databasePath, 'existing clinic data')
    config.save('http://device', TOKEN)
    expect(readFileSync(databasePath, 'utf8')).toBe('existing clinic data')
  })
})
