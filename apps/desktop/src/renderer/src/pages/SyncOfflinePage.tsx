import { useEffect, useRef, useState } from 'react'
import type {
  OfflinePendingEvent,
  OfflineSyncCounts,
  OfflineSyncOutcome
} from '../../../shared/ipc-contract'

type PendingPreviewState =
  | { state: 'loading' }
  | { state: 'loaded'; event: OfflinePendingEvent | null }
  | { state: 'unavailable' }

type SynchronizationState =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'finished'; outcome: OfflineSyncOutcome }
  | { state: 'error'; message: string }

function formatPendingCount(pendingCount: number | undefined): string {
  return pendingCount === undefined ? 'Not reported' : String(pendingCount)
}

function formatOfflineReadiness(offlineReady: boolean | undefined): string {
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
  offlineReady
}: {
  pendingCount: number | undefined
  offlineReady: boolean | undefined
}) {
  const [preview, setPreview] = useState<PendingPreviewState>({ state: 'loading' })
  const [synchronization, setSynchronization] = useState<SynchronizationState>({ state: 'idle' })
  const synchronizationInFlight = useRef(false)

  useEffect(() => {
    let active = true

    void window.desktopApi.hardware
      .getNextOfflineEvent()
      .then((result) => {
        if (!active) return
        setPreview(result.ok ? { state: 'loaded', event: result.value } : { state: 'unavailable' })
      })
      .catch(() => {
        if (active) setPreview({ state: 'unavailable' })
      })

    return () => {
      active = false
    }
  }, [])

  async function synchronizeOfflineInventory(): Promise<void> {
    if (synchronizationInFlight.current) return

    synchronizationInFlight.current = true
    setSynchronization({ state: 'syncing' })

    try {
      const result = await window.desktopApi.hardware.synchronizeOfflineInventory()
      if (!result.ok) {
        setSynchronization({ state: 'error', message: result.error.message })
        return
      }

      setSynchronization({ state: 'finished', outcome: result.value })
      if (result.value.status === 'COMPLETE' || result.value.status === 'CACHE_REFRESH_FAILED') {
        setPreview({ state: 'loaded', event: null })
      }
    } catch {
      setSynchronization({
        state: 'error',
        message: 'Offline synchronization could not be confirmed. It is safe to retry.'
      })
    } finally {
      synchronizationInFlight.current = false
    }
  }

  const finishedOutcome = synchronization.state === 'finished' ? synchronization.outcome : null
  const displayedPendingCount =
    finishedOutcome?.status === 'COMPLETE' || finishedOutcome?.status === 'CACHE_REFRESH_FAILED'
      ? 0
      : pendingCount
  const retryingCacheOnly = finishedOutcome?.status === 'CACHE_REFRESH_FAILED'

  return (
    <section className="sync-offline-page" aria-label="Offline synchronization">
      <div className="sync-offline-summary" aria-label="Offline journal status">
        <div>
          <span>Pending records</span>
          <strong>{formatPendingCount(displayedPendingCount)}</strong>
        </div>
        <div>
          <span>Offline journal</span>
          <strong>{formatOfflineReadiness(offlineReady)}</strong>
        </div>
      </div>

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
            Reconnect the kiosk and retry. No pending record is acknowledged by this preview.
          </span>
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
          disabled={synchronization.state === 'syncing'}
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
          <strong>Synchronization in progress</strong>
          <span>
            Processing one event at a time: local commit, device acknowledgement, then retirement.
          </span>
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
