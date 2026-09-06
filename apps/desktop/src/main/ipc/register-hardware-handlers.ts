import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import type { HardwareTransactionEventGateway } from '../hardware/hardware-gateway'
import {
  HardwareTransactionCoordinatorError,
  type HardwareTransactionCoordinator
} from '../hardware/hardware-transaction-coordinator'
import { InventoryServiceError, type InventoryService } from '../inventory'
import {
  IPC_CHANNELS,
  type HardwareStatusDto,
  type HardwareTransactionEvent,
  type HardwareTransactionOutcome,
  type HardwareTransactionReceipt,
  type IpcError,
  type IpcResult
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'
import {
  PayloadValidationError,
  validateHardwareTransactionEventIdPayload,
  validateProcessHardwareTransactionInput
} from './payload-validation'

export interface RegisterHardwareIpcHandlersOptions {
  gateway: HardwareTransactionEventGateway | null
  inventoryService: InventoryService
  transactionCoordinator: HardwareTransactionCoordinator
  authSession: AuthSessionController
  getMainWindow: MainWindowProvider
}

const unauthorizedError: IpcError = {
  code: 'UNAUTHORIZED',
  message: 'Administrator authentication is required.'
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error }
}

function isAuthorized(
  event: IpcMainInvokeEvent,
  authSession: AuthSessionController,
  getMainWindow: MainWindowProvider
): boolean {
  return isTrustedMainFrame(event, getMainWindow) && authSession.isAuthenticated()
}

function sanitizedTransactionFailure<T>(error: unknown, fallbackMessage: string): IpcResult<T> {
  if (error instanceof PayloadValidationError) {
    return failure({
      code: 'VALIDATION_ERROR',
      message: 'Check the transaction details and try again.',
      fieldErrors: error.fieldErrors
    })
  }

  if (error instanceof HardwareTransactionCoordinatorError) {
    switch (error.code) {
      case 'EVENT_NOT_PENDING':
      case 'RECEIPT_NOT_FOUND':
        return failure({ code: 'NOT_FOUND', message: error.message })
      case 'EVENT_MISMATCH':
      case 'RESULT_NOT_DELIVERED':
        return failure({ code: 'VALIDATION_ERROR', message: error.message })
      case 'HARDWARE_UNAVAILABLE':
        return failure({ code: 'INTERNAL_ERROR', message: fallbackMessage })
    }
  }

  if (error instanceof InventoryServiceError) {
    if (error.code === 'PRODUCT_NOT_FOUND') {
      return failure({ code: 'NOT_FOUND', message: 'The scanned item is not registered.' })
    }
    if (error.code === 'VALIDATION_ERROR') {
      return failure({ code: 'VALIDATION_ERROR', message: error.message })
    }
  }

  // Transport failures may contain local URLs or other sensitive diagnostics.
  // Keep those details out of renderer responses and production logs.
  console.error('Hardware transaction IPC request failed internally.')
  return failure({ code: 'INTERNAL_ERROR', message: fallbackMessage })
}

function offlineStatus(): HardwareStatusDto {
  return {
    connection: 'OFFLINE',
    device: null,
    mode: null,
    rtc: null,
    sd: null
  }
}

export function registerHardwareIpcHandlers(
  options: RegisterHardwareIpcHandlersOptions
): () => void {
  const { gateway, inventoryService, transactionCoordinator, authSession, getMainWindow } = options
  let hardwareMutationTail: Promise<void> = Promise.resolve()

  function serializeHardwareMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = hardwareMutationTail.then(operation, operation)
    hardwareMutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetStatus,
    async (event): Promise<HardwareStatusDto> => {
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        return offlineStatus()
      }

      try {
        const status = await gateway.getStatus()
        return {
          connection: status.online ? 'CONNECTED' : 'OFFLINE',
          device: status.device,
          mode: status.mode,
          rtc: status.rtc,
          sd: status.sd
        }
      } catch {
        return offlineStatus()
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetNextTransactionEvent,
    async (event): Promise<HardwareTransactionEvent | null> => {
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        return null
      }

      try {
        return await gateway.getNextTransactionEvent()
      } catch {
        // Offline/malformed responses must not crash the inventory workspace.
        // No event is acknowledged here; the next poll can safely retry.
        return null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareAcknowledgeTransactionEvent,
    async (event, eventId: unknown): Promise<IpcResult<{ eventId: string }>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      return serializeHardwareMutation(async () => {
        try {
          const validatedEventId = validateHardwareTransactionEventIdPayload(eventId)
          if (gateway === null) throw new Error('Hardware is not configured.')

          const pendingEvent = await gateway.getNextTransactionEvent()
          if (pendingEvent === null) {
            // Do not let an uncommitted-cancellation retry dismiss a transaction
            // that crossed the durable commit boundary before the FIFO advanced.
            if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
              return failure({
                code: 'VALIDATION_ERROR',
                message: 'This inventory transaction is already saved and must finish recovery.'
              })
            }

            // Cancellation/rejection is idempotent. A retry can arrive after the
            // ESP32 removed the event but its successful HTTP response was lost.
            return ok({ eventId: validatedEventId })
          }
          if (pendingEvent.eventId !== validatedEventId) {
            if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
              return failure({
                code: 'VALIDATION_ERROR',
                message: 'This inventory transaction is already saved and must finish recovery.'
              })
            }

            // A successful cancellation ACK can advance the FIFO before its HTTP
            // response reaches the desktop. Retry the old ID so the firmware's
            // bounded recent-ACK receipt can prove that cancellation without ever
            // consuming the newly visible head. A rejected retry is a true
            // mismatch and leaves both events untouched.
            try {
              await gateway.acknowledgeTransactionEvent(validatedEventId)
              return ok({ eventId: validatedEventId })
            } catch {
              return failure({
                code: 'VALIDATION_ERROR',
                message: 'A different hardware scan is currently pending.'
              })
            }
          }

          const registeredProduct = inventoryService.findProductByBarcode(pendingEvent.barcode)

          // Explicit rejection/cancellation may discard only an event that has not
          // committed inventory work. Once a durable receipt exists, the event must
          // complete result delivery and acknowledgement through the coordinator.
          if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
            return failure({
              code: 'VALIDATION_ERROR',
              message: registeredProduct === null
                ? 'This scan is already associated with a saved transaction.'
                : 'This inventory transaction is already saved and must finish recovery.'
            })
          }

          try {
            await gateway.acknowledgeTransactionEvent(validatedEventId)
          } catch (acknowledgementError: unknown) {
            // Resolve an ambiguous transport failure by reading the authoritative
            // FIFO head. If this event is gone, the ACK was applied and retrying is
            // safely treated as success. A transport failure or unchanged head
            // still preserves the dialog for another retry.
            const eventAfterAcknowledgement = await gateway.getNextTransactionEvent()
            if (
              eventAfterAcknowledgement === null ||
              eventAfterAcknowledgement.eventId !== validatedEventId
            ) {
              return ok({ eventId: validatedEventId })
            }
            throw acknowledgementError
          }
          return ok({ eventId: validatedEventId })
        } catch (error: unknown) {
          return sanitizedTransactionFailure(
            error,
            'Unable to acknowledge this scan. Check the ESP32 connection and retry.'
          )
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetTransactionReceipt,
    async (event, eventId: unknown): Promise<IpcResult<HardwareTransactionReceipt | null>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        return ok(
          transactionCoordinator.getTransactionReceipt(
            validateHardwareTransactionEventIdPayload(eventId)
          )
        )
      } catch (error: unknown) {
        return sanitizedTransactionFailure(error, 'Unable to check this transaction.')
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareProcessTransaction,
    async (event, input: unknown): Promise<IpcResult<HardwareTransactionOutcome>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      return serializeHardwareMutation(async () => {
        try {
          return ok(
            await transactionCoordinator.processTransaction(
              validateProcessHardwareTransactionInput(input)
            )
          )
        } catch (error: unknown) {
          return sanitizedTransactionFailure(error, 'Unable to process this hardware transaction.')
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareRetryTransactionResultDelivery,
    async (event, eventId: unknown): Promise<IpcResult<HardwareTransactionOutcome>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      return serializeHardwareMutation(async () => {
        try {
          return ok(
            await transactionCoordinator.retryTransactionResultDelivery(
              validateHardwareTransactionEventIdPayload(eventId)
            )
          )
        } catch (error: unknown) {
          return sanitizedTransactionFailure(
            error,
            'Inventory was updated, but the result could not be delivered to the kiosk.'
          )
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareRetryTransactionAcknowledgement,
    async (event, eventId: unknown): Promise<IpcResult<HardwareTransactionOutcome>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      return serializeHardwareMutation(async () => {
        try {
          return ok(
            await transactionCoordinator.retryTransactionAcknowledgement(
              validateHardwareTransactionEventIdPayload(eventId)
            )
          )
        } catch (error: unknown) {
          return sanitizedTransactionFailure(
            error,
            'Inventory was updated, but the kiosk acknowledgement could not be completed.'
          )
        }
      })
    }
  )

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetStatus)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetTransactionReceipt)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareProcessTransaction)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareRetryTransactionResultDelivery)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareRetryTransactionAcknowledgement)
  }
}
