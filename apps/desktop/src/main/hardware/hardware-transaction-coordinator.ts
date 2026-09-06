import type {
  HardwareTransactionEvent,
  HardwareTransactionOutcome,
  HardwareTransactionReceipt,
  HardwareTransactionResult,
  ProcessHardwareTransactionInput
} from '../../shared/ipc-contract'
import type { HardwareTransactionEventGateway } from './hardware-gateway'

export const HARDWARE_TRANSACTION_COORDINATOR_ERROR_CODES = [
  'HARDWARE_UNAVAILABLE',
  'EVENT_NOT_PENDING',
  'EVENT_MISMATCH',
  'RECEIPT_NOT_FOUND',
  'RESULT_NOT_DELIVERED'
] as const

export type HardwareTransactionCoordinatorErrorCode =
  (typeof HARDWARE_TRANSACTION_COORDINATOR_ERROR_CODES)[number]

export class HardwareTransactionCoordinatorError extends Error {
  constructor(
    readonly code: HardwareTransactionCoordinatorErrorCode,
    message: string
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

    let pendingEvent: HardwareTransactionEvent | null
    try {
      pendingEvent = await gateway.getNextTransactionEvent()
    } catch {
      throw new HardwareTransactionCoordinatorError(
        'HARDWARE_UNAVAILABLE',
        'The inventory kiosk is unavailable.'
      )
    }

    if (pendingEvent === null) {
      throw new HardwareTransactionCoordinatorError(
        'EVENT_NOT_PENDING',
        'This hardware scan is no longer pending.'
      )
    }
    if (pendingEvent.eventId !== eventId) {
      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }
    return pendingEvent
  }

  const completeCommittedReceipt = async (
    receipt: HardwareTransactionReceipt
  ): Promise<HardwareTransactionOutcome> => {
    if (gateway === null) return { receipt, acknowledged: false }

    let pendingEvent: HardwareTransactionEvent | null
    try {
      pendingEvent = await gateway.getNextTransactionEvent()
    } catch {
      return { receipt, acknowledged: false }
    }

    // An empty queue can prove a lost ACK response only after result delivery
    // was durably recorded. Before that boundary, never claim completion.
    if (pendingEvent === null) {
      return {
        receipt,
        acknowledged: receipt.resultDeliveredToHardware
      }
    }
    if (pendingEvent.eventId !== receipt.eventId) {
      // A successful ACK can advance the ESP32 FIFO before its HTTP response
      // is lost. Once result delivery is durable, retry the old event ID and
      // let the firmware's recent-ACK receipt prove completion. Its FIFO guard
      // guarantees this request cannot remove the newly visible head.
      if (receipt.resultDeliveredToHardware) {
        try {
          await gateway.acknowledgeTransactionEvent(receipt.eventId)
          return { receipt, acknowledged: true }
        } catch {
          return { receipt, acknowledged: false }
        }
      }

      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }
    if (!isSameEvent(receipt, pendingEvent)) {
      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }

    let currentReceipt = receipt
    if (!currentReceipt.resultDeliveredToHardware) {
      try {
        await gateway.deliverTransactionResult(resultFromReceipt(currentReceipt))
      } catch {
        return { receipt: currentReceipt, acknowledged: false }
      }

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
      return { receipt: currentReceipt, acknowledged: true }
    } catch {
      return { receipt: currentReceipt, acknowledged: false }
    }
  }

  return {
    getTransactionReceipt(eventId) {
      return inventoryService.findHardwareTransactionReceipt(eventId)
    },

    async processTransaction(input) {
      const existingReceipt = inventoryService.findHardwareTransactionReceipt(input.eventId)
      if (existingReceipt !== null) {
        return completeCommittedReceipt(existingReceipt)
      }

      const event = await requirePendingHead(input.eventId)
      const receipt = inventoryService.processHardwareTransaction({
        event,
        quantity: input.quantity
      })

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
