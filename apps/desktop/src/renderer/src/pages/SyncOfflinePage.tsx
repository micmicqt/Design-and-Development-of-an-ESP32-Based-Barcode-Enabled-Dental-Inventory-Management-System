import { useEffect, useState } from 'react'
import type { OfflinePendingEvent } from '../../../shared/ipc-contract'

type PendingPreviewState =
  | { state: 'loading' }
  | { state: 'loaded'; event: OfflinePendingEvent | null }
  | { state: 'unavailable' }

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

export function SyncOfflinePage({
  pendingCount,
  offlineReady
}: {
  pendingCount: number | undefined
  offlineReady: boolean | undefined
}) {
  const [preview, setPreview] = useState<PendingPreviewState>({ state: 'loading' })

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

  return (
    <section className="sync-offline-page" aria-label="Offline sync transport preview">
      <div className="sync-offline-summary" aria-label="Offline journal status">
        <div>
          <span>Pending records</span>
          <strong>{formatPendingCount(pendingCount)}</strong>
        </div>
        <div>
          <span>Offline journal</span>
          <strong>{formatOfflineReadiness(offlineReady)}</strong>
        </div>
      </div>

      <div className="sync-offline-notice" role="status">
        <strong>Inspection only</strong>
        <span>
          Synchronization has not been executed. No record has been applied to SQLite,
          acknowledged, or removed from the ESP32.
        </span>
      </div>

      {preview.state === 'loading' && (
        <p className="sync-offline-message">Reading the oldest pending transaction…</p>
      )}

      {preview.state === 'unavailable' && (
        <div className="sync-offline-message" role="alert">
          <strong>Pending transaction preview is unavailable.</strong>
          <span>
            The request is safe to retry after reconnecting. No pending record was changed.
          </span>
        </div>
      )}

      {preview.state === 'loaded' && preview.event === null && (
        <div className="sync-offline-message">
          <h3>No pending transaction is available.</h3>
          <span>The ESP32 returned an empty transport response.</span>
        </div>
      )}

      {preview.state === 'loaded' && preview.event !== null && (
        <article className="sync-offline-event" aria-labelledby="next-offline-event-title">
          <header>
            <div>
              <span>Oldest pending transaction</span>
              <h3 id="next-offline-event-title">{preview.event.eventId}</h3>
            </div>
            <strong>Still pending</strong>
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
              <dt>Resulting stock</dt>
              <dd>{preview.event.resultingStock}</dd>
            </div>
            <div>
              <dt>Resulting status</dt>
              <dd>{preview.event.stockStatus}</dd>
            </div>
            <div>
              <dt>Cache generation</dt>
              <dd>{preview.event.cacheGeneration}</dd>
            </div>
          </dl>
          <p>
            Reading this record does not retire it. Repeated reads return the same oldest
            pending transaction until a future synchronization step acknowledges it.
          </p>
        </article>
      )}
    </section>
  )
}
