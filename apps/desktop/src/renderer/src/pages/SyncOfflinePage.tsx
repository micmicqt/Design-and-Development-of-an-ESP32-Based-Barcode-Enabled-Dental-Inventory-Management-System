import { useEffect, useRef, useState } from 'react'
import type {
  OfflinePendingEvent,
  OfflineReconciliationReceipt
} from '../../../shared/ipc-contract'

type PendingPreviewState =
  | { state: 'loading' }
  | { state: 'loaded'; event: OfflinePendingEvent | null }
  | { state: 'unavailable' }

type ReconciliationState =
  | { state: 'idle' }
  | { state: 'applying' }
  | { state: 'applied'; receipt: OfflineReconciliationReceipt }
  | { state: 'already-applied'; receipt: OfflineReconciliationReceipt }
  | { state: 'conflict'; eventId: string; message: string }
  | { state: 'no-pending' }
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

function ReconciliationDetails({ receipt }: { receipt: OfflineReconciliationReceipt }) {
  return (
    <dl className="sync-offline-result-details" aria-label="Authoritative local result">
      <div>
        <dt>Item</dt>
        <dd>{receipt.itemName}</dd>
      </div>
      <div>
        <dt>Action</dt>
        <dd>
          {receipt.action} {formatSignedDelta(receipt.delta)}
        </dd>
      </div>
      <div>
        <dt>Event timestamp</dt>
        <dd>{receipt.timestamp}</dd>
      </div>
      <div>
        <dt>Authoritative SQLite stock</dt>
        <dd>
          {receipt.previousStock} → {receipt.newTotal}
        </dd>
      </div>
      <div>
        <dt>Authoritative status</dt>
        <dd>{receipt.status}</dd>
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
  const [reconciliation, setReconciliation] = useState<ReconciliationState>({ state: 'idle' })
  const reconciliationInFlight = useRef(false)

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

  async function reconcilePendingEvent(): Promise<void> {
    if (reconciliationInFlight.current) return

    reconciliationInFlight.current = true
    setReconciliation({ state: 'applying' })

    try {
      const result = await window.desktopApi.hardware.reconcileNextOfflineEvent()
      if (!result.ok) {
        setReconciliation({ state: 'error', message: result.error.message })
        return
      }

      switch (result.value.status) {
        case 'APPLIED':
          setReconciliation({ state: 'applied', receipt: result.value.receipt })
          return
        case 'ALREADY_APPLIED':
          setReconciliation({
            state: 'already-applied',
            receipt: result.value.receipt
          })
          return
        case 'CONFLICT':
          setReconciliation({
            state: 'conflict',
            eventId: result.value.conflict.eventId,
            message: result.value.conflict.message
          })
          return
        case 'NO_PENDING_EVENT':
          setPreview({ state: 'loaded', event: null })
          setReconciliation({ state: 'no-pending' })
      }
    } catch {
      setReconciliation({
        state: 'error',
        message: 'The local reconciliation result could not be confirmed.'
      })
    } finally {
      reconciliationInFlight.current = false
    }
  }

  return (
    <section className="sync-offline-page" aria-label="Offline reconciliation">
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
        <strong>Local application only</strong>
        <span>
          Reconciliation can apply the oldest pending event to SQLite once. Device
          acknowledgement is not available in this step, so the event remains pending on the
          ESP32.
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
            The device-reported stock is audit context, not the authoritative SQLite total.
            Applying or replaying this record locally does not retire it from the ESP32.
          </p>
          <div className="sync-offline-actions">
            <button
              className="primary-button primary-button--inline"
              type="button"
              disabled={reconciliation.state === 'applying'}
              onClick={() => void reconcilePendingEvent()}
            >
              {reconciliation.state === 'applying'
                ? 'Applying locally…'
                : 'Apply pending transaction locally'}
            </button>
          </div>
        </article>
      )}

      {reconciliation.state === 'applied' && (
        <div
          className="sync-offline-reconciliation-result is-success"
          role="status"
          aria-label="Local reconciliation result"
        >
          <strong>Applied locally</strong>
          <span>
            Event {reconciliation.receipt.eventId} was committed to SQLite and movement history
            exactly once.
          </span>
          <ReconciliationDetails receipt={reconciliation.receipt} />
          <b>Awaiting device acknowledgement</b>
          <span>
            The event remains pending on the ESP32. Applying it again verifies the durable local
            receipt without changing stock twice.
          </span>
        </div>
      )}

      {reconciliation.state === 'already-applied' && (
        <div
          className="sync-offline-reconciliation-result is-success"
          role="status"
          aria-label="Local reconciliation result"
        >
          <strong>Already applied locally</strong>
          <span>
            SQLite already has a matching durable receipt for event{' '}
            {reconciliation.receipt.eventId}. No stock or movement-history row was added by this
            replay.
          </span>
          <ReconciliationDetails receipt={reconciliation.receipt} />
          <b>Awaiting device acknowledgement</b>
          <span>The same event remains pending on the ESP32 until a later protocol step.</span>
        </div>
      )}

      {reconciliation.state === 'conflict' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline reconciliation problem"
        >
          <strong>Conflict or error</strong>
          <span>{reconciliation.message}</span>
          <span>
            Event {reconciliation.eventId} remains pending on the ESP32. No local inventory
            update was committed for this attempt.
          </span>
        </div>
      )}

      {reconciliation.state === 'error' && (
        <div
          className="sync-offline-reconciliation-result is-error"
          role="alert"
          aria-label="Offline reconciliation problem"
        >
          <strong>Conflict or error</strong>
          <span>{reconciliation.message}</span>
          <span>
            Retry is safe because the durable event receipt prevents duplicate local application.
            The ESP32 record has not been acknowledged.
          </span>
        </div>
      )}

      {reconciliation.state === 'no-pending' && (
        <div
          className="sync-offline-reconciliation-result"
          role="status"
          aria-label="Local reconciliation result"
        >
          <strong>No pending event to apply</strong>
          <span>The backend found no authoritative pending event, so no local update was attempted.</span>
        </div>
      )}
    </section>
  )
}
