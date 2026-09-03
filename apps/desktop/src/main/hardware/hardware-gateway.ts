/**
 * Boundary for the future real ESP32 transport. No renderer component may use
 * sockets directly; it will call main-process services backed by this gateway.
 */
export type HardwareConnectionState = 'CONNECTED' | 'DISCONNECTED'

export const ESP32_DEVICE_ID = 'dental-inventory-esp32' as const

export type Esp32HardwareMode = 'idle' | 'restock' | 'checkout' | 'busy'

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
  sd: boolean
}

/** Narrow status boundary implemented during Phase 4 Step 2. */
export interface HardwareStatusGateway {
  healthCheck(): Promise<Esp32HealthResponse>
  getStatus(): Promise<Esp32StatusResponse>
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

export interface HardwareGateway extends HardwareStatusGateway {
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
