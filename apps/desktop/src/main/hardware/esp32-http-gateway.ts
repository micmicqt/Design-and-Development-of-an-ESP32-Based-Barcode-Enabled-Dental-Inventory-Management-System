import {
  ESP32_DEVICE_ID,
  type Esp32HardwareMode,
  type Esp32HealthResponse,
  type Esp32StatusResponse,
  type HardwareTransactionEventGateway,
  isValidHardwareTransactionEventId
} from './hardware-gateway'
import type {
  HardwareTransactionEvent,
  HardwareTransactionMode,
  HardwareTransactionResult,
  StockStatus
} from '../../shared/ipc-contract'

const DEFAULT_REQUEST_TIMEOUT_MS = 2_500
const HARDWARE_MODES: readonly Esp32HardwareMode[] = [
  'idle',
  'restock',
  'checkout',
  'busy'
]
const TRANSACTION_MODES: readonly HardwareTransactionMode[] = ['restock', 'checkout']
const TRANSACTION_EVENT_KEYS = ['barcode', 'eventId', 'mode', 'timestamp'] as const
const ACKNOWLEDGEMENT_KEYS = ['acknowledged', 'eventId'] as const
const RESULT_ACCEPTANCE_KEYS = ['accepted', 'eventId'] as const
const STOCK_STATUSES: readonly StockStatus[] = ['HIGH', 'LOW', 'EMPTY']
const NO_CONTENT = Symbol('HTTP 204')

export interface HardwareHttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type HardwareFetch = (
  url: string,
  options: {
    method: 'GET' | 'POST'
    headers: Readonly<Record<string, string>>
    signal: AbortSignal
    body?: string
  }
) => Promise<HardwareHttpResponse>

export type HardwareGatewayErrorCode = 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'REJECTED'

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

function hasExactlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expected[index])
  )
}

function isValidBarcode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim().length > 0 &&
    /^[\x20-\x7E]+$/.test(value) &&
    !value.includes(',')
  )
}

function isValidRtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return false

  const values = match.slice(1).map(Number)
  const [year, month, day, hour, minute, second] = values
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 2000 ||
    year > 2099 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false
  }

  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  )
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

function validateTransactionEvent(value: unknown): HardwareTransactionEvent {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, TRANSACTION_EVENT_KEYS) ||
    !isValidHardwareTransactionEventId(value.eventId) ||
    typeof value.mode !== 'string' ||
    !TRANSACTION_MODES.includes(value.mode as HardwareTransactionMode) ||
    !isValidBarcode(value.barcode) ||
    !isValidRtcTimestamp(value.timestamp)
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 transaction event response is invalid.'
    )
  }

  return {
    eventId: value.eventId,
    mode: value.mode as HardwareTransactionMode,
    barcode: value.barcode,
    timestamp: value.timestamp
  }
}

function validateAcknowledgement(value: unknown, expectedEventId: string): void {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ACKNOWLEDGEMENT_KEYS) ||
    value.acknowledged !== true ||
    value.eventId !== expectedEventId
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 transaction acknowledgement response is invalid.'
    )
  }
}

function validateResult(result: HardwareTransactionResult): void {
  if (
    !isValidHardwareTransactionEventId(result.eventId) ||
    result.result !== 'success' ||
    !TRANSACTION_MODES.includes(result.mode) ||
    !Number.isSafeInteger(result.quantity) ||
    result.quantity <= 0 ||
    result.quantity > 10_000 ||
    !Number.isSafeInteger(result.resultingStock) ||
    result.resultingStock < 0 ||
    !STOCK_STATUSES.includes(result.stockStatus)
  ) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The transaction result is invalid.')
  }
}

function validateResultAcceptance(value: unknown, expectedEventId: string): void {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, RESULT_ACCEPTANCE_KEYS) ||
    value.accepted !== true ||
    value.eventId !== expectedEventId
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 transaction result response is invalid.'
    )
  }
}

const defaultFetch: HardwareFetch = (url, options) => fetch(url, options)

export class Esp32HttpGateway implements HardwareTransactionEventGateway {
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

  async getNextTransactionEvent(): Promise<HardwareTransactionEvent | null> {
    const response = await this.request('/events/next', { allowNoContent: true })
    return response === NO_CONTENT ? null : validateTransactionEvent(response)
  }

  async deliverTransactionResult(result: HardwareTransactionResult): Promise<void> {
    validateResult(result)
    const response = await this.request('/events/result', {
      method: 'POST',
      body: JSON.stringify(result)
    })
    validateResultAcceptance(response, result.eventId)
  }

  async acknowledgeTransactionEvent(eventId: string): Promise<void> {
    if (!isValidHardwareTransactionEventId(eventId)) {
      throw new HardwareGatewayError(
        'INVALID_RESPONSE',
        'The transaction event ID is invalid.'
      )
    }

    const response = await this.request('/events/ack', {
      method: 'POST',
      body: JSON.stringify({ eventId })
    })
    validateAcknowledgement(response, eventId)
  }

  private async request(
    path: '/health' | '/status' | '/events/next' | '/events/result' | '/events/ack',
    options: {
      method?: 'GET' | 'POST'
      body?: string
      allowNoContent?: boolean
    } = {}
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const method = options.method ?? 'GET'

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers:
          method === 'POST'
            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
            : { Accept: 'application/json' },
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: options.body })
      })
      if (options.allowNoContent === true && response.status === 204) return NO_CONTENT
      if (!response.ok) {
        if (method === 'POST' && response.status >= 400 && response.status < 500) {
          throw new HardwareGatewayError(
            'REJECTED',
            path === '/events/result'
              ? 'The ESP32 rejected the transaction result.'
              : 'The ESP32 rejected the transaction acknowledgement.'
          )
        }
        throw new HardwareGatewayError(
          'UNAVAILABLE',
          `The ESP32 returned HTTP ${response.status}.`
        )
      }

      if (path.startsWith('/events/') && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected event response status.'
        )
      }

      try {
        return await response.json()
      } catch {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned malformed JSON.'
        )
      }
    } catch (error: unknown) {
      if (error instanceof HardwareGatewayError) throw error
      throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 is unavailable.')
    } finally {
      clearTimeout(timeout)
    }
  }
}
