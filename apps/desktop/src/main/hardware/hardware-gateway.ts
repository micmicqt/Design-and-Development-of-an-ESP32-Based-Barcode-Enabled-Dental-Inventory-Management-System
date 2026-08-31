/**
 * Boundary for the future real ESP32 transport. No renderer component may use
 * sockets directly; it will call main-process services backed by this gateway.
 */
export type HardwareConnectionState = 'CONNECTED' | 'DISCONNECTED'

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

export interface HardwareGateway {
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

/**
 * Phase 1 intentionally has no production ESP32 implementation. A real class
 * will be added only when Wi-Fi transport work is approved in a later phase.
 */
export function createProductionHardwareGateway(): never {
  throw new Error('Production ESP32 HardwareGateway is not implemented in Phase 1.')
}
