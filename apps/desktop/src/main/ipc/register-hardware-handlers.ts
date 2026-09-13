import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import type {
  HardwareTransactionEventGateway,
  OfflinePendingEventGateway,
  RegistrationBarcodeCaptureGateway
} from '../hardware/hardware-gateway'
import type { OfflineInventoryCacheCoordinator } from '../hardware/offline-inventory-cache'
import type { OfflineSyncCoordinator } from '../hardware/offline-sync-coordinator'
import type { RtcRecoveryCoordinator } from '../hardware/rtc-recovery-coordinator'
import {
  HardwareTransactionCoordinatorError,
  type HardwareTransactionCoordinator
} from '../hardware/hardware-transaction-coordinator'
import {
  InventoryServiceError,
  OfflineReconciliationConflictError,
  type InventoryService
} from '../inventory'
import {
  IPC_CHANNELS,
  type HardwareStatusDto,
  type HardwareTransactionEvent,
  type HardwareTransactionOutcome,
  type HardwareTransactionReceipt,
  type IpcError,
  type IpcResult,
  type OfflinePendingEvent,
  type OfflineReconciliationOutcome,
  type OfflineSyncOutcome
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'
import {
  PayloadValidationError,
  validateHardwareTransactionEventIdPayload,
  validateProcessHardwareTransactionInput
} from './payload-validation'

export interface RegisterHardwareIpcHandlersOptions {
  gateway: (HardwareTransactionEventGateway &
    OfflinePendingEventGateway &
    Partial<RegistrationBarcodeCaptureGateway>) | null
  inventoryService: InventoryService
  transactionCoordinator: HardwareTransactionCoordinator
  authSession: AuthSessionController
  getMainWindow: MainWindowProvider
  offlineInventoryCacheCoordinator?: OfflineInventoryCacheCoordinator | null
  offlineSyncCoordinator?: OfflineSyncCoordinator | null
  rtcRecoveryCoordinator?: RtcRecoveryCoordinator | null
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

function sanitizedOfflineReconciliationFailure(
  error: unknown
): IpcResult<OfflineReconciliationOutcome> {
  if (error instanceof OfflineReconciliationConflictError) {
    return ok({
      status: 'CONFLICT',
      conflict: {
        code: error.code,
        message: error.message,
        eventId: error.eventId
      }
    })
  }

  // Do not expose the configured ESP32 URL, SQLite diagnostics, or raw event
  // data through the renderer boundary. Both reads and idempotent DB applies
  // are safe to retry after an internal failure.
  console.error('Offline reconciliation IPC request failed internally.')
  return failure({
    code: 'INTERNAL_ERROR',
    message: 'Unable to reconcile the pending offline transaction. Check the ESP32 and retry.'
  })
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
  const {
    gateway,
    inventoryService,
    transactionCoordinator,
    authSession,
    getMainWindow,
    offlineInventoryCacheCoordinator = null,
    offlineSyncCoordinator = null,
    rtcRecoveryCoordinator = null
  } = options
  let hardwareMutationTail: Promise<void> = Promise.resolve()
  let activeOfflineSynchronization: Promise<IpcResult<OfflineSyncOutcome>> | null = null
  function refreshOfflineCacheBestEffort(force: boolean): void {
    if (offlineInventoryCacheCoordinator === null) return
    try {
      const refresh = force
        ? offlineInventoryCacheCoordinator.refresh()
        : offlineInventoryCacheCoordinator.refreshIfNeeded()
      void refresh.catch(() => {
        // The SQLite write or online transaction has already succeeded. Cache
        // transport is best-effort and a later heartbeat can retry it safely.
      })
    } catch {
      // A cache implementation failure must not escape into Phase 5 IPC.
    }
  }

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
          ...(status.rtcState === undefined
            ? {}
            : { rtcState: status.rtcState, rtcReason: status.rtcReason }),
          sd: status.sd,
          ...(status.pendingSyncItems === undefined
            ? {}
            : { pendingSyncItems: status.pendingSyncItems }),
          ...(status.offlineReady === undefined ? {} : { offlineReady: status.offlineReady })
        }
      } catch {
        return offlineStatus()
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareSendDesktopHeartbeat,
    async (event): Promise<boolean> => {
      if (!isAuthorized(event, authSession, getMainWindow) || gateway === null) {
        return false
      }

      try {
        await gateway.sendDesktopHeartbeat()
        // The renderer supplies no clock value or firmware command. A trusted,
        // authenticated heartbeat only permits the main process to inspect the
        // RTC state and provision it from the host system clock when required.
        try {
          await rtcRecoveryCoordinator?.synchronizeIfNeeded()
        } catch {
          // RTC recovery is fail-closed and retries with its own backoff. It must
          // not invalidate a heartbeat that the ESP32 already accepted.
        }
        refreshOfflineCacheBestEffort(false)
        return true
      } catch {
        offlineInventoryCacheCoordinator?.markStale()
        // Presence is a renewable lease. A later heartbeat will recover
        // automatically, while this failure remains harmless to inventory work.
        return false
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetNextOfflineEvent,
    async (event): Promise<IpcResult<OfflinePendingEvent | null>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        if (gateway === null) throw new Error('Hardware is not configured.')
        return ok(await gateway.getNextOfflineEvent())
      } catch {
        // Retrieval is non-destructive. A later request can safely retry either
        // a transport failure or a response rejected by the gateway validator.
        return failure({
          code: 'INTERNAL_ERROR',
          message: 'Unable to read pending offline transactions. Check the ESP32 and retry.'
        })
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareReconcileNextOfflineEvent,
    async (event): Promise<IpcResult<OfflineReconciliationOutcome>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      return serializeHardwareMutation(async () => {
        try {
          if (gateway === null) throw new Error('Hardware is not configured.')

          // Always use the currently authoritative FIFO head. The renderer has
          // no way to supply an event body, result total, URL, or stale event ID.
          const pendingEvent = await gateway.getNextOfflineEvent()
          if (pendingEvent === null) return ok({ status: 'NO_PENDING_EVENT' })

          // SQLite commits (or returns its durable replay receipt) before this
          // handler returns. Firmware acknowledgement is intentionally Phase 7.3.
          return ok(inventoryService.reconcileOfflineEvent(pendingEvent))
        } catch (error: unknown) {
          return sanitizedOfflineReconciliationFailure(error)
        }
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareSynchronizeOfflineInventory,
    async (event): Promise<IpcResult<OfflineSyncOutcome>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)
      if (activeOfflineSynchronization !== null) return activeOfflineSynchronization

      const request = serializeHardwareMutation<IpcResult<OfflineSyncOutcome>>(async () => {
        try {
          if (offlineSyncCoordinator === null) {
            throw new Error('Offline synchronization is not configured.')
          }
          return ok(await offlineSyncCoordinator.synchronize())
        } catch {
          // Coordinator errors intentionally omit ESP32 URLs, journal payloads,
          // and SQLite diagnostics. All pre-ACK failures remain safe to retry.
          console.error('Offline synchronization IPC request failed internally.')
          return failure({
            code: 'INTERNAL_ERROR',
            message: 'Unable to synchronize offline transactions. Check the ESP32 and retry.'
          })
        }
      })
      activeOfflineSynchronization = request
      void request.then(
        () => {
          if (activeOfflineSynchronization === request) {
            activeOfflineSynchronization = null
          }
        },
        () => {
          if (activeOfflineSynchronization === request) {
            activeOfflineSynchronization = null
          }
        }
      )
      return request
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareCaptureRegistrationBarcode,
    async (event): Promise<IpcResult<{ barcode: string }>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        if (gateway?.captureRegistrationBarcode === undefined) {
          throw new Error('Barcode capture is not configured.')
        }
        const barcode = await gateway.captureRegistrationBarcode()
        return ok({ barcode })
      } catch {
        return failure({
          code: 'INTERNAL_ERROR',
          message: 'Unable to capture a barcode. Check the scanner connection and try again.'
        })
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
          const outcome = await transactionCoordinator.processTransaction(
            validateProcessHardwareTransactionInput(input)
          )
          refreshOfflineCacheBestEffort(true)
          return ok(outcome)
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
          const outcome = await transactionCoordinator.retryTransactionResultDelivery(
            validateHardwareTransactionEventIdPayload(eventId)
          )
          refreshOfflineCacheBestEffort(true)
          return ok(outcome)
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
          const outcome = await transactionCoordinator.retryTransactionAcknowledgement(
            validateHardwareTransactionEventIdPayload(eventId)
          )
          refreshOfflineCacheBestEffort(true)
          return ok(outcome)
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
    ipcMain.removeHandler(IPC_CHANNELS.hardwareSendDesktopHeartbeat)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetNextOfflineEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareReconcileNextOfflineEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareSynchronizeOfflineInventory)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareCaptureRegistrationBarcode)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetTransactionReceipt)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareProcessTransaction)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareRetryTransactionResultDelivery)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareRetryTransactionAcknowledgement)
  }
}
