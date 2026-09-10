import type {
  OfflinePendingEvent,
  OfflineSyncCounts,
  OfflineSyncOutcome
} from '../../shared/ipc-contract'
import {
  OfflineReconciliationConflictError,
  type OfflineReconciliationResult
} from '../inventory'
import type {
  Esp32StatusResponse,
  OfflineEventAcknowledgementGateway,
  OfflinePendingEventGateway
} from './hardware-gateway'
import type { OfflineInventoryCacheCoordinator } from './offline-inventory-cache'

export const OFFLINE_SYNC_COORDINATOR_ERROR_CODES = [
  'HARDWARE_UNAVAILABLE',
  'DATABASE_ERROR',
  'JOURNAL_NOT_EMPTY',
  'SYNC_LIMIT_REACHED'
] as const

export type OfflineSyncCoordinatorErrorCode =
  (typeof OFFLINE_SYNC_COORDINATOR_ERROR_CODES)[number]

export class OfflineSyncCoordinatorError extends Error {
  constructor(
    readonly code: OfflineSyncCoordinatorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfflineSyncCoordinatorError'
  }
}

export interface OfflineSyncInventoryService {
  reconcileOfflineEvent(event: OfflinePendingEvent): OfflineReconciliationResult
}

export interface OfflineSyncGateway
  extends OfflinePendingEventGateway,
    OfflineEventAcknowledgementGateway {
  getStatus(): Promise<Esp32StatusResponse>
}

export interface OfflineSyncCoordinator {
  /** Drains the firmware journal without accepting renderer-owned sync data. */
  synchronize(): Promise<OfflineSyncOutcome>
}

export interface CreateOfflineSyncCoordinatorOptions {
  inventoryService: OfflineSyncInventoryService
  gateway: OfflineSyncGateway
  offlineInventoryCacheCoordinator: OfflineInventoryCacheCoordinator
  /** Test seam; production permits the firmware journal's full bounded capacity. */
  maxEventsPerRun?: number
}

const MAX_OFFLINE_SYNC_EVENTS = 10_000

interface AcknowledgementResolution {
  acknowledged: boolean
  prefetchedHead?: OfflinePendingEvent | null
}

function safeAcknowledgementDiagnostic(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN_FAILURE'
  const candidate = error as { code?: unknown; diagnosticCode?: unknown }
  const code = typeof candidate.code === 'string' ? candidate.code : 'UNKNOWN_FAILURE'
  const diagnosticCode =
    typeof candidate.diagnosticCode === 'string' ? candidate.diagnosticCode : null
  return diagnosticCode === null ? code : `${code}/${diagnosticCode}`
}

function emptyCounts(): OfflineSyncCounts {
  return {
    appliedEvents: 0,
    alreadyAppliedEvents: 0,
    acknowledgedEvents: 0
  }
}

function copyCounts(counts: OfflineSyncCounts): OfflineSyncCounts {
  return { ...counts }
}

/**
 * Owns the complete Phase 7 offline pipeline. A caller can only signal "sync";
 * FIFO identities, event bodies, SQLite values, URLs, and cache rows all remain
 * behind the main-process boundary.
 */
export function createOfflineSyncCoordinator(
  options: CreateOfflineSyncCoordinatorOptions
): OfflineSyncCoordinator {
  const maxEventsPerRun = options.maxEventsPerRun ?? MAX_OFFLINE_SYNC_EVENTS
  if (
    !Number.isSafeInteger(maxEventsPerRun) ||
    maxEventsPerRun <= 0 ||
    maxEventsPerRun > MAX_OFFLINE_SYNC_EVENTS
  ) {
    throw new TypeError('The offline sync event limit must be an integer from 1 through 10000.')
  }

  let activeSynchronization: Promise<OfflineSyncOutcome> | null = null
  let counts = emptyCounts()
  let pendingAcknowledgementEventId: string | null = null
  let cacheRefreshPending = false

  function acknowledgementPending(eventId: string): OfflineSyncOutcome {
    return {
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: copyCounts(counts),
      eventId
    }
  }

  async function acknowledgeAndResolve(
    eventId: string
  ): Promise<AcknowledgementResolution> {
    try {
      await options.gateway.acknowledgeOfflineEvent(eventId)
      return { acknowledged: true }
    } catch (acknowledgementError: unknown) {
      console.error(
        `[Offline sync] ACK delivery was not confirmed (${safeAcknowledgementDiagnostic(acknowledgementError)}).`
      )
      // The firmware can durably retire the head before the HTTP response is
      // lost. Re-read the authoritative head: only the identical event proves
      // that acknowledgement is still pending. A different head proves this
      // event was retired without ever risking the new head.
      try {
        const head = await options.gateway.getNextOfflineEvent()
        if (head !== null && head.eventId !== eventId) {
          return { acknowledged: true, prefetchedHead: head }
        }
        if (head === null) {
          // An empty-head response is authoritative only when independently
          // corroborated by the fresh durable journal count. Preserve ACK-only
          // recovery when those two firmware views disagree.
          const status = await options.gateway.getStatus()
          if (status.pendingSyncItems === 0) {
            return { acknowledged: true, prefetchedHead: null }
          }
        }
      } catch (confirmationError: unknown) {
        console.error(
          `[Offline sync] ACK recovery read was not confirmed (${safeAcknowledgementDiagnostic(confirmationError)}).`
        )
        // With neither an ACK receipt nor an authoritative head, retain ACK-only
        // recovery state for the next invocation.
      }
      return { acknowledged: false }
    }
  }

  async function refreshFinalCache(): Promise<OfflineSyncOutcome> {
    try {
      const cache = await options.offlineInventoryCacheCoordinator.refresh()
      const outcome: OfflineSyncOutcome = {
        status: 'COMPLETE',
        counts: copyCounts(counts),
        pendingSyncItems: 0,
        cache: {
          generation: cache.generation,
          itemCount: cache.itemCount,
          alreadyCurrent: cache.alreadyCurrent
        }
      }
      counts = emptyCounts()
      cacheRefreshPending = false
      return outcome
    } catch {
      cacheRefreshPending = true
      return {
        status: 'CACHE_REFRESH_FAILED',
        counts: copyCounts(counts),
        pendingSyncItems: 0
      }
    }
  }

  async function confirmEmptyJournalAndRefresh(): Promise<OfflineSyncOutcome> {
    let pendingSyncItems: number | undefined
    try {
      pendingSyncItems = (await options.gateway.getStatus()).pendingSyncItems
    } catch {
      throw new OfflineSyncCoordinatorError(
        'HARDWARE_UNAVAILABLE',
        'The offline journal status could not be confirmed.'
      )
    }

    if (pendingSyncItems !== 0) {
      throw new OfflineSyncCoordinatorError(
        'JOURNAL_NOT_EMPTY',
        'The offline journal did not report an authoritative empty state.'
      )
    }

    cacheRefreshPending = true
    return refreshFinalCache()
  }

  async function runSynchronization(): Promise<OfflineSyncOutcome> {
    // A failed final cache install is downstream of a fully drained journal.
    // Retrying it must never retrieve, reconcile, or acknowledge an event again.
    if (cacheRefreshPending) return refreshFinalCache()

    let prefetchedHead: OfflinePendingEvent | null | undefined

    if (pendingAcknowledgementEventId !== null) {
      const eventId = pendingAcknowledgementEventId
      const resolution = await acknowledgeAndResolve(eventId)
      if (!resolution.acknowledged) return acknowledgementPending(eventId)

      counts.acknowledgedEvents += 1
      pendingAcknowledgementEventId = null
      prefetchedHead = resolution.prefetchedHead
    }

    let reconciledThisRun = 0
    while (true) {
      let pendingEvent: OfflinePendingEvent | null
      if (prefetchedHead !== undefined) {
        pendingEvent = prefetchedHead
        prefetchedHead = undefined
      } else {
        try {
          pendingEvent = await options.gateway.getNextOfflineEvent()
        } catch {
          throw new OfflineSyncCoordinatorError(
            'HARDWARE_UNAVAILABLE',
            'The next offline journal event could not be retrieved.'
          )
        }
      }

      if (pendingEvent === null) return confirmEmptyJournalAndRefresh()
      if (reconciledThisRun >= maxEventsPerRun) {
        throw new OfflineSyncCoordinatorError(
          'SYNC_LIMIT_REACHED',
          'The bounded offline synchronization pass reached its event limit.'
        )
      }

      let reconciliation: OfflineReconciliationResult
      try {
        reconciliation = options.inventoryService.reconcileOfflineEvent(pendingEvent)
      } catch (error: unknown) {
        if (error instanceof OfflineReconciliationConflictError) {
          return {
            status: 'CONFLICT',
            counts: copyCounts(counts),
            conflict: {
              code: error.code,
              message: error.message,
              eventId: error.eventId
            }
          }
        }
        throw new OfflineSyncCoordinatorError(
          'DATABASE_ERROR',
          'The offline event could not be durably reconciled.'
        )
      }

      reconciledThisRun += 1
      if (reconciliation.status === 'APPLIED') counts.appliedEvents += 1
      else counts.alreadyAppliedEvents += 1

      // InventoryService returns only after its transaction and replay receipt
      // are durable. No conflict or database error can reach this ACK boundary.
      pendingAcknowledgementEventId = pendingEvent.eventId
      const resolution = await acknowledgeAndResolve(pendingEvent.eventId)
      if (!resolution.acknowledged) {
        return acknowledgementPending(pendingEvent.eventId)
      }

      counts.acknowledgedEvents += 1
      pendingAcknowledgementEventId = null
      prefetchedHead = resolution.prefetchedHead
    }
  }

  function synchronize(): Promise<OfflineSyncOutcome> {
    if (activeSynchronization !== null) return activeSynchronization

    const request = runSynchronization()
    activeSynchronization = request
    void request.then(
      () => {
        if (activeSynchronization === request) activeSynchronization = null
      },
      () => {
        if (activeSynchronization === request) activeSynchronization = null
      }
    )
    return request
  }

  return { synchronize }
}
