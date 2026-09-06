import type { HardwareTransactionEvent } from '../../shared/ipc-contract'
import type { HardwareTransactionResult } from '../../shared/ipc-contract'
import type {
  CacheProduct,
  HardwareBarcodeEvent,
  HardwareDeviceStatus,
  HardwareGateway,
  HardwareTransactionRequest,
  Esp32HealthResponse,
  Esp32StatusResponse,
  OfflineTransactionRecord,
  TransactionConfirmation,
  TransactionRejection,
  Unsubscribe
} from '../hardware/hardware-gateway'

/**
 * DEVELOPMENT/TEST ONLY. This class must never be selected in a packaged build.
 * It exists to exercise desktop boundaries without pretending to be real hardware.
 */
export class MockHardwareGateway implements HardwareGateway {
  private connected = false
  private readonly barcodeListeners = new Set<(event: HardwareBarcodeEvent) => void>()
  private readonly transactionListeners = new Set<
    (request: HardwareTransactionRequest) => void
  >()
  private offlineTransactions: OfflineTransactionRecord[] = []
  private transactionEvents: HardwareTransactionEvent[] = []

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MockHardwareGateway is forbidden in production builds.')
    }
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async getDeviceStatus(): Promise<HardwareDeviceStatus> {
    return {
      deviceId: 'DEVELOPMENT-MOCK-ONLY',
      connection: this.connected ? 'CONNECTED' : 'DISCONNECTED',
      firmwareVersion: 'mock'
    }
  }

  async healthCheck(): Promise<Esp32HealthResponse> {
    this.assertConnected()
    return {
      status: 'ok',
      device: 'dental-inventory-esp32',
      phase: 4
    }
  }

  async getStatus(): Promise<Esp32StatusResponse> {
    this.assertConnected()
    return {
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true
    }
  }

  async getNextTransactionEvent(): Promise<HardwareTransactionEvent | null> {
    this.assertConnected()
    const event = this.transactionEvents[0]
    return event === undefined ? null : { ...event }
  }

  async acknowledgeTransactionEvent(eventId: string): Promise<void> {
    this.assertConnected()
    if (this.transactionEvents[0]?.eventId !== eventId) {
      throw new Error('No matching development mock event.')
    }
    this.transactionEvents.shift()
  }

  async deliverTransactionResult(_result: HardwareTransactionResult): Promise<void> {
    this.assertConnected()
  }

  setTransactionEventsForTest(events: readonly HardwareTransactionEvent[]): void {
    this.transactionEvents = events.map((event) => ({ ...event }))
  }

  onBarcode(listener: (event: HardwareBarcodeEvent) => void): Unsubscribe {
    this.barcodeListeners.add(listener)
    return () => this.barcodeListeners.delete(listener)
  }

  onTransactionRequest(listener: (request: HardwareTransactionRequest) => void): Unsubscribe {
    this.transactionListeners.add(listener)
    return () => this.transactionListeners.delete(listener)
  }

  async confirmTransaction(_result: TransactionConfirmation): Promise<void> {
    this.assertConnected()
  }

  async rejectTransaction(_rejection: TransactionRejection): Promise<void> {
    this.assertConnected()
  }

  async synchronizeCache(_products: readonly CacheProduct[]): Promise<void> {
    this.assertConnected()
  }

  async retrieveOfflineTransactions(): Promise<readonly OfflineTransactionRecord[]> {
    this.assertConnected()
    return this.offlineTransactions.map((record) => ({ ...record }))
  }

  emitBarcodeForTest(event: HardwareBarcodeEvent): void {
    this.assertConnected()
    this.barcodeListeners.forEach((listener) => listener({ ...event }))
  }

  emitTransactionRequestForTest(request: HardwareTransactionRequest): void {
    this.assertConnected()
    this.transactionListeners.forEach((listener) => listener({ ...request }))
  }

  setOfflineTransactionsForTest(records: readonly OfflineTransactionRecord[]): void {
    this.offlineTransactions = records.map((record) => ({ ...record }))
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('Development mock hardware is disconnected.')
  }
}
