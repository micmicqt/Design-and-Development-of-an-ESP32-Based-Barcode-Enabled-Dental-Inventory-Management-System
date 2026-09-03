import {
  ESP32_DEVICE_ID,
  type Esp32HardwareMode,
  type Esp32HealthResponse,
  type Esp32StatusResponse,
  type HardwareStatusGateway
} from './hardware-gateway'

const DEFAULT_REQUEST_TIMEOUT_MS = 2_500
const HARDWARE_MODES: readonly Esp32HardwareMode[] = [
  'idle',
  'restock',
  'checkout',
  'busy'
]

export interface HardwareHttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type HardwareFetch = (
  url: string,
  options: {
    method: 'GET'
    headers: Readonly<Record<string, string>>
    signal: AbortSignal
  }
) => Promise<HardwareHttpResponse>

export type HardwareGatewayErrorCode = 'UNAVAILABLE' | 'INVALID_RESPONSE'

export class HardwareGatewayError extends Error {
  readonly code: HardwareGatewayErrorCode

  constructor(code: HardwareGatewayErrorCode, message: string) {
    super(message)
    this.name = 'HardwareGatewayError'
    this.code = code
  }
}

export interface Esp32HttpGatewayOptions {
  baseUrl: string
  requestTimeoutMs?: number
  fetcher?: HardwareFetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim()
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 base URL is invalid.')
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 base URL is invalid.')
  }

  return normalized.replace(/\/+$/, '')
}

function validateHealthResponse(value: unknown): Esp32HealthResponse {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    value.device !== ESP32_DEVICE_ID ||
    value.phase !== 4
  ) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The ESP32 health response is invalid.')
  }

  return {
    status: 'ok',
    device: ESP32_DEVICE_ID,
    phase: 4
  }
}

function validateStatusResponse(value: unknown): Esp32StatusResponse {
  if (
    !isRecord(value) ||
    value.device !== ESP32_DEVICE_ID ||
    typeof value.online !== 'boolean' ||
    typeof value.mode !== 'string' ||
    !HARDWARE_MODES.includes(value.mode as Esp32HardwareMode) ||
    typeof value.rtc !== 'boolean' ||
    typeof value.sd !== 'boolean'
  ) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The ESP32 status response is invalid.')
  }

  return {
    device: ESP32_DEVICE_ID,
    online: value.online,
    mode: value.mode as Esp32HardwareMode,
    rtc: value.rtc,
    sd: value.sd
  }
}

const defaultFetch: HardwareFetch = (url, options) => fetch(url, options)

export class Esp32HttpGateway implements HardwareStatusGateway {
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  private readonly fetcher: HardwareFetch

  constructor(options: Esp32HttpGatewayOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 request timeout is invalid.')
    }
    this.fetcher = options.fetcher ?? defaultFetch
  }

  async healthCheck(): Promise<Esp32HealthResponse> {
    return validateHealthResponse(await this.request('/health'))
  }

  async getStatus(): Promise<Esp32StatusResponse> {
    return validateStatusResponse(await this.request('/status'))
  }

  private async request(path: '/health' | '/status'): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) {
        throw new HardwareGatewayError(
          'UNAVAILABLE',
          `The ESP32 returned HTTP ${response.status}.`
        )
      }
      return await response.json()
    } catch (error: unknown) {
      if (error instanceof HardwareGatewayError) throw error
      throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 is unavailable.')
    } finally {
      clearTimeout(timeout)
    }
  }
}
