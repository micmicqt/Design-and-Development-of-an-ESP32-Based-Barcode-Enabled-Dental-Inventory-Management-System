import {
  type DesktopHardwareGateway,
  ESP32_DEVICE_ID,
  type Esp32HardwareMode,
  type Esp32HealthResponse,
  type Esp32StatusResponse,
  OFFLINE_CACHE_GENERATION_PATTERN,
  type OfflineInventoryCacheInstallResult,
  type OfflineInventoryCacheProduct,
  type OfflineInventoryCacheSnapshot,
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
const RESULT_ACCEPTANCE_KEYS = ['accepted', 'eventId'] as const
const DESKTOP_HEARTBEAT_KEYS = ['desktopOnline'] as const
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

  if (
    !isRecord(value) ||
    value.device !== ESP32_DEVICE_ID ||
    typeof value.online !== 'boolean' ||
    typeof value.mode !== 'string' ||
    !HARDWARE_MODES.includes(value.mode as Esp32HardwareMode) ||
    typeof value.rtc !== 'boolean' ||
    typeof value.sd !== 'boolean' ||
    (value.desktopOnline !== undefined && typeof value.desktopOnline !== 'boolean') ||
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

  async sendDesktopHeartbeat(): Promise<void> {
    validateDesktopHeartbeatResponse(
      await this.request('/desktop/heartbeat', { method: 'POST' })
    )
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
      | '/offline/cache'
      | '/offline/events/next'
      | '/events/next'
      | '/events/result'
      | '/events/ack',
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
              : path === '/offline/cache'
                ? 'The ESP32 rejected the offline inventory cache.'
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
      if (path === '/offline/events/next' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected offline event response status.'
        )
      }
      if (path === '/offline/cache' && response.status !== 200) {
        throw new HardwareGatewayError(
          'INVALID_RESPONSE',
          'The ESP32 returned an unexpected offline cache response status.'
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
