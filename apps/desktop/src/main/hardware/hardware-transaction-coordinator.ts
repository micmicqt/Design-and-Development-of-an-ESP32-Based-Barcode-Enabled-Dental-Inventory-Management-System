import type {
  HardwareTransactionEvent,
  HardwareTransactionOutcome,
  HardwareTransactionReceipt,
  HardwareTransactionResult,
  ProcessHardwareTransactionInput
} from '../../shared/ipc-contract'
import type { HardwareTransactionEventGateway } from './hardware-gateway'
import { HardwareGatewayError } from './esp32-http-gateway'
import { InventoryServiceError } from '../inventory'

export const HARDWARE_TRANSACTION_COORDINATOR_ERROR_CODES = [
  'HARDWARE_UNAVAILABLE',
  'DATABASE_FAILURE',
  'EVENT_NOT_PENDING',
  'EVENT_MISMATCH',
  'RECEIPT_NOT_FOUND',
  'RESULT_NOT_DELIVERED'
] as const

export type HardwareTransactionCoordinatorErrorCode =
  (typeof HARDWARE_TRANSACTION_COORDINATOR_ERROR_CODES)[number]

export type PendingEventFailureCategory =
  | 'TRANSPORT_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'BUSY'
  | 'NO_EVENT'
  | 'DIFFERENT_EVENT'
  | 'INVALID_RESPONSE'
  | 'OTHER'

export function gatewayFailureCategory(error: unknown): PendingEventFailureCategory {
  if (!(error instanceof HardwareGatewayError)) return 'OTHER'
  if (error.diagnosticCode === 'REQUEST_TIMEOUT') return 'TRANSPORT_TIMEOUT'
  if (error.diagnosticCode === 'NETWORK_FAILURE') return 'NETWORK_FAILURE'
  if (error.diagnosticCode === 'offline_ack_in_progress') return 'BUSY'
  if (error.diagnosticCode === 'no_pending_event') return 'NO_EVENT'
  if (error.diagnosticCode === 'event_id_mismatch') return 'DIFFERENT_EVENT'
  if (error.code === 'INVALID_RESPONSE') return 'INVALID_RESPONSE'
  return 'OTHER'
}

export function traceEventResolution(
  operation: string,
  expectedEventId: string,
  actualEventId: string | null,
  classification: string,
  sqliteCommitted: boolean,
  deviceRetired: boolean,
  httpStatus?: number,
  actualMode?: string
): void {
  if (process.env.DENTAL_HARDWARE_EVENT_DEBUG !== '1') return
  // Event IDs are correlation IDs. Never log barcode, URL, token or raw HTTP.
  console.debug('[hardware event]', {
    operation, expectedEventId, actualEventId, classification,
    headChanged: actualEventId !== null && actualEventId !== expectedEventId,
    actualMode: actualMode ?? null, sqliteCommitted, deviceRetired,
    httpStatus: httpStatus ?? null
  })
}

export class HardwareTransactionCoordinatorError extends Error {
  constructor(
    readonly code: HardwareTransactionCoordinatorErrorCode,
    message: string,
    readonly failureCategory?: PendingEventFailureCategory
  ) {
    super(message)
    this.name = 'HardwareTransactionCoordinatorError'
  }
}

/** Narrow, structurally compatible boundary implemented by InventoryService. */
export interface HardwareTransactionInventoryService {
  findHardwareTransactionReceipt(eventId: string): HardwareTransactionReceipt | null
  processHardwareTransaction(input: {
    event: HardwareTransactionEvent
    quantity: number
  }): HardwareTransactionReceipt
  markHardwareTransactionResultDelivered(eventId: string): HardwareTransactionReceipt
}

export interface HardwareTransactionCoordinator {
  getTransactionReceipt(eventId: string): HardwareTransactionReceipt | null
  processTransaction(input: ProcessHardwareTransactionInput): Promise<HardwareTransactionOutcome>
  retryTransactionResultDelivery(eventId: string): Promise<HardwareTransactionOutcome>
  retryTransactionAcknowledgement(eventId: string): Promise<HardwareTransactionOutcome>
}

export interface CreateHardwareTransactionCoordinatorOptions {
  inventoryService: HardwareTransactionInventoryService
  gateway: HardwareTransactionEventGateway | null
}

function isSameEvent(
  receipt: HardwareTransactionReceipt,
  event: HardwareTransactionEvent
): boolean {
  return (
    receipt.eventId === event.eventId &&
    receipt.mode === event.mode &&
    receipt.barcode === event.barcode &&
    receipt.timestamp === event.timestamp
  )
}

function resultFromReceipt(receipt: HardwareTransactionReceipt): HardwareTransactionResult {
  return {
    eventId: receipt.eventId,
    result: 'success',
    mode: receipt.mode,
    quantity: receipt.quantity,
    resultingStock: receipt.newTotal,
    stockStatus: receipt.status
  }
}

export function createHardwareTransactionCoordinator(
  options: CreateHardwareTransactionCoordinatorOptions
): HardwareTransactionCoordinator {
  const { inventoryService, gateway } = options

  const requirePendingHead = async (eventId: string): Promise<HardwareTransactionEvent> => {
    if (gateway === null) {
      throw new HardwareTransactionCoordinatorError(
        'HARDWARE_UNAVAILABLE',
        'The inventory kiosk is not configured.'
      )
    }

    let pendingEvent: HardwareTransactionEvent | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // A GET has no FIFO side effect. One bounded retry can recover a
        // transient HTTP timeout without weakening the exact-head check.
        pendingEvent = await gateway.getNextTransactionEvent()
        break
      } catch (error) {
        const category = gatewayFailureCategory(error)
        traceEventResolution('VERIFY', eventId, null, category, false, false,
          error instanceof HardwareGatewayError ? error.httpStatus : undefined)
        if (attempt === 0 &&
            (category === 'TRANSPORT_TIMEOUT' || category === 'NETWORK_FAILURE')) continue
        // This is the pre-commit boundary. Log only typed transport categories,
        // never the configured URL or a raw network exception.
        console.warn(
          'ESP32 pending-event verification failed before inventory commit:',
          error instanceof HardwareGatewayError
            ? `${error.code}/${error.diagnosticCode ?? 'UNSPECIFIED'}`
            : 'UNKNOWN'
        )
        throw new HardwareTransactionCoordinatorError(
          'HARDWARE_UNAVAILABLE',
          'The inventory kiosk is unavailable.',
          category
        )
      }
    }

    if (pendingEvent === null) {
      traceEventResolution('VERIFY', eventId, null, 'NO_EVENT', false, false)
      throw new HardwareTransactionCoordinatorError(
        'EVENT_NOT_PENDING',
        'This hardware scan is no longer pending.'
      )
    }
    if (pendingEvent.eventId !== eventId) {
      traceEventResolution('VERIFY', eventId, pendingEvent.eventId,
        'DIFFERENT_EVENT', false, false, undefined, pendingEvent.mode)
      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }
    traceEventResolution('VERIFY', eventId, pendingEvent.eventId,
      'MATCH', false, false, undefined, pendingEvent.mode)
    return pendingEvent
  }

  const completeCommittedReceipt = async (
    receipt: HardwareTransactionReceipt
  ): Promise<HardwareTransactionOutcome> => {
    if (gateway === null) return { receipt, acknowledged: false }

    let pendingEvent: HardwareTransactionEvent | null
    try {
      pendingEvent = await gateway.getNextTransactionEvent()
    } catch (error) {
      traceEventResolution('CONFIRM', receipt.eventId, null,
        gatewayFailureCategory(error), true, false,
        error instanceof HardwareGatewayError ? error.httpStatus : undefined)
      return { receipt, acknowledged: false }
    }

    // An empty queue can prove a lost ACK response only after result delivery
    // was durably recorded. Before that boundary, never claim completion.
    if (pendingEvent === null) {
      traceEventResolution('CONFIRM', receipt.eventId, null,
        receipt.resultDeliveredToHardware ? 'ALREADY_RESOLVED' : 'NO_EVENT',
        true, receipt.resultDeliveredToHardware)
      return {
        receipt,
        acknowledged: receipt.resultDeliveredToHardware
      }
    }
    if (pendingEvent.eventId !== receipt.eventId) {
      traceEventResolution('CONFIRM', receipt.eventId, pendingEvent.eventId,
        'DIFFERENT_EVENT', true, false, undefined, pendingEvent.mode)
      // A successful ACK can advance the ESP32 FIFO before its HTTP response
      // is lost. Once result delivery is durable, retry the old event ID and
      // let the firmware's recent-ACK receipt prove completion. Its FIFO guard
      // guarantees this request cannot remove the newly visible head.
      if (receipt.resultDeliveredToHardware) {
        try {
          await gateway.acknowledgeTransactionEvent(receipt.eventId)
          traceEventResolution('CONFIRM', receipt.eventId, pendingEvent.eventId,
            'ALREADY_RESOLVED', true, true)
          return { receipt, acknowledged: true }
        } catch (error) {
          traceEventResolution('CONFIRM', receipt.eventId, pendingEvent.eventId,
            gatewayFailureCategory(error), true, false,
            error instanceof HardwareGatewayError ? error.httpStatus : undefined)
          return { receipt, acknowledged: false }
        }
      }

      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }
    if (!isSameEvent(receipt, pendingEvent)) {
      traceEventResolution('CONFIRM', receipt.eventId, pendingEvent.eventId,
        'EVENT_PAYLOAD_MISMATCH', true, false, undefined, pendingEvent.mode)
      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }

    let currentReceipt = receipt
    if (!currentReceipt.resultDeliveredToHardware) {
      try {
        await gateway.deliverTransactionResult(resultFromReceipt(currentReceipt))
      } catch (error) {
        traceEventResolution('RESULT', currentReceipt.eventId, pendingEvent.eventId,
          gatewayFailureCategory(error), true, false,
          error instanceof HardwareGatewayError ? error.httpStatus : undefined)
        return { receipt: currentReceipt, acknowledged: false }
      }
      traceEventResolution('RESULT', currentReceipt.eventId, pendingEvent.eventId,
        'MATCH', true, false)

      // The ESP32 accepts identical result retries. Persisting this boundary
      // makes later recovery ACK-only, including after an Electron restart.
      try {
        currentReceipt = inventoryService.markHardwareTransactionResultDelivered(
          currentReceipt.eventId
        )
      } catch {
        // The result may already be applied to hardware. Keep ACK pending and
        // safely retry the identical result before attempting ACK.
        return { receipt: currentReceipt, acknowledged: false }
      }
    }

    try {
      await gateway.acknowledgeTransactionEvent(currentReceipt.eventId)
      traceEventResolution('CONFIRM', currentReceipt.eventId, pendingEvent.eventId,
        'MATCH', true, true)
      return { receipt: currentReceipt, acknowledged: true }
    } catch (error) {
      traceEventResolution('CONFIRM', currentReceipt.eventId, pendingEvent.eventId,
        gatewayFailureCategory(error), true, false,
        error instanceof HardwareGatewayError ? error.httpStatus : undefined)
      return { receipt: currentReceipt, acknowledged: false }
    }
  }

  return {
    getTransactionReceipt(eventId) {
      return inventoryService.findHardwareTransactionReceipt(eventId)
    },

    async processTransaction(input) {
      let existingReceipt: HardwareTransactionReceipt | null
      try {
        existingReceipt = inventoryService.findHardwareTransactionReceipt(input.eventId)
      } catch {
        throw new HardwareTransactionCoordinatorError(
          'DATABASE_FAILURE',
          'The inventory database could not check this hardware scan.'
        )
      }
      if (existingReceipt !== null) {
        return completeCommittedReceipt(existingReceipt)
      }

      const event = await requirePendingHead(input.eventId)
      let receipt: HardwareTransactionReceipt
      try {
        receipt = inventoryService.processHardwareTransaction({
          event,
          quantity: input.quantity
        })
      } catch (error) {
        if (error instanceof InventoryServiceError) throw error
        throw new HardwareTransactionCoordinatorError(
          'DATABASE_FAILURE',
          'The inventory database could not commit this hardware transaction.'
        )
      }

      // SQLite has committed before result delivery. A result or ACK failure
      // never rolls it back and the durable receipt prevents a second mutation.
      return completeCommittedReceipt(receipt)
    },

    async retryTransactionResultDelivery(eventId) {
      const receipt = inventoryService.findHardwareTransactionReceipt(eventId)
      if (receipt === null) {
        throw new HardwareTransactionCoordinatorError(
          'RECEIPT_NOT_FOUND',
          'No committed transaction was found for this hardware scan.'
        )
      }
      return completeCommittedReceipt(receipt)
    },

    async retryTransactionAcknowledgement(eventId) {
      const receipt = inventoryService.findHardwareTransactionReceipt(eventId)
      if (receipt === null) {
        throw new HardwareTransactionCoordinatorError(
          'RECEIPT_NOT_FOUND',
          'No committed transaction was found for this hardware scan.'
        )
      }
      if (!receipt.resultDeliveredToHardware) {
        throw new HardwareTransactionCoordinatorError(
          'RESULT_NOT_DELIVERED',
          'The committed result must be delivered before acknowledgement.'
        )
      }
      return completeCommittedReceipt(receipt)
    }
  }
}
