import type {
  HardwareTransactionEvent,
  HardwareTransactionOutcome,
  HardwareTransactionReceipt,
  ProcessHardwareTransactionInput
} from '../../shared/ipc-contract'
import type { HardwareTransactionEventGateway } from './hardware-gateway'

export const HARDWARE_TRANSACTION_COORDINATOR_ERROR_CODES = [
  'HARDWARE_UNAVAILABLE',
  'EVENT_NOT_PENDING',
  'EVENT_MISMATCH',
  'RECEIPT_NOT_FOUND'
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
}

export interface HardwareTransactionCoordinator {
  getTransactionReceipt(eventId: string): HardwareTransactionReceipt | null
  processTransaction(input: ProcessHardwareTransactionInput): Promise<HardwareTransactionOutcome>
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

  const acknowledgeCommittedReceipt = async (
    receipt: HardwareTransactionReceipt
  ): Promise<HardwareTransactionOutcome> => {
    if (gateway === null) return { receipt, acknowledged: false }

    let pendingEvent: HardwareTransactionEvent | null
    try {
      pendingEvent = await gateway.getNextTransactionEvent()
    } catch {
      return { receipt, acknowledged: false }
    }

    // The ACK may have reached the ESP32 even when its HTTP response was lost.
    // An empty queue therefore means there is nothing left to acknowledge.
    if (pendingEvent === null) return { receipt, acknowledged: true }
    if (pendingEvent.eventId !== receipt.eventId || !isSameEvent(receipt, pendingEvent)) {
      throw new HardwareTransactionCoordinatorError(
        'EVENT_MISMATCH',
        'A different hardware scan is currently pending.'
      )
    }

    try {
      await gateway.acknowledgeTransactionEvent(receipt.eventId)
      return { receipt, acknowledged: true }
    } catch {
      return { receipt, acknowledged: false }
    }
  }

  return {
    getTransactionReceipt(eventId) {
      return inventoryService.findHardwareTransactionReceipt(eventId)
    },

    async processTransaction(input) {
      const existingReceipt = inventoryService.findHardwareTransactionReceipt(input.eventId)
      if (existingReceipt !== null) {
        return acknowledgeCommittedReceipt(existingReceipt)
      }

      const event = await requirePendingHead(input.eventId)
      const receipt = inventoryService.processHardwareTransaction({
        event,
        quantity: input.quantity
      })

      // The synchronous SQLite transaction above has committed before this
      // first acknowledgement attempt. ACK failure never rolls it back.
      return acknowledgeCommittedReceipt(receipt)
    },

    async retryTransactionAcknowledgement(eventId) {
      const receipt = inventoryService.findHardwareTransactionReceipt(eventId)
      if (receipt === null) {
        throw new HardwareTransactionCoordinatorError(
          'RECEIPT_NOT_FOUND',
          'No committed transaction was found for this hardware scan.'
        )
      }
      return acknowledgeCommittedReceipt(receipt)
    }
  }
}
