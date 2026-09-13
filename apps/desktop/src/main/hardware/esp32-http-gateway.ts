import {
  type DesktopHardwareGateway,
  ESP32_DEVICE_ID,
  type Esp32HardwareMode,
  type Esp32HealthResponse,
  type Esp32RtcReason,
  type Esp32RtcState,
  type Esp32StatusResponse,
  OFFLINE_CACHE_GENERATION_PATTERN,
  type OfflineEventAcknowledgement,
  type OfflineInventoryCacheInstallResult,
  type OfflineInventoryCacheProduct,
  type OfflineInventoryCacheSnapshot,
  type RtcSynchronizationRequest,
  type RtcSynchronizationResult,
  isValidHardwareTransactionEventId
} from './hardware-gateway'
import {
  INVENTORY_CATEGORIES,
  STOCK_STATUSES,
  type HardwareTransactionEvent,
  type HardwareTransactionMode,
  type HardwareTransactionResult,
  type OfflinePendingAction,
  type OfflinePendingEvent,
  type StockStatus
} from '../../shared/ipc-contract'

const DEFAULT_REQUEST_TIMEOUT_MS = 2_500
const REGISTRATION_CAPTURE_TIMEOUT_MS = 13_000
const REGISTRATION_CAPTURE_POLL_INTERVAL_MS = 125
// Offline acknowledgement advances a CRC-protected MicroSD journal at the
// kiosk's conservative 1 MHz SPI speed. It is intentionally allowed longer
// than lightweight status/event reads, while remaining bounded.
const DEFAULT_OFFLINE_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000
const DEVICE_TOKEN_HEADER = 'X-Device-Token'
const DEVICE_TOKEN_PLACEHOLDER = 'replace-with-a-random-shared-device-token'
const RTC_STATES: readonly Esp32RtcState[] = ['unavailable', 'needs_sync', 'ready']
const RTC_REASONS: readonly Esp32RtcReason[] = [
  'none',
  'communication_failure',
  'lost_power',
  'invalid_time',
  'verification_failed'
]
const HARDWARE_MODES: readonly Esp32HardwareMode[] = [
  'idle',
  'restock',
  'checkout',
  'busy'
]
const TRANSACTION_MODES: readonly HardwareTransactionMode[] = ['restock', 'checkout']
const TRANSACTION_EVENT_KEYS = ['barcode', 'eventId', 'mode', 'timestamp'] as const
const OFFLINE_PENDING_EVENT_KEYS = [
  'eventId',
  'timestamp',
  'productId',
  'barcode',
  'action',
  'delta',
  'resultingStock',
  'stockStatus',
  'cacheGeneration'
] as const
const OFFLINE_PENDING_ACTIONS: readonly OfflinePendingAction[] = ['RESTOCK', 'CHECKOUT']
const OFFLINE_EVENT_ID_PATTERN = /^off-[0-9A-F]{12}-[0-9A-F]{16}$/
const ACKNOWLEDGEMENT_KEYS = ['acknowledged', 'eventId'] as const
const OFFLINE_ACKNOWLEDGEMENT_KEYS = [
  'acknowledged',
  'eventId',
  'pendingSyncItems',
  'alreadyAcknowledged'
] as const
const RESULT_ACCEPTANCE_KEYS = ['accepted', 'eventId'] as const
const DESKTOP_HEARTBEAT_KEYS = ['desktopOnline'] as const
const RTC_SYNC_RESPONSE_KEYS = ['synchronized', 'rtcState', 'alreadyReady'] as const
const BARCODE_CAPTURE_START_KEYS = ['started'] as const
const BARCODE_CAPTURE_RESULT_KEYS = ['captured', 'barcode'] as const
const CACHE_RESPONSE_KEYS = [
  'accepted',
  'operation',
  'generation',
  'receivedItems',
  'alreadyCurrent'
] as const
const CACHE_SNAPSHOT_KEYS = ['generation', 'products'] as const
const CACHE_PRODUCT_KEYS = [
  'id',
  'barcode',
  'name',
  'category',
  'currentStock',
  'lowStockThreshold',
  'status'
] as const
const MAX_OFFLINE_CACHE_ITEMS = 10_000
const NO_CONTENT = Symbol('HTTP 204')

type CacheOperation = 'begin' | 'item' | 'commit'

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
export type HardwareGatewayDiagnosticCode =
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'DEVICE_TOKEN_UNCONFIGURED'
  | 'invalid_request'
  | 'no_pending_event'
  | 'event_id_mismatch'
  | 'pending_journal_unavailable'
  | 'pending_journal_invalid'
  | 'unauthorized'
  | 'authentication_unconfigured'
  | 'invalid_timestamp'
  | 'rtc_unavailable'
  | 'verification_failed'
  | 'scanner_busy'
  | 'scanner_acknowledgement_timeout'
  | 'barcode_timeout'
  | 'invalid_barcode'

export class HardwareGatewayError extends Error {
  readonly code: HardwareGatewayErrorCode
  readonly diagnosticCode?: HardwareGatewayDiagnosticCode

  constructor(
    code: HardwareGatewayErrorCode,
    message: string,
    diagnosticCode?: HardwareGatewayDiagnosticCode
  ) {
    super(message)
    this.name = 'HardwareGatewayError'
    this.code = code
    this.diagnosticCode = diagnosticCode
  }
}

export interface Esp32HttpGatewayOptions {
  baseUrl: string
  /** Local backend-only shared secret; never exposed through preload or renderer IPC. */
  deviceToken?: string | null
  requestTimeoutMs?: number
  offlineAcknowledgementTimeoutMs?: number
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

const SAFE_FIRMWARE_DIAGNOSTIC_CODES = new Set<HardwareGatewayDiagnosticCode>([
  'invalid_request',
  'no_pending_event',
  'event_id_mismatch',
  'pending_journal_unavailable',
  'pending_journal_invalid',
  'unauthorized',
  'authentication_unconfigured',
  'invalid_timestamp',
  'rtc_unavailable',
  'verification_failed',
  'scanner_busy',
  'scanner_acknowledgement_timeout',
  'barcode_timeout',
  'invalid_barcode'
])

async function readSafeFirmwareDiagnostic(
  response: HardwareHttpResponse
): Promise<HardwareGatewayDiagnosticCode | undefined> {
  try {
    const payload = await response.json()
    if (
      isRecord(payload) &&
      typeof payload.error === 'string' &&
      SAFE_FIRMWARE_DIAGNOSTIC_CODES.has(payload.error as HardwareGatewayDiagnosticCode)
    ) {
      return payload.error as HardwareGatewayDiagnosticCode
    }
  } catch {
    // A malformed error response is still handled as a failed request. Never
    // expose its raw body across the renderer boundary.
  }
  return undefined
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

function validateBarcodeCaptureStart(value: unknown): void {
  if (!isRecord(value) || !hasExactlyKeys(value, BARCODE_CAPTURE_START_KEYS) || value.started !== true) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 barcode capture response is invalid.'
    )
  }
}

function validateBarcodeCaptureResult(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, BARCODE_CAPTURE_RESULT_KEYS) ||
    value.captured !== true ||
    !isValidBarcode(value.barcode)
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 barcode capture result is invalid.'
    )
  }
  return value.barcode
}

function isValidOfflineEventId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    OFFLINE_EVENT_ID_PATTERN.test(value) &&
    value.slice(-16) !== '0000000000000000'
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
  const hasAnyCacheMetadata =
    isRecord(value) &&
    ('offlineCacheAvailable' in value ||
      'offlineCacheGeneration' in value ||
      'offlineCacheItems' in value)
  const hasValidCacheMetadata =
    !hasAnyCacheMetadata ||
    (isRecord(value) &&
      typeof value.offlineCacheAvailable === 'boolean' &&
      (value.offlineCacheGeneration === null ||
        (typeof value.offlineCacheGeneration === 'string' &&
          OFFLINE_CACHE_GENERATION_PATTERN.test(value.offlineCacheGeneration))) &&
      Number.isSafeInteger(value.offlineCacheItems) &&
      (value.offlineCacheItems as number) >= 0 &&
      (value.offlineCacheItems as number) <= MAX_OFFLINE_CACHE_ITEMS &&
      (value.offlineCacheAvailable
        ? typeof value.offlineCacheGeneration === 'string'
        : value.offlineCacheGeneration === null && value.offlineCacheItems === 0))
  const hasAnyOfflineJournalMetadata =
    isRecord(value) && ('pendingSyncItems' in value || 'offlineReady' in value)
  const hasValidOfflineJournalMetadata =
    !hasAnyOfflineJournalMetadata ||
    (isRecord(value) &&
      Number.isSafeInteger(value.pendingSyncItems) &&
      (value.pendingSyncItems as number) >= 0 &&
      (value.pendingSyncItems as number) <= MAX_OFFLINE_CACHE_ITEMS &&
      typeof value.offlineReady === 'boolean')
  const hasAnyRtcState =
    isRecord(value) && ('rtcState' in value || 'rtcReason' in value)
  const hasValidRtcState =
    !hasAnyRtcState ||
    (isRecord(value) &&
      typeof value.rtcState === 'string' &&
      RTC_STATES.includes(value.rtcState as Esp32RtcState) &&
      typeof value.rtcReason === 'string' &&
      RTC_REASONS.includes(value.rtcReason as Esp32RtcReason) &&
      (value.rtcState === 'ready'
        ? value.rtc === true && value.rtcReason === 'none'
        : value.rtc === false && value.rtcReason !== 'none'))

  if (
    !isRecord(value) ||
    value.device !== ESP32_DEVICE_ID ||
    typeof value.online !== 'boolean' ||
    typeof value.mode !== 'string' ||
    !HARDWARE_MODES.includes(value.mode as Esp32HardwareMode) ||
    typeof value.rtc !== 'boolean' ||
    typeof value.sd !== 'boolean' ||
    (value.desktopOnline !== undefined && typeof value.desktopOnline !== 'boolean') ||
    !hasValidRtcState ||
    !hasValidCacheMetadata ||
    !hasValidOfflineJournalMetadata
  ) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The ESP32 status response is invalid.')
  }

  const status: Esp32StatusResponse = {
    device: ESP32_DEVICE_ID,
    online: value.online,
    mode: value.mode as Esp32HardwareMode,
    rtc: value.rtc,
    sd: value.sd
  }

  if (typeof value.desktopOnline === 'boolean') {
    status.desktopOnline = value.desktopOnline
  }
  if (typeof value.rtcState === 'string') {
    status.rtcState = value.rtcState as Esp32RtcState
    status.rtcReason = value.rtcReason as Esp32RtcReason
  }
  if (typeof value.offlineCacheAvailable === 'boolean') {
    status.offlineCacheAvailable = value.offlineCacheAvailable
    status.offlineCacheGeneration = value.offlineCacheGeneration as string | null
    status.offlineCacheItems = value.offlineCacheItems as number
  }
  if (typeof value.pendingSyncItems === 'number') {
    status.pendingSyncItems = value.pendingSyncItems
  }
  if (typeof value.offlineReady === 'boolean') {
    status.offlineReady = value.offlineReady
  }
  return status
}

function validateDesktopHeartbeatResponse(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, DESKTOP_HEARTBEAT_KEYS) ||
    value.desktopOnline !== true
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 desktop heartbeat response is invalid.'
    )
  }
}

function validateRtcSynchronizationRequest(request: RtcSynchronizationRequest): void {
  if (
    !isRecord(request) ||
    !hasExactlyKeys(request, ['epochSeconds', 'utcOffsetMinutes']) ||
    !Number.isSafeInteger(request.epochSeconds) ||
    request.epochSeconds < 1_577_836_800 ||
    request.epochSeconds > 4_102_444_799 ||
    !Number.isSafeInteger(request.utcOffsetMinutes) ||
    request.utcOffsetMinutes < -840 ||
    request.utcOffsetMinutes > 840
  ) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The host RTC timestamp is invalid.')
  }
  const localEpochSeconds = request.epochSeconds + request.utcOffsetMinutes * 60
  if (localEpochSeconds < 1_577_836_800 || localEpochSeconds > 4_102_444_799) {
    throw new HardwareGatewayError('INVALID_RESPONSE', 'The host RTC timestamp is invalid.')
  }
}

function validateRtcSynchronizationResponse(value: unknown): RtcSynchronizationResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, RTC_SYNC_RESPONSE_KEYS) ||
    value.synchronized !== true ||
    value.rtcState !== 'ready' ||
    typeof value.alreadyReady !== 'boolean'
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 RTC synchronization response is invalid.'
    )
  }
  return {
    synchronized: true,
    rtcState: 'ready',
    alreadyReady: value.alreadyReady
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function validateCacheProduct(product: unknown): asserts product is OfflineInventoryCacheProduct {
  if (
    !isRecord(product) ||
    !hasExactlyKeys(product, CACHE_PRODUCT_KEYS) ||
    typeof product.id !== 'string' ||
    !/^[1-9]\d*$/.test(product.id) ||
    product.id.length > 31 ||
    typeof product.barcode !== 'string' ||
    product.barcode.length === 0 ||
    product.barcode.length > 256 ||
    Buffer.byteLength(product.barcode, 'utf8') > 1_024 ||
    product.barcode.trim().length === 0 ||
    containsControlCharacter(product.barcode) ||
    typeof product.name !== 'string' ||
    product.name.trim().length === 0 ||
    product.name.length > 200 ||
    Buffer.byteLength(product.name, 'utf8') > 800 ||
    containsControlCharacter(product.name) ||
    !INVENTORY_CATEGORIES.includes(product.category as never) ||
    typeof product.currentStock !== 'number' ||
    !Number.isSafeInteger(product.currentStock) ||
    product.currentStock < 0 ||
    typeof product.lowStockThreshold !== 'number' ||
    !Number.isSafeInteger(product.lowStockThreshold) ||
    product.lowStockThreshold < 0 ||
    !STOCK_STATUSES.includes(product.status as StockStatus) ||
    product.status !==
      (product.currentStock === 0
        ? 'EMPTY'
        : product.currentStock <= product.lowStockThreshold
          ? 'LOW'
          : 'HIGH')
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The offline inventory cache contains an invalid product.'
    )
  }
}

function validateCacheSnapshot(snapshot: OfflineInventoryCacheSnapshot): void {
  if (
    !isRecord(snapshot) ||
    !hasExactlyKeys(snapshot, CACHE_SNAPSHOT_KEYS) ||
    typeof snapshot.generation !== 'string' ||
    !OFFLINE_CACHE_GENERATION_PATTERN.test(snapshot.generation) ||
    !Array.isArray(snapshot.products) ||
    snapshot.products.length > MAX_OFFLINE_CACHE_ITEMS
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The offline inventory cache snapshot is invalid.'
    )
  }

  const productIds = new Set<string>()
  const barcodes = new Set<string>()
  for (const product of snapshot.products) {
    validateCacheProduct(product)
    if (productIds.has(product.id) || barcodes.has(product.barcode)) {
      throw new HardwareGatewayError(
        'INVALID_RESPONSE',
        'The offline inventory cache contains duplicate products.'
      )
    }
    productIds.add(product.id)
    barcodes.add(product.barcode)
  }
}

function validateCacheOperationResponse(
  value: unknown,
  expectedOperation: CacheOperation,
  expectedGeneration: string,
  itemCount: number
): { receivedItems: number; alreadyCurrent: boolean } {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, CACHE_RESPONSE_KEYS) ||
    value.accepted !== true ||
    value.operation !== expectedOperation ||
    value.generation !== expectedGeneration ||
    !Number.isSafeInteger(value.receivedItems) ||
    (value.receivedItems as number) < 0 ||
    (value.receivedItems as number) > itemCount ||
    typeof value.alreadyCurrent !== 'boolean'
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 offline cache response is invalid.'
    )
  }

  return {
    receivedItems: value.receivedItems as number,
    alreadyCurrent: value.alreadyCurrent
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

function validateOfflinePendingEvent(value: unknown): OfflinePendingEvent {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, OFFLINE_PENDING_EVENT_KEYS) ||
    !isValidOfflineEventId(value.eventId) ||
    !isValidRtcTimestamp(value.timestamp) ||
    typeof value.productId !== 'string' ||
    value.productId.length === 0 ||
    value.productId.length > 31 ||
    !/^[1-9]\d*$/.test(value.productId) ||
    !isValidBarcode(value.barcode) ||
    typeof value.action !== 'string' ||
    !OFFLINE_PENDING_ACTIONS.includes(value.action as OfflinePendingAction) ||
    (value.action === 'RESTOCK' ? value.delta !== 1 : value.delta !== -1) ||
    !Number.isSafeInteger(value.resultingStock) ||
    (value.resultingStock as number) < 0 ||
    !STOCK_STATUSES.includes(value.stockStatus as StockStatus) ||
    ((value.resultingStock === 0) !== (value.stockStatus === 'EMPTY')) ||
    typeof value.cacheGeneration !== 'string' ||
    !OFFLINE_CACHE_GENERATION_PATTERN.test(value.cacheGeneration)
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 offline pending event response is invalid.'
    )
  }

  return {
    eventId: value.eventId,
    timestamp: value.timestamp as string,
    productId: value.productId,
    barcode: value.barcode as string,
    action: value.action as OfflinePendingAction,
    delta: value.delta as 1 | -1,
    resultingStock: value.resultingStock as number,
    stockStatus: value.stockStatus as StockStatus,
    cacheGeneration: value.cacheGeneration
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

function validateOfflineAcknowledgement(
  value: unknown,
  expectedEventId: string
): OfflineEventAcknowledgement {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, OFFLINE_ACKNOWLEDGEMENT_KEYS) ||
    value.acknowledged !== true ||
    value.eventId !== expectedEventId ||
    !Number.isSafeInteger(value.pendingSyncItems) ||
    (value.pendingSyncItems as number) < 0 ||
    (value.pendingSyncItems as number) > MAX_OFFLINE_CACHE_ITEMS ||
    typeof value.alreadyAcknowledged !== 'boolean'
  ) {
    throw new HardwareGatewayError(
      'INVALID_RESPONSE',
      'The ESP32 offline event acknowledgement response is invalid.'
    )
  }

  return {
    acknowledged: true,
    eventId: expectedEventId,
    pendingSyncItems: value.pendingSyncItems as number,
    alreadyAcknowledged: value.alreadyAcknowledged
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

export class Esp32HttpGateway implements DesktopHardwareGateway {
  private readonly baseUrl: string
  private readonly deviceToken: string | null
  private readonly requestTimeoutMs: number
  private readonly offlineAcknowledgementTimeoutMs: number
  private readonly fetcher: HardwareFetch

  constructor(options: Esp32HttpGatewayOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    const configuredToken = options.deviceToken?.trim() ?? ''
    if (
      configuredToken.length > 0 &&
      (configuredToken === DEVICE_TOKEN_PLACEHOLDER ||
        configuredToken.length < 32 ||
        configuredToken.length > 128 ||
        containsControlCharacter(configuredToken) ||
        configuredToken.includes(' '))
    ) {
      throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 device token is invalid.')
    }
    this.deviceToken = configuredToken.length > 0 ? configuredToken : null
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new HardwareGatewayError('UNAVAILABLE', 'The ESP32 request timeout is invalid.')
    }
    this.offlineAcknowledgementTimeoutMs =
      options.offlineAcknowledgementTimeoutMs ?? DEFAULT_OFFLINE_ACKNOWLEDGEMENT_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.offlineAcknowledgementTimeoutMs) ||
      this.offlineAcknowledgementTimeoutMs <= 0
    ) {
      throw new HardwareGatewayError(
        'UNAVAILABLE',
        'The ESP32 offline acknowledgement timeout is invalid.'
      )
    }
    this.fetcher = options.fetcher ?? defaultFetch
  }

  async healthCheck(): Promise<Esp32HealthResponse> {
    return validateHealthResponse(await this.request('/health'))
  }

  async getStatus(): Promise<Esp32StatusResponse> {
    return validateStatusResponse(await this.request('/status'))
  }

  async sendDesktopHeartbeat(): Promise<void> {
    validateDesktopHeartbeatResponse(
      await this.request('/desktop/heartbeat', { method: 'POST' })
    )
  }

  async synchronizeRtc(request: RtcSynchronizationRequest): Promise<RtcSynchronizationResult> {
    validateRtcSynchronizationRequest(request)
    if (this.deviceToken === null) {
      throw new HardwareGatewayError(
        'UNAVAILABLE',
        'The ESP32 device token is not configured.',
        'DEVICE_TOKEN_UNCONFIGURED'
      )
    }
    return validateRtcSynchronizationResponse(
      await this.request('/rtc/sync', {
        method: 'POST',
        body: JSON.stringify(request),
        deviceAuthenticated: true
      })
    )
  }

  async captureRegistrationBarcode(): Promise<string> {
    if (this.deviceToken === null) {
      throw new HardwareGatewayError(
        'UNAVAILABLE',
        'The ESP32 device token is not configured.',
        'DEVICE_TOKEN_UNCONFIGURED'
      )
    }

    validateBarcodeCaptureStart(
      await this.request('/barcode/capture', {
        method: 'POST',
        body: '{}',
        deviceAuthenticated: true
      })
    )

    const deadline = Date.now() + REGISTRATION_CAPTURE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const response = await this.request('/barcode/capture', {
        allowNoContent: true,
        deviceAuthenticated: true
      })
      if (response !== NO_CONTENT) return validateBarcodeCaptureResult(response)
      await new Promise<void>((resolve) => setTimeout(resolve, REGISTRATION_CAPTURE_POLL_INTERVAL_MS))
    }

    throw new HardwareGatewayError('UNAVAILABLE', 'The barcode scan timed out.')
  }

  async installOfflineInventoryCache(
    snapshot: OfflineInventoryCacheSnapshot
  ): Promise<OfflineInventoryCacheInstallResult> {
    validateCacheSnapshot(snapshot)
    const itemCount = snapshot.products.length
    const beginResponse = validateCacheOperationResponse(
      await this.request('/offline/cache', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'begin',
          generation: snapshot.generation,
          itemCount
        })
      }),
      'begin',
      snapshot.generation,
      itemCount
    )

    if (beginResponse.alreadyCurrent) {
      if (beginResponse.receivedItems !== itemCount) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 reported inconsistent current-cache metadata.'
        )
      }
      return { generation: snapshot.generation, itemCount, alreadyCurrent: true }
    }
    if (beginResponse.receivedItems !== 0) {
      throw new HardwareGatewayError(
        'INVALID_RESPONSE',
        'The ESP32 reported an inconsistent offline cache starting position.'
      )
    }

    let nextIndex = 0
    while (nextIndex < itemCount) {
      const itemResponse = validateCacheOperationResponse(
        await this.request('/offline/cache', {
          method: 'POST',
          body: JSON.stringify({
            operation: 'item',
            generation: snapshot.generation,
            index: nextIndex,
            product: snapshot.products[nextIndex]
          })
        }),
        'item',
        snapshot.generation,
        itemCount
      )
      if (itemResponse.alreadyCurrent || itemResponse.receivedItems !== nextIndex + 1) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 reported an inconsistent offline cache position.'
        )
      }
      nextIndex = itemResponse.receivedItems
    }

    const commitResponse = validateCacheOperationResponse(
      await this.request('/offline/cache', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'commit',
          generation: snapshot.generation,
          itemCount
        })
      }),
      'commit',
      snapshot.generation,
      itemCount
    )
    if (commitResponse.receivedItems !== itemCount) {
      throw new HardwareGatewayError(
        'INVALID_RESPONSE',
        'The ESP32 did not commit the complete offline cache.'
      )
    }

    return {
      generation: snapshot.generation,
      itemCount,
      alreadyCurrent: commitResponse.alreadyCurrent
    }
  }

  async getNextTransactionEvent(): Promise<HardwareTransactionEvent | null> {
    const response = await this.request('/events/next', { allowNoContent: true })
    return response === NO_CONTENT ? null : validateTransactionEvent(response)
  }

  async getNextOfflineEvent(): Promise<OfflinePendingEvent | null> {
    const response = await this.request('/offline/events/next', { allowNoContent: true })
    return response === NO_CONTENT ? null : validateOfflinePendingEvent(response)
  }

  async acknowledgeOfflineEvent(eventId: string): Promise<OfflineEventAcknowledgement> {
    if (!isValidOfflineEventId(eventId)) {
      throw new HardwareGatewayError(
        'INVALID_RESPONSE',
        'The offline event ID is invalid.'
      )
    }

    return validateOfflineAcknowledgement(
      await this.request('/offline/events/ack', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
        timeoutMs: this.offlineAcknowledgementTimeoutMs
      }),
      eventId
    )
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
    path:
      | '/health'
      | '/status'
      | '/desktop/heartbeat'
      | '/rtc/sync'
      | '/barcode/capture'
      | '/offline/cache'
      | '/offline/events/next'
      | '/offline/events/ack'
      | '/events/next'
      | '/events/result'
      | '/events/ack',
    options: {
      method?: 'GET' | 'POST'
      body?: string
      allowNoContent?: boolean
      timeoutMs?: number
      deviceAuthenticated?: boolean
    } = {}
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.requestTimeoutMs
    )
    const method = options.method ?? 'GET'

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(options.deviceAuthenticated === true && this.deviceToken !== null
            ? { [DEVICE_TOKEN_HEADER]: this.deviceToken }
            : {})
        },
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: options.body })
      })
      if (options.allowNoContent === true && response.status === 204) return NO_CONTENT
      if (!response.ok) {
        const diagnosticCode =
          path === '/offline/events/ack' || path === '/rtc/sync' || path === '/barcode/capture'
            ? await readSafeFirmwareDiagnostic(response)
            : undefined
        if (method === 'POST' && response.status >= 400 && response.status < 500) {
          throw new HardwareGatewayError(
            'REJECTED',
            path === '/rtc/sync'
              ? 'The ESP32 rejected the RTC synchronization request.'
              : path === '/barcode/capture'
                ? 'The ESP32 rejected the barcode capture request.'
                : path === '/events/result'
                  ? 'The ESP32 rejected the transaction result.'
                  : path === '/offline/cache'
                    ? 'The ESP32 rejected the offline inventory cache.'
                    : path === '/offline/events/ack'
                      ? 'The ESP32 rejected the offline event acknowledgement.'
                      : 'The ESP32 rejected the transaction acknowledgement.',
            diagnosticCode
          )
        }
        throw new HardwareGatewayError(
          'UNAVAILABLE',
          `The ESP32 returned HTTP ${response.status}.`,
          diagnosticCode
        )
      }

      if (path.startsWith('/events/') && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected event response status.'
        )
      }
      if (path === '/offline/events/next' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected offline event response status.'
        )
      }
      if (path === '/offline/events/ack' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected offline event acknowledgement status.'
        )
      }
      if (path === '/offline/cache' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected offline cache response status.'
        )
      }
      if (path === '/rtc/sync' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected RTC synchronization status.'
        )
      }
      if (path === '/barcode/capture' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected barcode capture status.'
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
      throw new HardwareGatewayError(
        'UNAVAILABLE',
        'The ESP32 is unavailable.',
        controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_FAILURE'
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
