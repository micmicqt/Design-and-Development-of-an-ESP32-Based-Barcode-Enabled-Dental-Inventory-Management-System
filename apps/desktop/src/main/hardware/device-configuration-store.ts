import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveEsp32BaseUrl, resolveEsp32DeviceToken } from './hardware-configuration'

export interface DeviceConfiguration {
  baseUrl: string
  deviceToken: string
}

export interface DeviceConfigurationSummary {
  address: string | null
  tokenConfigured: boolean
  source: 'saved' | 'environment' | 'none'
}

export interface TokenProtection {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class DeviceConfigurationError extends Error {
  constructor(readonly code: 'INVALID_ADDRESS' | 'INVALID_TOKEN' | 'SECURE_STORAGE_UNAVAILABLE' | 'STORAGE_FAILURE') {
    super(code)
    this.name = 'DeviceConfigurationError'
  }
}

export function validateDeviceAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new DeviceConfigurationError('INVALID_ADDRESS')
  }
  const address = resolveEsp32BaseUrl({ DENTAL_ESP32_BASE_URL: value })
  if (address === null) throw new DeviceConfigurationError('INVALID_ADDRESS')
  const parsed = new URL(address)
  if (parsed.pathname !== '/' || parsed.hostname.length === 0) {
    throw new DeviceConfigurationError('INVALID_ADDRESS')
  }
  return parsed.origin
}

export function validateDeviceToken(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) {
    throw new DeviceConfigurationError('INVALID_TOKEN')
  }
  const token = resolveEsp32DeviceToken({ DENTAL_DEVICE_TOKEN: value })
  if (token === null) throw new DeviceConfigurationError('INVALID_TOKEN')
  return token
}

interface StoredDeviceConfiguration {
  version: 1
  address: string
  encryptedToken: string
}

export class DeviceConfigurationStore {
  readonly filePath: string

  constructor(
    userDataPath: string,
    private readonly protection: TokenProtection,
    private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env
  ) {
    this.filePath = join(userDataPath, 'device-configuration.json')
  }

  private readSaved(): DeviceConfiguration | null {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new DeviceConfigurationError('STORAGE_FAILURE')
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid')
      const record = parsed as Partial<StoredDeviceConfiguration>
      if (record.version !== 1 || typeof record.encryptedToken !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encryptedToken)) throw new Error('invalid')
      const address = validateDeviceAddress(record.address)
      if (!this.protection.isEncryptionAvailable()) {
        throw new DeviceConfigurationError('SECURE_STORAGE_UNAVAILABLE')
      }
      const token = validateDeviceToken(
        this.protection.decryptString(Buffer.from(record.encryptedToken, 'base64'))
      )
      return { baseUrl: address, deviceToken: token }
    } catch (error: unknown) {
      if (error instanceof DeviceConfigurationError &&
          error.code === 'SECURE_STORAGE_UNAVAILABLE') throw error
      // A corrupt or undecryptable saved secret must never activate stale env settings.
      throw new DeviceConfigurationError('STORAGE_FAILURE')
    }
  }

  resolve(): { configuration: { baseUrl: string; deviceToken: string | null } | null; summary: DeviceConfigurationSummary } {
    let saved: DeviceConfiguration | null
    try {
      saved = this.readSaved()
    } catch {
      return { configuration: null, summary: { address: null, tokenConfigured: false, source: 'none' } }
    }
    if (saved !== null) {
      return { configuration: saved, summary: {
        address: saved.baseUrl, tokenConfigured: true, source: 'saved'
      } }
    }
    const baseUrl = resolveEsp32BaseUrl(this.environment)
    const deviceToken = resolveEsp32DeviceToken(this.environment)
    return {
      configuration: baseUrl === null ? null : { baseUrl, deviceToken },
      summary: baseUrl === null
        ? { address: null, tokenConfigured: false, source: 'none' }
        : { address: baseUrl, tokenConfigured: deviceToken !== null, source: 'environment' }
    }
  }

  save(addressInput: unknown, tokenInput: unknown): DeviceConfiguration {
    const baseUrl = validateDeviceAddress(addressInput)
    const token = typeof tokenInput === 'string' && tokenInput.length === 0
      ? this.readSaved()?.deviceToken
      : validateDeviceToken(tokenInput)
    if (token === undefined) throw new DeviceConfigurationError('INVALID_TOKEN')
    if (!this.protection.isEncryptionAvailable()) {
      throw new DeviceConfigurationError('SECURE_STORAGE_UNAVAILABLE')
    }
    const encryptedToken = this.protection.encryptString(token).toString('base64')
    const record: StoredDeviceConfiguration = { version: 1, address: baseUrl, encryptedToken }
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(temporaryPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporaryPath, this.filePath)
    } catch {
      rmSync(temporaryPath, { force: true })
      throw new DeviceConfigurationError('STORAGE_FAILURE')
    }
    return { baseUrl, deviceToken: token }
  }
}
