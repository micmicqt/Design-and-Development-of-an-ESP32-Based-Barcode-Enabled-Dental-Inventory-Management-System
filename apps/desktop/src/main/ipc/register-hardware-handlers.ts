import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import type {
  HardwareTransactionEventGateway,
  OfflinePendingEventGateway,
  RegistrationBarcodeCaptureGateway
} from '../hardware/hardware-gateway'
import { HardwareGatewayError } from '../hardware/esp32-http-gateway'
import { OfflineCacheRefreshDeferredError, type OfflineInventoryCacheCoordinator } from '../hardware/offline-inventory-cache'
import { OfflineSyncCoordinatorError, offlineSyncFailureMessage,
  type OfflineSyncCoordinator } from '../hardware/offline-sync-coordinator'
import type { RtcRecoveryCoordinator } from '../hardware/rtc-recovery-coordinator'
import {
  HardwareTransactionCoordinatorError,
  gatewayFailureCategory,
  traceEventResolution,
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
  unconfigured?: boolean
  onMutationPendingChange?: (pending: number) => void
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
        console.warn('Hardware transaction could not verify the pending ESP32 scan before commit.')
        return failure({
          code: 'INTERNAL_ERROR',
          message: error.failureCategory === 'TRANSPORT_TIMEOUT'
            ? 'ESP32 scan verification timed out. Inventory was not updated; please retry.'
            : error.failureCategory === 'NETWORK_FAILURE'
              ? 'The ESP32 connection failed during scan verification. Inventory was not updated; please retry.'
              : error.failureCategory === 'BUSY'
                ? 'The ESP32 is busy. Inventory was not updated; please retry shortly.'
                : 'The ESP32 did not confirm this pending scan. Inventory was not updated; please retry.'
        })
      case 'DATABASE_FAILURE':
        console.error('Hardware transaction database operation failed; verify the durable receipt before retry.')
        return failure({
          code: 'INTERNAL_ERROR',
          message: 'The inventory update could not be confirmed. Check the saved transaction before retrying.'
        })
    }
  }

  if (error instanceof HardwareGatewayError) {
    const category = gatewayFailureCategory(error)
    return failure({
      code: category === 'BUSY' || category === 'DIFFERENT_EVENT'
        ? 'VALIDATION_ERROR'
        : category === 'NO_EVENT' ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      message: category === 'TRANSPORT_TIMEOUT'
        ? 'The ESP32 acknowledgement timed out. The scan remains recoverable; please retry or choose Review later.'
        : category === 'NETWORK_FAILURE'
          ? 'The ESP32 connection failed during acknowledgement. Please retry or choose Review later.'
          : category === 'BUSY'
            ? 'The ESP32 is finishing another operation. Please retry or choose Review later.'
            : category === 'DIFFERENT_EVENT'
              ? 'A different hardware scan is currently pending.'
              : category === 'NO_EVENT'
                ? 'This hardware scan is no longer pending.'
            : fallbackMessage
    })
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

function transportStatus(
  connection: HardwareStatusDto['connection'],
  lastKnown: HardwareStatusDto | null = null
): HardwareStatusDto {
  // A failed transport read is not a fresh RTC/SD measurement. Keep only the
  // last component observation; never reuse stale offline-sync readiness or
  // pending counts to enable a synchronization decision.
  return {
    connection,
    device: lastKnown?.device ?? null,
    mode: lastKnown?.mode ?? null,
    rtc: lastKnown?.rtc ?? null,
    sd: lastKnown?.sd ?? null,
    ...(lastKnown?.rtcState === undefined
      ? {}
      : { rtcState: lastKnown.rtcState, rtcReason: lastKnown.rtcReason })
  }
}

function offlineStatus(): HardwareStatusDto {
  return transportStatus('OFFLINE')
}

function pollingFailureCode(error: unknown): string {
  if (!(error instanceof HardwareGatewayError)) return 'UNKNOWN'
  return `${error.code}/${error.diagnosticCode ?? 'UNSPECIFIED'}` +
    (error.httpStatus === undefined ? '' : `/HTTP_${error.httpStatus}`)
}

function pollingStatusSummary(status: HardwareStatusDto): string {
  return `${status.connection} rtc=${status.rtc === null ? '?' : status.rtc} ` +
    `sd=${status.sd === null ? '?' : status.sd}`
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
    rtcRecoveryCoordinator = null,
    unconfigured = false,
    onMutationPendingChange
  } = options
  let hardwareMutationTail: Promise<void> = Promise.resolve()
  let pendingHardwareMutations = 0
  let activeOfflineSynchronization: Promise<IpcResult<OfflineSyncOutcome>> | null = null
  let disposed = false
  let lastConnectedStatus: HardwareStatusDto | null = null
  let lastReturnedStatus = offlineStatus()
  let lastSuccessfulStatusAtMs: number | null = null
  let consecutiveStatusFailures = 0
  let statusPollSequence = 0
  let completedStatusSequence = 0
  let eventPollSequence = 0
  const pollDiagnosticsEnabled = process.env.DENTAL_HARDWARE_TIMING_DEBUG === '1'
  function refreshOfflineCacheBestEffort(force: boolean): void {
    if (disposed || offlineInventoryCacheCoordinator === null) return
    try {
      const refresh = force
        ? offlineInventoryCacheCoordinator.refresh()
        : offlineInventoryCacheCoordinator.refreshIfNeeded()
      void refresh.catch((error: unknown) => {
        if (error instanceof OfflineCacheRefreshDeferredError) return
        // The SQLite write or online transaction has already succeeded. Cache
        // transport is best-effort and a later heartbeat can retry it safely.
        console.warn('Offline cache refresh failed after inventory commit; retry remains pending.')
      })
    } catch {
      // A cache implementation failure must not escape into Phase 5 IPC.
      console.warn('Offline cache refresh could not start; inventory remains committed.')
    }
  }

  function scheduleOfflineCacheRefresh(force: boolean): void {
    // Let the committed transaction IPC response settle before starting a
    // potentially slow MicroSD-backed cache transfer on the device.
    setImmediate(() => refreshOfflineCacheBestEffort(force))
  }

  function serializeHardwareMutation<T>(operation: () => Promise<T>): Promise<T> {
    pendingHardwareMutations += 1
    onMutationPendingChange?.(pendingHardwareMutations)
    const run = async (): Promise<T> => {
      try { return await operation() } finally {
        pendingHardwareMutations -= 1
        onMutationPendingChange?.(pendingHardwareMutations)
      }
    }
    const result = hardwareMutationTail.then(run, run)
    hardwareMutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetStatus,
    async (event): Promise<HardwareStatusDto> => {
      const sequence = ++statusPollSequence
      const startedAt = performance.now()
      const previous = lastReturnedStatus
      if (pollDiagnosticsEnabled) {
        console.debug(`[hardware poll] status #${sequence} start at=${new Date().toISOString()} ` +
          `previous=${pollingStatusSummary(previous)}`)
      }
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        completedStatusSequence = sequence;
        lastConnectedStatus = null
        lastSuccessfulStatusAtMs = null
        consecutiveStatusFailures = 0
        lastReturnedStatus = gateway === null && unconfigured
          ? transportStatus('NOT_CONFIGURED') : offlineStatus()
        if (pollDiagnosticsEnabled) {
          console.debug(`[hardware poll] status #${sequence} skipped=unauthorized_or_unconfigured ` +
            `new=${pollingStatusSummary(lastReturnedStatus)}`)
        }
        return lastReturnedStatus
      }

      try {
        const status = await gateway.getStatus()
        if (sequence < completedStatusSequence) return lastReturnedStatus
        completedStatusSequence = sequence
        consecutiveStatusFailures = 0
        const nextStatus: HardwareStatusDto = {
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
          ...(status.offlineReady === undefined ? {} : { offlineReady: status.offlineReady }),
          ...(status.offlineJournalState === undefined ? {} : {
            offlineJournalState: status.offlineJournalState,
            offlineJournalReason: status.offlineJournalReason
          }),
          ...(status.offlineAckState === undefined
            ? {}
            : { offlineAckState: status.offlineAckState,
                offlineAckEventId: status.offlineAckEventId })
        }
        lastConnectedStatus = status.online ? nextStatus : null
        lastSuccessfulStatusAtMs = performance.now()
        lastReturnedStatus = nextStatus
        if (pollDiagnosticsEnabled) {
          console.debug(`[hardware poll] status #${sequence} end http=200 ` +
            `elapsedMs=${Math.round(performance.now() - startedAt)} ` +
            `new=${pollingStatusSummary(nextStatus)}`)
        }
        return nextStatus
      } catch (error) {
        if (sequence < completedStatusSequence) return lastReturnedStatus
        completedStatusSequence = sequence
        consecutiveStatusFailures += 1
        if (consecutiveStatusFailures <= 2) {
          console.warn(
            'ESP32 status request failed:',
            pollingFailureCode(error)
          )
        }
        if (lastConnectedStatus !== null && consecutiveStatusFailures === 1) {
          lastReturnedStatus = transportStatus('CHECKING', lastConnectedStatus)
        } else {
          lastReturnedStatus = transportStatus('OFFLINE', lastConnectedStatus)
        }
        if (pollDiagnosticsEnabled) {
          console.debug(`[hardware poll] status #${sequence} end result=${pollingFailureCode(error)} ` +
            `elapsedMs=${Math.round(performance.now() - startedAt)} ` +
            `lastGoodAgeMs=${lastSuccessfulStatusAtMs === null ? 'none' :
              Math.round(performance.now() - lastSuccessfulStatusAtMs)} ` +
            `new=${pollingStatusSummary(lastReturnedStatus)}`)
        }
        return lastReturnedStatus
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
        console.info('[Offline sync] stage=preview')
        return ok(await gateway.getNextOfflineEvent())
      } catch (error) {
        // Retrieval is non-destructive. A later request can safely retry either
        // a transport failure or a response rejected by the gateway validator.
        return failure({
          code: 'INTERNAL_ERROR',
          message: offlineSyncFailureMessage(error)
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
        } catch (error) {
          // Coordinator errors intentionally omit ESP32 URLs, journal payloads,
          // and SQLite diagnostics. All pre-ACK failures remain safe to retry.
          console.error('Offline synchronization IPC request failed internally.')
          return failure({
            code: 'INTERNAL_ERROR',
            message: error instanceof OfflineSyncCoordinatorError ? error.message :
              'Unable to synchronize offline transactions. No completion was assumed; retry is safe.'
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
      const sequence = ++eventPollSequence
      const startedAt = performance.now()
      if (pollDiagnosticsEnabled) {
        console.debug(`[hardware poll] event #${sequence} start at=${new Date().toISOString()} ` +
          `status=${lastReturnedStatus.connection}`)
      }
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        if (pollDiagnosticsEnabled) {
          console.debug(`[hardware poll] event #${sequence} skipped=unauthorized_or_unconfigured`)
        }
        return null
      }

      try {
        const pendingEvent = await gateway.getNextTransactionEvent()
        if (pollDiagnosticsEnabled) {
          console.debug(
            `[hardware poll] event #${sequence} end http=${pendingEvent === null ? 204 : 200} ` +
              `elapsedMs=${Math.round(performance.now() - startedAt)}`
          )
        }
        return pendingEvent
      } catch (error) {
        if (pollDiagnosticsEnabled) {
          console.debug(
            `[hardware poll] event #${sequence} end result=${pollingFailureCode(error)} ` +
              `elapsedMs=${Math.round(performance.now() - startedAt)}`
          )
        }
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

          let pendingEvent: HardwareTransactionEvent | null = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              pendingEvent = await gateway.getNextTransactionEvent()
              break
            } catch (error) {
              const category = gatewayFailureCategory(error)
              traceEventResolution('CANCEL', validatedEventId, null,
                category, false, false,
                error instanceof HardwareGatewayError ? error.httpStatus : undefined)
              if (attempt === 0 &&
                  (category === 'TRANSPORT_TIMEOUT' || category === 'NETWORK_FAILURE')) continue
              throw error
            }
          }
          if (pendingEvent === null) {
            // Do not let an uncommitted-cancellation retry dismiss a transaction
            // that crossed the durable commit boundary before the FIFO advanced.
            if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
              traceEventResolution('CANCEL', validatedEventId, null,
                'ALREADY_COMMITTED', true, false)
              return failure({
                code: 'VALIDATION_ERROR',
                message: 'This inventory transaction is already saved and must finish recovery.'
              })
            }

            // Cancellation/rejection is idempotent. A retry can arrive after the
            // ESP32 removed the event but its successful HTTP response was lost.
            traceEventResolution('CANCEL', validatedEventId, null,
              'NO_EVENT', false, false)
            return ok({ eventId: validatedEventId })
          }
          if (pendingEvent.eventId !== validatedEventId) {
            if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
              traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
                'ALREADY_COMMITTED', true, false)
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
              traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
                'ALREADY_RESOLVED', false, true)
              return ok({ eventId: validatedEventId })
            } catch (error) {
              const category = gatewayFailureCategory(error)
              traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
                category, false, false,
                error instanceof HardwareGatewayError ? error.httpStatus : undefined)
              if (!(error instanceof HardwareGatewayError) ||
                  error.diagnosticCode !== 'event_id_mismatch') throw error
              return failure({
                code: 'VALIDATION_ERROR',
                message: 'A different hardware scan is currently pending.'
              })
            }
          }

          traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
            'MATCH', false, false, undefined, pendingEvent.mode)
          let registeredProduct: ReturnType<InventoryService['findProductByBarcode']>
          try {
            registeredProduct = inventoryService.findProductByBarcode(pendingEvent.barcode)
          } catch (error) {
            traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
              'LOCAL_LOOKUP_FAILURE', false, false)
            throw error
          }

          // Explicit rejection/cancellation may discard only an event that has not
          // committed inventory work. Once a durable receipt exists, the event must
          // complete result delivery and acknowledgement through the coordinator.
          if (transactionCoordinator.getTransactionReceipt(validatedEventId) !== null) {
            traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
              'ALREADY_COMMITTED', true, false)
            return failure({
              code: 'VALIDATION_ERROR',
              message: registeredProduct === null
                ? 'This scan is already associated with a saved transaction.'
                : 'This inventory transaction is already saved and must finish recovery.'
            })
          }

          try {
            if (registeredProduct === null) {
              await gateway.acknowledgeTransactionEvent(validatedEventId, 'unknown_barcode')
            } else {
              await gateway.acknowledgeTransactionEvent(validatedEventId)
            }
          } catch (acknowledgementError: unknown) {
            const category = gatewayFailureCategory(acknowledgementError)
            traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
              category, false, false,
              acknowledgementError instanceof HardwareGatewayError
                ? acknowledgementError.httpStatus : undefined)
            // A response may be lost after the firmware retires the exact ID.
            // Its bounded recent-ACK receipt makes retrying that same ID safe;
            // never send an ACK for the newly visible FIFO head.
            if (category === 'TRANSPORT_TIMEOUT' || category === 'NETWORK_FAILURE') {
              try {
                await gateway.acknowledgeTransactionEvent(
                  validatedEventId,
                  registeredProduct === null ? 'unknown_barcode' : undefined
                )
                traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
                  'ALREADY_RESOLVED', false, true)
                return ok({ eventId: validatedEventId })
              } catch {
                // A read-only head check below determines whether to keep the
                // dialog open. It does not acknowledge any other event.
              }
            }
            // Resolve an ambiguous transport failure by reading the authoritative
            // FIFO head. If this event is gone, the ACK was applied and retrying is
            // safely treated as success. A transport failure or unchanged head
            // still preserves the dialog for another retry.
            const eventAfterAcknowledgement = await gateway.getNextTransactionEvent()
            if (
              eventAfterAcknowledgement === null ||
              eventAfterAcknowledgement.eventId !== validatedEventId
            ) {
              traceEventResolution('CANCEL', validatedEventId,
                eventAfterAcknowledgement?.eventId ?? null,
                'NO_LONGER_HEAD', false, false)
              return ok({ eventId: validatedEventId })
            }
            throw acknowledgementError
          }
          traceEventResolution('CANCEL', validatedEventId, pendingEvent.eventId,
            'MATCH', false, true)
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
        const validatedEventId = validateHardwareTransactionEventIdPayload(eventId)
        const startedAt = performance.now()
        const receipt = transactionCoordinator.getTransactionReceipt(validatedEventId)
        if (process.env.DENTAL_HARDWARE_TIMING_DEBUG === '1') {
          console.debug(
            `[hardware timing] local receipt lookup ${Math.round(performance.now() - startedAt)}ms`
          )
        }
        return ok(receipt)
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
          const validated = validateProcessHardwareTransactionInput(input)
          const alreadyCommitted =
            transactionCoordinator.getTransactionReceipt(validated.eventId) !== null
          const outcome = await transactionCoordinator.processTransaction(validated)
          scheduleOfflineCacheRefresh(!alreadyCommitted)
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
          scheduleOfflineCacheRefresh(false)
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
          scheduleOfflineCacheRefresh(false)
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
    disposed = true
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
