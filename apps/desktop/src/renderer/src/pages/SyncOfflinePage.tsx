import { useEffect, useRef, useState } from 'react'
import type {
  OfflinePendingEvent,
  OfflineSyncCounts,
  OfflineSyncOutcome,
  OfflineJournalState
} from '../../../shared/ipc-contract'

type PendingPreviewState =
  | { state: 'loading' }
  | { state: 'loaded'; event: OfflinePendingEvent | null }
  | { state: 'unavailable'; message?: string }

type SynchronizationState =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'finished'; outcome: OfflineSyncOutcome }
  | { state: 'error'; message: string }

function formatPendingCount(pendingCount: number | undefined): string {
  return pendingCount === undefined ? 'Not reported' : String(pendingCount)
}

function formatOfflineReadiness(offlineReady: boolean | undefined,
                                journalState?: OfflineJournalState): string {
  if (journalState === 'ready' || journalState === 'empty') return 'Ready'
  if (journalState === 'recovering') return 'Recovering'
  if (journalState === 'temporarily_unavailable') return 'Temporarily unavailable'
  if (journalState === 'corrupt') return 'Integrity check failed'
  if (journalState === 'full') return 'Full — synchronize pending records'
  if (journalState === 'generation_mismatch') return 'Inventory snapshot mismatch'
  if (offlineReady === undefined) return 'Not reported'
  return offlineReady ? 'Ready' : 'Not ready'
}

function formatSignedDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}

function SyncCounts({ counts }: { counts: OfflineSyncCounts }) {
  return (
    <dl className="sync-offline-result-details" aria-label="Synchronization progress">
      <div>
        <dt>Applied now</dt>
        <dd>{counts.appliedEvents}</dd>
      </div>
      <div>
        <dt>Already applied</dt>
        <dd>{counts.alreadyAppliedEvents}</dd>
      </div>
      <div>
        <dt>Acknowledged</dt>
        <dd>{counts.acknowledgedEvents}</dd>
      </div>
    </dl>
  )
}

export function SyncOfflinePage({
  pendingCount,
  offlineReady,
  offlineJournalState,
  offlineAckState
}: {
  pendingCount: number | undefined
  offlineReady: boolean | undefined
  offlineJournalState?: OfflineJournalState
  offlineAckState?: 'IDLE' | 'QUEUED' | 'RUNNING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED'
}) {
  const [preview, setPreview] = useState<PendingPreviewState>({ state: 'loading' })
  const [synchronization, setSynchronization] = useState<SynchronizationState>({ state: 'idle' })
  const [finishingAcknowledgement, setFinishingAcknowledgement] = useState(false)
  const synchronizationInFlight = useRef(false)
  const previewGeneration = useRef(0)
  // Display-only observation, never supplied as an authorization/count to IPC.
  const lastJournal = useRef({ pendingCount, offlineReady, offlineJournalState })
  useEffect(() => {
    if (pendingCount !== undefined || offlineJournalState !== undefined)
      lastJournal.current = { pendingCount, offlineReady, offlineJournalState }
  }, [pendingCount, offlineReady, offlineJournalState])
  const journal = pendingCount === undefined && offlineJournalState === undefined
    ? lastJournal.current : { pendingCount, offlineReady, offlineJournalState }
  const journalIsLastKnown = journal !== undefined && pendingCount === undefined &&
    offlineJournalState === undefined && lastJournal.current.pendingCount !== undefined

  useEffect(() => {
    if (synchronizationInFlight.current) return undefined
    let active = true
    const generation = ++previewGeneration.current

    void window.desktopApi.hardware
      .getNextOfflineEvent()
      .then((result) => {
        if (!active || generation !== previewGeneration.current) return
        setPreview(result.ok ? { state: 'loaded', event: result.value } :
          { state: 'unavailable', message: result.error.message })
      })
      .catch(() => {
        if (active && generation === previewGeneration.current) setPreview({ state: 'unavailable' })
      })

    return () => {
      active = false
    }
  }, [offlineJournalState, pendingCount])

  useEffect(() => {
    if (synchronization.state !== 'syncing') return undefined
    let active = true
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const status = await window.desktopApi.hardware.getStatus()
        if (!active) return
        const expectedId = preview.state === 'loaded' ? preview.event?.eventId : undefined
        if (status.offlineAckEventId === expectedId) {
          setFinishingAcknowledgement(
            status.offlineAckState === 'QUEUED' ||
            status.offlineAckState === 'RUNNING' ||
            status.offlineAckState === 'VERIFYING'
          )
        }
      } catch {
        // Keep the last in-progress message through a transient status loss.
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [synchronization.state, preview])

  async function synchronizeOfflineInventory(): Promise<void> {
    if (synchronizationInFlight.current) return

    synchronizationInFlight.current = true
    ++previewGeneration.current
    setFinishingAcknowledgement(false)
    setSynchronization({ state: 'syncing' })

    try {
      const result = await window.desktopApi.hardware.synchronizeOfflineInventory()
      if (!result.ok) {
        setSynchronization({ state: 'error', message: result.error.message })
        return
      }

      setSynchronization({ state: 'finished', outcome: result.value })
      if (result.value.status === 'COMPLETE' || result.value.status === 'CACHE_REFRESH_FAILED') {
        lastJournal.current = { pendingCount: 0, offlineReady,
          offlineJournalState: 'empty' }
        setPreview({ state: 'loaded', event: null })
      }
    } catch {
      setSynchronization({
        state: 'error',
        message: 'Offline synchronization could not be confirmed. It is safe to retry.'
      })
    } finally {
      synchronizationInFlight.current = false
      setFinishingAcknowledgement(false)
    }
  }

  const finishedOutcome = synchronization.state === 'finished' ? synchronization.outcome : null
  const displayedPendingCount =
    journal.offlineJournalState !== undefined
      ? journal.pendingCount
      : finishedOutcome?.status === 'COMPLETE' || finishedOutcome?.status === 'CACHE_REFRESH_FAILED'
      ? 0
      : journal.pendingCount
  const retryingCacheOnly = finishedOutcome?.status === 'CACHE_REFRESH_FAILED'
  const kioskAcknowledgementActive = offlineAckState === 'QUEUED' ||
    offlineAckState === 'RUNNING' || offlineAckState === 'VERIFYING'

  return (
    <section className="sync-offline-page" aria-label="Offline synchronization">
      <div className="sync-offline-summary" aria-label="Offline journal status">
        <div>
          <span>Pending records</span>
          <strong>{formatPendingCount(displayedPendingCount)}</strong>
        </div>
        <div>
          <span>Offline journal</span>
          <strong>{formatOfflineReadiness(journal.offlineReady, journal.offlineJournalState)}</strong>
        </div>
      </div>
      {journalIsLastKnown && <p role="status">Last known journal status. Current refresh unavailable; synchronization rechecks the device.</p>}

      <div className="sync-offline-notice" role="status">
        <strong>Safe, sequential synchronization</strong>
        <span>
          Pending kiosk transactions are applied to SQLite and acknowledged one at a time. The
          authoritative offline cache is refreshed only after every pending record is retired.
        </span>
      </div>

      {preview.state === 'loading' && (
        <p className="sync-offline-message">Reading the oldest pending transaction…</p>
      )}

      {preview.state === 'unavailable' && (
        <div className="sync-offline-message" role="alert">
          <strong>Pending transaction preview is unavailable.</strong>
          <span>
            {synchronization.state === 'syncing' || kioskAcknowledgementActive
              ? 'The kiosk is finishing device acknowledgement; no conclusion is drawn from the preview.'
              : preview.message ?? 'Retry the preview.'}
          </span>
          <span>No pending record is acknowledged by this preview.</span>
        </div>
      )}

      {preview.state === 'loaded' && preview.event === null && (
        <div className="sync-offline-message">
          <h3>No pending kiosk transaction is visible.</h3>
          <span>
            Synchronization will verify that the device count is zero before refreshing its
            authoritative inventory cache.
          </span>
        </div>
      )}

      {preview.state === 'loaded' && preview.event !== null && (
        <article className="sync-offline-event" aria-labelledby="next-offline-event-title">
          <header>
            <div>
              <span>Oldest pending transaction</span>
              <h3 id="next-offline-event-title">{preview.event.eventId}</h3>
            </div>
            <strong>Pending on ESP32</strong>
          </header>
          <dl className="sync-offline-details">
            <div>
              <dt>Timestamp</dt>
              <dd>{preview.event.timestamp}</dd>
            </div>
            <div>
              <dt>Product ID</dt>
              <dd>{preview.event.productId}</dd>
            </div>
            <div>
              <dt>Barcode</dt>
              <dd>{preview.event.barcode}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>{preview.event.action}</dd>
            </div>
            <div>
              <dt>Signed delta</dt>
              <dd>{formatSignedDelta(preview.event.delta)}</dd>
            </div>
            <div>
              <dt>Offline resulting stock</dt>
              <dd>{preview.event.resultingStock}</dd>
            </div>
            <div>
              <dt>Offline stock status</dt>
              <dd>{preview.event.stockStatus}</dd>
            </div>
            <div>
              <dt>Cache generation</dt>
              <dd>{preview.event.cacheGeneration}</dd>
            </div>
          </dl>
          <p>
            Device stock remains audit context. SQLite derives the authoritative result from its
            current stock and the signed transaction delta.
          </p>
        </article>
      )}

      <div className="sync-offline-actions">
        <button
          className="primary-button primary-button--inline"
          type="button"
          disabled={synchronization.state === 'syncing' || kioskAcknowledgementActive}
          onClick={() => void synchronizeOfflineInventory()}
        >
          {synchronization.state === 'syncing'
            ? 'Synchronizing…'
            : retryingCacheOnly
              ? 'Retry cache refresh'
              : preview.state === 'loaded' && preview.event === null
                ? 'Verify and refresh cache'
                : 'Synchronize offline transactions'}
        </button>
      </div>

      {synchronization.state === 'syncing' && (
        <div className="sync-offline-reconciliation-result" role="status">
          <strong>{finishingAcknowledgement
            ? 'Finishing device acknowledgement'
            : 'Reconciling inventory'}</strong>
          <span>{finishingAcknowledgement
            ? 'The inventory change is saved. The kiosk is securely updating its offline journal.'
            : 'Processing one event at a time: local commit, device acknowledgement, then retirement.'}</span>
        </div>
      )}

      {finishedOutcome?.status === 'COMPLETE' && (
        <div
          className="sync-offline-reconciliation-result is-success"
          role="status"
          aria-label="Offline synchronization result"
        >
          <strong>Sync Complete</strong>
          <span>
            Every pending transaction was reconciled and acknowledged, the device reports zero
            pending records, and its authoritative inventory cache is current.
          </span>
          <SyncCounts counts={finishedOutcome.counts} />
          <b>Cache refreshed</b>
          <span>
            {finishedOutcome.cache.itemCount} active item(s) · generation{' '}
            {finishedOutcome.cache.generation}
          </span>
        </div>
      )}

      {finishedOutcome?.status === 'CONFLICT' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline synchronization problem"
        >
          <strong>Synchronization stopped at a conflict</strong>
          <span>{finishedOutcome.conflict.message}</span>
          <span>
            Event {finishedOutcome.conflict.eventId} remains the pending FIFO head. It was not
            acknowledged or skipped.
          </span>
          <SyncCounts counts={finishedOutcome.counts} />
        </div>
      )}

      {finishedOutcome?.status === 'ACKNOWLEDGEMENT_PENDING' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline synchronization problem"
        >
          <strong>Inventory saved; device acknowledgement pending</strong>
          <span>
            Event {finishedOutcome.eventId} is durably recorded in SQLite, but retirement on the
            kiosk could not be confirmed.
          </span>
          <span>Retrying will acknowledge this event without applying its inventory change again.</span>
          <SyncCounts counts={finishedOutcome.counts} />
        </div>
      )}

      {finishedOutcome?.status === 'CACHE_REFRESH_FAILED' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline synchronization problem"
        >
          <strong>Transactions synchronized; cache refresh pending</strong>
          <span>
            All journal events were safely retired and the kiosk reports zero pending records, but
            the final authoritative cache installation did not finish.
          </span>
          <span>Retrying performs the cache refresh only; retired events are not replayed.</span>
          <SyncCounts counts={finishedOutcome.counts} />
        </div>
      )}

      {synchronization.state === 'error' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline synchronization problem"
        >
          <strong>Synchronization paused</strong>
          <span>{synchronization.message}</span>
          <span>No completion was assumed. Retry after checking the kiosk connection.</span>
        </div>
      )}
    </section>
  )
}
