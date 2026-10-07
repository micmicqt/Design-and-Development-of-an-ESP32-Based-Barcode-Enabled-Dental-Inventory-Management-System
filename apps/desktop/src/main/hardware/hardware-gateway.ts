import type {
  HardwareTransactionEvent,
  HardwareTransactionResult,
  InventoryCategory,
  OfflinePendingEvent,
  OfflineJournalState,
  OfflineJournalReason,
  StockStatus
} from '../../shared/ipc-contract'

/**
 * Boundary for the future real ESP32 transport. No renderer component may use
 * sockets directly; it will call main-process services backed by this gateway.
 */
export type HardwareConnectionState = 'CONNECTED' | 'DISCONNECTED'

export const ESP32_DEVICE_ID = 'dental-inventory-esp32' as const

export type Esp32HardwareMode = 'idle' | 'restock' | 'checkout' | 'busy'
export type Esp32RtcState = 'unavailable' | 'needs_sync' | 'ready'
export type Esp32RtcReason =
  | 'none'
  | 'communication_failure'
  | 'lost_power'
  | 'invalid_time'
  | 'verification_failed'

export type Esp32OfflineAckState =
  | 'IDLE' | 'QUEUED' | 'RUNNING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED'

export interface Esp32HealthResponse {
  status: 'ok'
  device: typeof ESP32_DEVICE_ID
  phase: 4
}

export interface Esp32StatusResponse {
  device: typeof ESP32_DEVICE_ID
  online: boolean
  mode: Esp32HardwareMode
  rtc: boolean
  /** Optional for compatibility with firmware predating automatic RTC recovery. */
  rtcState?: Esp32RtcState
  rtcReason?: Esp32RtcReason
  sd: boolean
  /** Optional for compatibility with Phase 5 firmware. */
  desktopOnline?: boolean
  /** Optional for compatibility with firmware predating the offline cache. */
  offlineCacheAvailable?: boolean
  offlineCacheGeneration?: string | null
  offlineCacheItems?: number
  /** Optional for compatibility with firmware predating offline journaling. */
  pendingSyncItems?: number
  offlineReady?: boolean
  offlineJournalState?: OfflineJournalState
  offlineJournalReason?: OfflineJournalReason
  /** Optional bounded diagnostic exposed by firmware with async journal retirement. */
  offlineAckState?: Esp32OfflineAckState
  offlineAckEventId?: string | null
}

/** Narrow status boundary implemented during Phase 4 Step 2. */
export interface HardwareStatusGateway {
  healthCheck(): Promise<Esp32HealthResponse>
  getStatus(): Promise<Esp32StatusResponse>
  sendDesktopHeartbeat(): Promise<void>
}

export interface RtcSynchronizationRequest {
  epochSeconds: number
  /** Current host offset east of UTC, preserving the DS3231 local wall clock. */
  utcOffsetMinutes: number
}

export interface RtcSynchronizationResult {
  synchronized: true
  rtcState: 'ready'
  alreadyReady: boolean
}

/** Backend-only, device-authenticated RTC provisioning boundary. */
export interface RtcSynchronizationGateway {
  synchronizeRtc(request: RtcSynchronizationRequest): Promise<RtcSynchronizationResult>
}

/** Isolated scanner capture for product registration; never carries a stock action. */
export interface RegistrationBarcodeCaptureGateway {
  captureRegistrationBarcode(): Promise<string>
}

/** Polling/acknowledgement boundary for Phase 4 hardware scan delivery. */
export interface HardwareTransactionEventGateway extends HardwareStatusGateway {
  getNextTransactionEvent(): Promise<HardwareTransactionEvent | null>
  deliverTransactionResult(result: HardwareTransactionResult): Promise<void>
  acknowledgeTransactionEvent(eventId: string, reason?: 'unknown_barcode'): Promise<void>
}

export const OFFLINE_CACHE_GENERATION_PATTERN = /^v1-[0-9a-f]{64}$/

/** One authoritative active-product row sent in a bounded HTTP request. */
export interface OfflineInventoryCacheProduct {
  /** SQLite product IDs are serialized as decimal text for embedded portability. */
  id: string
  barcode: string
  name: string
  category: InventoryCategory
  currentStock: number
  lowStockThreshold: number
  status: StockStatus
}

export interface OfflineInventoryCacheSnapshot {
  generation: string
  products: readonly OfflineInventoryCacheProduct[]
}

export interface OfflineInventoryCacheInstallResult {
  generation: string
  itemCount: number
  alreadyCurrent: boolean
}

/** Bounded, sequential transport for atomically installing a MicroSD cache. */
export interface OfflineInventoryCacheGateway {
  installOfflineInventoryCache(
    snapshot: OfflineInventoryCacheSnapshot
  ): Promise<OfflineInventoryCacheInstallResult>
}

/** Non-destructive, oldest-first access to the durable offline journal. */
export interface OfflinePendingEventGateway {
  getNextOfflineEvent(): Promise<OfflinePendingEvent | null>
}

export interface OfflineEventAcknowledgement {
  acknowledged: true
  eventId: string
  pendingSyncItems: number
  alreadyAcknowledged: boolean
}

/** Idempotent retirement boundary for one durable offline journal head. */
export interface OfflineEventAcknowledgementGateway {
  acknowledgeOfflineEvent(eventId: string): Promise<OfflineEventAcknowledgement>
}

/** Production desktop boundary. Transaction and cache APIs stay backend-only. */
export interface DesktopHardwareGateway
  extends HardwareTransactionEventGateway,
    OfflineInventoryCacheGateway,
    OfflinePendingEventGateway,
    OfflineEventAcknowledgementGateway,
    RtcSynchronizationGateway,
    RegistrationBarcodeCaptureGateway {}

export function isValidHardwareTransactionEventId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 63 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
}

export interface HardwareDeviceStatus {
  deviceId: string
  connection: HardwareConnectionState
  firmwareVersion?: string
}

export interface HardwareBarcodeEvent {
  barcode: string
  scannedAt: string
}

export interface HardwareTransactionRequest {
  transactionId: string
  barcode: string
  mode: 'RESTOCK' | 'CHECKOUT'
  occurredAt: string
}

export interface TransactionConfirmation {
  transactionId: string
  previousStock: number
  newTotal: number
  stockStatus: 'HIGH' | 'LOW' | 'EMPTY'
}

export interface TransactionRejection {
  transactionId: string
  code: string
  message: string
}

export interface CacheProduct {
  barcode: string
  itemName: string
  category: string
  currentStock: number
  lowStockThreshold: number
}

export interface OfflineTransactionRecord {
  transactionId: string
  occurredAt: string
  barcode: string
  action: 'RESTOCK' | 'CHECKOUT'
  quantity: number
  previousStock: number
  newTotal: number
}

export type Unsubscribe = () => void

export interface HardwareGateway
  extends HardwareTransactionEventGateway,
    OfflinePendingEventGateway {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getDeviceStatus(): Promise<HardwareDeviceStatus>
  onBarcode(listener: (event: HardwareBarcodeEvent) => void): Unsubscribe
  onTransactionRequest(listener: (request: HardwareTransactionRequest) => void): Unsubscribe
  confirmTransaction(result: TransactionConfirmation): Promise<void>
  rejectTransaction(rejection: TransactionRejection): Promise<void>
  synchronizeCache(products: readonly CacheProduct[]): Promise<void>
  retrieveOfflineTransactions(): Promise<readonly OfflineTransactionRecord[]>
}
