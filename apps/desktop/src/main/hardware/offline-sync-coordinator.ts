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
import { HardwareGatewayError } from './esp32-http-gateway'

export function offlineSyncFailureMessage(error: unknown): string {
  if (!(error instanceof HardwareGatewayError)) return 'The offline operation could not be confirmed. It is safe to retry.'
  if (error.diagnosticCode === 'REQUEST_TIMEOUT') return 'Pending transaction retrieval timed out. No completion was assumed; retry is safe.'
  if (error.httpStatus === 401 || error.httpStatus === 403) return 'Device authorization failed. Check Device Setup before retrying.'
  if (error.code === 'INVALID_RESPONSE') return 'The device returned an invalid offline response. No completion was assumed.'
  if (error.diagnosticCode && ['transaction_active', 'storage_recovering', 'foreground_wait',
      'temporarily_unavailable', 'cache_publication_in_progress', 'controller_busy',
      'offline_ack_in_progress'].includes(error.diagnosticCode))
    return `The device is temporarily busy (${error.diagnosticCode}). Wait and retry.`
  if (error.diagnosticCode === 'pending_journal_invalid') return 'The offline journal integrity check failed. Pending records were not skipped.'
  if (error.diagnosticCode === 'storage_transport_unavailable' || error.diagnosticCode === 'pending_journal_unavailable')
    return 'Local storage is temporarily unavailable. Pending records remain on the device; retry after recovery.'
  return 'The device connection failed during offline retrieval. No completion was assumed; retry is safe.'
}

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
  /** Test seam for the bounded delay after an ambiguous device ACK. */
  waitForAcknowledgementRecovery?: (milliseconds: number) => Promise<void>
  /** Test seams; production monitors one durable ACK for at most four minutes. */
  acknowledgementMonitorWindowMs?: number
  acknowledgementMonitorIntervalMs?: number
}

const MAX_OFFLINE_SYNC_EVENTS = 10_000
const ACK_RECOVERY_CHECKS = 3
const ACK_RECOVERY_DELAY_MS = 2_000
const ACK_MONITOR_WINDOW_MS = 240_000
const ACK_MONITOR_INTERVAL_MS = 2_000

type AckMonitorResult = 'succeeded' | 'failed' | 'mismatch' | 'idle' | 'legacy' | 'timed_out'

interface AcknowledgementResolution {
  acknowledged: boolean
  prefetchedHead?: OfflinePendingEvent | null
}

interface RetirementObservation extends AcknowledgementResolution {
  sameHead: boolean
}

function isLaterHead(eventId: string, headId: string): boolean {
  // The device ID must match; a different or earlier FIFO identity is not
  // evidence that this particular ACK was durably applied.
  return headId.slice(0, -16) === eventId.slice(0, -16) &&
    BigInt(`0x${headId.slice(-16)}`) > BigInt(`0x${eventId.slice(-16)}`)
}

function waitForRecovery(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
  const wait = options.waitForAcknowledgementRecovery ?? waitForRecovery
  const monitorWindowMs = options.acknowledgementMonitorWindowMs ?? ACK_MONITOR_WINDOW_MS
  const monitorIntervalMs = options.acknowledgementMonitorIntervalMs ?? ACK_MONITOR_INTERVAL_MS
  async function stage<T>(name: string, action: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      const result = await action()
      console.info(`[Offline sync] stage=${name} elapsedMs=${Math.round(performance.now() - started)} result=OK`)
      return result
    } catch (error) {
      console.warn(`[Offline sync] stage=${name} elapsedMs=${Math.round(performance.now() - started)} result=${safeAcknowledgementDiagnostic(error)}`)
      throw error
    }
  }
  if (!Number.isSafeInteger(monitorWindowMs) || monitorWindowMs <= 0 ||
      !Number.isSafeInteger(monitorIntervalMs) || monitorIntervalMs <= 0)
    throw new TypeError('The acknowledgement monitor timing must be positive integers.')

  async function monitorAcknowledgement(eventId: string): Promise<AckMonitorResult> {
    console.info('[Offline sync] stage=ack_confirmation')
    const deadline = Date.now() + monitorWindowMs
    const maxChecks = Math.ceil(monitorWindowMs / monitorIntervalMs) + 1
    for (let check = 0; check < maxChecks && Date.now() < deadline; check += 1) {
      try {
        const status = await stage('ack_status', () => options.gateway.getStatus())
        if (status.offlineAckState === undefined) return 'legacy'
        if (status.offlineAckState === 'IDLE') return 'idle'
        if (status.offlineAckEventId !== eventId) return 'mismatch'
        if (status.offlineAckState === 'SUCCEEDED') return 'succeeded'
        if (status.offlineAckState === 'FAILED') return 'failed'
        // QUEUED, RUNNING and VERIFYING are durable work in progress. In
        // particular, never issue a FatFs-backed FIFO preview in this state.
      } catch {
        // A single lightweight status timeout does not undo the SQLite commit.
      }
      if (check + 1 < maxChecks && Date.now() < deadline)
        await wait(Math.min(monitorIntervalMs, Math.max(0, deadline - Date.now())))
    }
    return 'timed_out'
  }

  function acknowledgementPending(eventId: string): OfflineSyncOutcome {
    return {
      status: 'ACKNOWLEDGEMENT_PENDING',
      counts: copyCounts(counts),
      eventId
    }
  }

  async function observeRetirement(eventId: string): Promise<RetirementObservation> {
    const head = await stage('ack_confirmation_head', () => options.gateway.getNextOfflineEvent())
    if (head !== null) {
      const advanced = isLaterHead(eventId, head.eventId)
      return {
        acknowledged: advanced,
        prefetchedHead: advanced ? head : undefined,
        sameHead: head.eventId === eventId
      }
    }
    // An empty preview alone is insufficient: corroborate it with the fresh
    // durable count before treating the exact event as retired.
    const status = await stage('ack_confirmation_count', () => options.gateway.getStatus())
    return {
      acknowledged: status.pendingSyncItems === 0,
      prefetchedHead: status.pendingSyncItems === 0 ? null : undefined,
      sameHead: false
    }
  }

  async function recoverAmbiguousAcknowledgement(
    eventId: string
  ): Promise<RetirementObservation> {
    for (let check = 0; check < ACK_RECOVERY_CHECKS; check += 1) {
      await wait(ACK_RECOVERY_DELAY_MS)
      try {
        const observation = await observeRetirement(eventId)
        // The firmware serves one synchronous HTTP handler at a time. A
        // returned same-head read proves the earlier ACK handler has finished
        // without retiring this event; more reads cannot improve that result.
        if (observation.acknowledged || observation.sameHead) return observation
      } catch (confirmationError: unknown) {
        const diagnostic = safeAcknowledgementDiagnostic(confirmationError)
        if (diagnostic !== 'UNAVAILABLE/offline_ack_in_progress') {
          console.error(`[Offline sync] ACK recovery read was not confirmed (${diagnostic}).`)
        }
      }
    }
    return { acknowledged: false, sameHead: false }
  }

  async function acknowledgeAndResolve(
    eventId: string,
    retryPending = false
  ): Promise<AcknowledgementResolution> {
    if (retryPending) {
      const monitored = await monitorAcknowledgement(eventId)
      if (monitored === 'succeeded') return { acknowledged: true }
      if (monitored === 'mismatch' || monitored === 'timed_out')
        return { acknowledged: false }
      // FAILED or IDLE permits the existing read-only FIFO check and an
      // ACK-only retry. Legacy firmware has no job status to inspect.
      // A previous HTTP timeout can leave the single-threaded device handler
      // finishing its durable rewrite. Inspect the exact FIFO identity before
      // considering another ACK; never send one while its outcome is unknown.
      try {
        const observation = await observeRetirement(eventId)
        if (observation.acknowledged) return observation
        if (!observation.sameHead) {
          const recovered = await recoverAmbiguousAcknowledgement(eventId)
          if (recovered.acknowledged) return recovered
          if (!recovered.sameHead) return { acknowledged: false }
        }
      } catch {
        const recovered = await recoverAmbiguousAcknowledgement(eventId)
        if (recovered.acknowledged) return recovered
        if (!recovered.sameHead) return { acknowledged: false }
      }
    }
    try {
      console.info('[Offline sync] stage=device_ack')
      await stage('device_ack', () => options.gateway.acknowledgeOfflineEvent(eventId))
      return { acknowledged: true }
    } catch (acknowledgementError: unknown) {
      const diagnostic = safeAcknowledgementDiagnostic(acknowledgementError)
      if (diagnostic === 'UNAVAILABLE/ACK_IN_PROGRESS') {
        console.info('[Offline sync] Device accepted the ACK; durable retirement is in progress.')
      } else {
        console.error(`[Offline sync] ACK delivery was not confirmed (${diagnostic}).`)
      }
      const monitored = await monitorAcknowledgement(eventId)
      if (monitored === 'succeeded') return { acknowledged: true }
      if (monitored === 'failed' || monitored === 'mismatch' ||
          monitored === 'timed_out') return { acknowledged: false }
      // Only idle/legacy firmware needs the prior read-only FIFO recovery.
      const recovered = await recoverAmbiguousAcknowledgement(eventId)
      if (recovered.acknowledged) return recovered
      return { acknowledged: false }
    }
  }

  async function refreshFinalCache(): Promise<OfflineSyncOutcome> {
    console.info('[Offline sync] stage=cache_refresh')
    try {
      const cache = await stage('cache_refresh', () => options.offlineInventoryCacheCoordinator.refresh())
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
      console.info('[Offline sync] stage=final_status')
      pendingSyncItems = (await stage('final_status', () => options.gateway.getStatus())).pendingSyncItems
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
      const resolution = await acknowledgeAndResolve(eventId, true)
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
          console.info('[Offline sync] stage=record_fetch')
          for (let attempt = 0; ; attempt += 1) {
            try { pendingEvent = await stage('record_fetch', () => options.gateway.getNextOfflineEvent()); break } catch (error) {
              if (attempt >= 2 || !(error instanceof HardwareGatewayError) ||
                  !['transaction_active', 'storage_recovering', 'foreground_wait',
                    'temporarily_unavailable', 'cache_publication_in_progress', 'offline_ack_in_progress',
                    'controller_busy'].includes(error.diagnosticCode ?? '')) throw error
              await wait(2_000)
            }
          }
        } catch (error) {
          throw new OfflineSyncCoordinatorError(
            'HARDWARE_UNAVAILABLE',
            offlineSyncFailureMessage(error)
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
        const started = performance.now()
        console.info('[Offline sync] stage=database_apply')
        reconciliation = options.inventoryService.reconcileOfflineEvent(pendingEvent)
        console.info('[Offline sync] stage=database_commit result=' + reconciliation.status +
          ` elapsedMs=${Math.round(performance.now() - started)}`)
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

    console.info('[Offline sync] SYNC START')
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
