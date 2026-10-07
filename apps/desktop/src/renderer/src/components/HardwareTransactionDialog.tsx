import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  HardwareTransactionEvent,
  HardwareTransactionReceipt,
  IpcResult,
  ProductDto
} from '../../../shared/ipc-contract'
import { MAX_TRANSACTION_QUANTITY, validateTransactionQuantity } from '../../../shared/transaction-quantity'
import clinicLogo from '../assets/branding/any-time-dental-logo.png'
import { ProductImage } from './ProductImage'
import { StockStatusBadge } from './StockStatusBadge'

type ProductLookup =
  | { state: 'loading' }
  | { state: 'known'; product: ProductDto }
  | { state: 'unknown' }
  | { state: 'error' }

const ACKNOWLEDGEMENT_ERROR =
  'Inventory was updated, but the ESP32 has not acknowledged this transaction. Retry acknowledgement only; do not submit it again.'

const RESULT_DELIVERY_ERROR =
  'Inventory was updated, but the transaction result has not reached the ESP32. Retry result delivery only; do not submit it again.'

const RECEIPT_CHECK_ERROR =
  'Could not verify whether this transaction was already saved. Retry before continuing.'

function pendingDeliveryMessage(receipt: HardwareTransactionReceipt): string {
  return receipt.resultDeliveredToHardware ? ACKNOWLEDGEMENT_ERROR : RESULT_DELIVERY_ERROR
}

function receiptMatchesEvent(
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

export function HardwareTransactionDialog({
  event,
  open,
  acknowledging,
  acknowledgementError,
  onReject,
  onCancel,
  onReviewLater,
  onCommitted,
  onCompleted
}: {
  event: HardwareTransactionEvent
  open: boolean
  acknowledging: boolean
  acknowledgementError: string | null
  onReject: () => void
  onCancel: () => void
  onReviewLater: () => void
  onCommitted: (receipt: HardwareTransactionReceipt) => void
  onCompleted: (receipt: HardwareTransactionReceipt) => void
}) {
  const [lookup, setLookup] = useState<ProductLookup>({ state: 'loading' })
  const [retryVersion, setRetryVersion] = useState(0)
  const [checkingReceipt, setCheckingReceipt] = useState(true)
  const [receiptCheckError, setReceiptCheckError] = useState<string | null>(null)
  const [quantity, setQuantity] = useState('')
  const [quantityError, setQuantityError] = useState<string | null>(null)
  const [transactionError, setTransactionError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<HardwareTransactionReceipt | null>(null)
  const [processing, setProcessing] = useState(false)
  const [retryingResultDelivery, setRetryingResultDelivery] = useState(false)
  const [retryingAcknowledgement, setRetryingAcknowledgement] = useState(false)
  const dialog = useRef<HTMLElement | null>(null)
  const requestVersion = useRef(0)
  const processingInFlight = useRef(false)
  const resultDeliveryRetryInFlight = useRef(false)
  const acknowledgementRetryInFlight = useRef(false)
  const lookupTail = useRef<Promise<IpcResult<ProductDto | null> | undefined>>(Promise.resolve(undefined))

  useEffect(() => {
    if (open && import.meta.env.DEV &&
        window.sessionStorage.getItem('dentalHardwareTiming') === '1') {
      console.debug('[hardware timing] transaction modal mounted', new Date().toISOString())
    }
  }, [open, event.eventId])

  const queueLookup = useCallback((isCurrent: () => boolean) => {
    const request = lookupTail.current.catch(() => undefined).then(() => {
      if (!isCurrent()) return undefined
      return window.desktopApi.inventory.findProductByBarcode(event.barcode)
    })
    lookupTail.current = request
    return request
  }, [event.barcode])

  const rememberCommittedReceipt = useCallback((committedReceipt: HardwareTransactionReceipt) => {
    setReceipt(committedReceipt)
    onCommitted(committedReceipt)
  }, [onCommitted])

  useEffect(() => {
    const version = ++requestVersion.current
    if (!open) return undefined
    let active = true
    const isCurrent = () => active && requestVersion.current === version

    setCheckingReceipt(true)
    setReceiptCheckError(null)
    setQuantityError(null)
    setTransactionError(null)
    setProcessing(false)
    setRetryingResultDelivery(false)
    setRetryingAcknowledgement(false)
    processingInFlight.current = false
    resultDeliveryRetryInFlight.current = false
    acknowledgementRetryInFlight.current = false

    void (async () => {
      let receiptResult: IpcResult<HardwareTransactionReceipt | null>
      try {
        receiptResult = await window.desktopApi.hardware.getTransactionReceipt(event.eventId)
      } catch {
        if (isCurrent()) setReceiptCheckError(RECEIPT_CHECK_ERROR)
        return
      }

      if (!isCurrent()) return
      if (!receiptResult.ok) {
        setReceiptCheckError(RECEIPT_CHECK_ERROR)
        return
      }

      if (receiptResult.value !== null) {
        if (!receiptMatchesEvent(receiptResult.value, event)) {
          setReceiptCheckError(
            'The saved transaction does not match this scan. Processing is locked for safety.'
          )
          return
        }
        rememberCommittedReceipt(receiptResult.value)
        setTransactionError(pendingDeliveryMessage(receiptResult.value))
        return
      }

      setReceipt(null)
      setLookup({ state: 'loading' })
      setCheckingReceipt(false)
      try {
        const lookupResult = await queueLookup(isCurrent)
        if (!isCurrent() || lookupResult === undefined) return
        if (!lookupResult.ok) setLookup({ state: 'error' })
        else if (lookupResult.value === null) setLookup({ state: 'unknown' })
        else setLookup({ state: 'known', product: lookupResult.value })
      } catch {
        if (isCurrent()) setLookup({ state: 'error' })
      }
    })().finally(() => {
      if (isCurrent()) setCheckingReceipt(false)
    })

    return () => {
      active = false
      requestVersion.current += 1
    }
  }, [event.eventId, open, queueLookup, rememberCommittedReceipt, retryVersion])

  async function recoverAfterUncertainProcess(failureMessage: string): Promise<void> {
    try {
      const receiptResult = await window.desktopApi.hardware.getTransactionReceipt(event.eventId)
      if (!receiptResult.ok) {
        setReceiptCheckError(RECEIPT_CHECK_ERROR)
        return
      }

      if (receiptResult.value === null) {
        setTransactionError(failureMessage)
        return
      }

      if (!receiptMatchesEvent(receiptResult.value, event)) {
        setReceiptCheckError(
          'The saved transaction does not match this scan. Processing is locked for safety.'
        )
        return
      }

      rememberCommittedReceipt(receiptResult.value)
      setTransactionError(pendingDeliveryMessage(receiptResult.value))
    } catch {
      // An interrupted IPC response can happen after SQLite committed. Lock the
      // form until a durable-receipt check proves whether resubmission is safe.
      setReceiptCheckError(RECEIPT_CHECK_ERROR)
    }
  }

  useEffect(() => {
    if (!open) return
    const busy =
      acknowledging ||
      checkingReceipt ||
      processing ||
      retryingResultDelivery ||
      retryingAcknowledgement
    const target = !busy
      ? dialog.current?.querySelector<HTMLElement>('[data-transaction-focus]:not(:disabled)')
      : null
    const focusTarget = target ?? dialog.current
    focusTarget?.focus()
  }, [
    open,
    lookup.state,
    acknowledging,
    checkingReceipt,
    processing,
    retryingResultDelivery,
    retryingAcknowledgement,
    receipt
  ])

  async function confirmTransaction(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault()
    if (
      lookup.state !== 'known' ||
      receipt !== null ||
      processingInFlight.current ||
      acknowledging ||
      checkingReceipt
    ) return

    setQuantityError(null)
    setTransactionError(null)
    const validation = validateTransactionQuantity(
      quantity,
      event.mode,
      lookup.product.currentStock
    )
    if (!validation.ok) {
      setQuantityError(validation.message)
      return
    }

    processingInFlight.current = true
    setProcessing(true)
    if (import.meta.env.DEV &&
        window.sessionStorage.getItem('dentalHardwareTiming') === '1') {
      console.debug('[hardware event UI]', {
        operation: 'CONFIRM', expectedEventId: event.eventId, expectedMode: event.mode
      })
    }

    try {
      const result = await window.desktopApi.hardware.processTransaction({
        eventId: event.eventId,
        quantity: validation.quantity
      })
      if (!result.ok) {
        await recoverAfterUncertainProcess(result.error.message)
        return
      }

      if (!receiptMatchesEvent(result.value.receipt, event)) {
        await recoverAfterUncertainProcess(
          'The transaction response did not match this scan. Please retry safely.'
        )
        return
      }

      rememberCommittedReceipt(result.value.receipt)
      if (result.value.acknowledged && result.value.receipt.resultDeliveredToHardware) {
        onCompleted(result.value.receipt)
      } else {
        setTransactionError(pendingDeliveryMessage(result.value.receipt))
      }
    } catch {
      await recoverAfterUncertainProcess(
        'Could not process this transaction. The scan remains pending; please retry.'
      )
    } finally {
      processingInFlight.current = false
      setProcessing(false)
    }
  }

  async function retryResultDelivery(): Promise<void> {
    if (
      receipt === null ||
      receipt.resultDeliveredToHardware ||
      resultDeliveryRetryInFlight.current
    ) return

    resultDeliveryRetryInFlight.current = true
    setRetryingResultDelivery(true)
    setTransactionError(null)

    try {
      const result = await window.desktopApi.hardware.retryTransactionResultDelivery(event.eventId)
      if (!result.ok || !receiptMatchesEvent(result.value.receipt, event)) {
        setTransactionError(RESULT_DELIVERY_ERROR)
        return
      }

      rememberCommittedReceipt(result.value.receipt)
      if (result.value.acknowledged && result.value.receipt.resultDeliveredToHardware) {
        onCompleted(result.value.receipt)
      } else {
        setTransactionError(pendingDeliveryMessage(result.value.receipt))
      }
    } catch {
      setTransactionError(RESULT_DELIVERY_ERROR)
    } finally {
      resultDeliveryRetryInFlight.current = false
      setRetryingResultDelivery(false)
    }
  }

  async function retryAcknowledgement(): Promise<void> {
    if (
      receipt === null ||
      !receipt.resultDeliveredToHardware ||
      acknowledgementRetryInFlight.current
    ) return
    acknowledgementRetryInFlight.current = true
    setRetryingAcknowledgement(true)
    setTransactionError(null)

    try {
      const result = await window.desktopApi.hardware.retryTransactionAcknowledgement(event.eventId)
      if (!result.ok || !receiptMatchesEvent(result.value.receipt, event)) {
        setTransactionError(ACKNOWLEDGEMENT_ERROR)
        return
      }

      rememberCommittedReceipt(result.value.receipt)
      if (result.value.acknowledged && result.value.receipt.resultDeliveredToHardware) {
        onCompleted(result.value.receipt)
      } else {
        setTransactionError(pendingDeliveryMessage(result.value.receipt))
      }
    } catch {
      setTransactionError(ACKNOWLEDGEMENT_ERROR)
    } finally {
      acknowledgementRetryInFlight.current = false
      setRetryingAcknowledgement(false)
    }
  }

  if (!open) return null

  const busy =
    acknowledging ||
    checkingReceipt ||
    processing ||
    retryingResultDelivery ||
    retryingAcknowledgement

  return (
    <div className="dialog-backdrop hardware-event-backdrop">
      <section
        ref={dialog}
        className="dialog hardware-event-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="hardware-event-title"
        aria-describedby="hardware-event-description"
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== 'Tab') return
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
          ) ?? [])
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (first === undefined) {
            keyEvent.preventDefault()
            dialog.current?.focus()
          } else if (keyEvent.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            keyEvent.preventDefault()
            last?.focus()
          } else if (!keyEvent.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
            keyEvent.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="hardware-event-dialog__brand" aria-hidden="true">
          <span className="clinic-logo hardware-event-dialog__logo"><img src={clinicLogo} alt="" /></span>
          <span>Any Time Dental</span>
        </div>
        <p className="dialog__eyebrow">Hardware transaction</p>
        <h2 id="hardware-event-title">{event.mode.toUpperCase()} TRANSACTION</h2>
        <p id="hardware-event-description" className="hardware-event-dialog__intro">
          {receipt === null
            ? 'Review the scanned item and confirm a quantity to update inventory.'
            : receipt.resultDeliveredToHardware
              ? 'This inventory transaction is saved. Only ESP32 acknowledgement remains.'
              : 'This inventory transaction is saved. ESP32 stock feedback is still pending.'}
        </p>
        <dl className="hardware-event-details">
          <div><dt>Barcode</dt><dd>{event.barcode}</dd></div>
          <div><dt>Scanned</dt><dd>{event.timestamp}</dd></div>
        </dl>

        {checkingReceipt && receipt === null && <p role="status">Checking transaction state…</p>}
        {receiptCheckError !== null && receipt === null && (
          <div className="form-alert form-alert--error" role="alert">{receiptCheckError}</div>
        )}
        {!checkingReceipt && receiptCheckError === null && receipt === null && lookup.state === 'loading' && (
          <p role="status">Looking up barcode in inventory…</p>
        )}
        {!checkingReceipt && receiptCheckError === null && receipt === null && lookup.state === 'error' && (
          <div className="form-alert form-alert--error" role="alert">
            Could not look up this barcode. The scan remains pending. Please retry.
          </div>
        )}
        {!checkingReceipt && receiptCheckError === null && receipt === null && lookup.state === 'unknown' && (
          <div className="form-alert form-alert--error" role="alert">
            <h3>ITEM NOT FOUND</h3>
            <p>This barcode is not registered in inventory.</p>
            <p>Reject scan acknowledges this event without changing inventory.</p>
          </div>
        )}
        {!checkingReceipt && receiptCheckError === null && receipt === null && lookup.state === 'known' && (
          <form onSubmit={(formEvent) => void confirmTransaction(formEvent)} noValidate>
            <div className="hardware-transaction-product">
              <ProductImage imageUrl={lookup.product.imageUrl} itemName={lookup.product.itemName} />
              <div><h3>{lookup.product.itemName}</h3><p>{lookup.product.category}</p></div>
            </div>
            <dl className="hardware-event-details">
              <div><dt>Current stock</dt><dd>{lookup.product.currentStock}</dd></div>
              <div><dt>Stock status</dt><dd><StockStatusBadge status={lookup.product.status} /></dd></div>
            </dl>
            {event.mode === 'checkout' && lookup.product.currentStock === 0 && (
              <p className="form-alert form-alert--error" role="alert">
                Checkout cannot proceed: this item has no available stock.
              </p>
            )}
            <div className="form-field hardware-transaction-quantity">
              <label htmlFor="hardware-transaction-quantity">
                Quantity to {event.mode === 'restock' ? 'ADD' : 'REMOVE'}
              </label>
              <input
                id="hardware-transaction-quantity"
                type="text"
                inputMode="numeric"
                data-transaction-focus
                value={quantity}
                disabled={busy || (event.mode === 'checkout' && lookup.product.currentStock === 0)}
                aria-invalid={quantityError !== null}
                aria-describedby={quantityError === null ? 'hardware-quantity-help' : 'hardware-quantity-error'}
                onChange={(changeEvent) => {
                  setQuantity(changeEvent.target.value)
                  setQuantityError(null)
                  setTransactionError(null)
                }}
              />
              <small id="hardware-quantity-help">Whole numbers only, from 1 to {MAX_TRANSACTION_QUANTITY.toLocaleString('en-US')}.</small>
              {quantityError !== null && <p id="hardware-quantity-error" className="field-error" role="alert">{quantityError}</p>}
            </div>
            {transactionError !== null && (
              <div className="form-alert form-alert--error" role="alert">{transactionError}</div>
            )}
            <div className="dialog__actions dialog__actions--spread hardware-event-dialog__actions">
              <button
                type="button"
                className="secondary-button secondary-button--danger"
                data-transaction-focus
                onClick={onCancel}
                disabled={busy}
              >
                {acknowledging ? 'Cancelling…' : 'Cancel scan'}
              </button>
              <div>
                <button type="button" className="secondary-button" onClick={onReviewLater} disabled={busy}>Review later</button>
                <button
                  className="primary-button primary-button--inline"
                  type="submit"
                  disabled={busy || (event.mode === 'checkout' && lookup.product.currentStock === 0)}
                >
                  {processing
                    ? 'Processing…'
                    : event.mode === 'restock' ? 'Confirm Restock' : 'Confirm Checkout'}
                </button>
              </div>
            </div>
          </form>
        )}

        {receipt !== null && (
          <div className="hardware-transaction-receipt">
            <div className="form-alert form-alert--success" role="status">
              <h3>Inventory transaction saved</h3>
              <p>Stock and movement history were committed exactly once.</p>
            </div>
            <dl className="hardware-event-details hardware-event-details--receipt">
              <div><dt>Item</dt><dd>{receipt.itemName}</dd></div>
              <div><dt>Quantity</dt><dd>{event.mode === 'restock' ? '+' : '-'}{receipt.quantity}</dd></div>
              <div><dt>Previous</dt><dd>{receipt.previousStock}</dd></div>
              <div><dt>New stock</dt><dd>{receipt.newTotal}</dd></div>
              <div><dt>Status</dt><dd><StockStatusBadge status={receipt.status} /></dd></div>
            </dl>
            {transactionError !== null && (
              <div className="form-alert form-alert--error" role="alert">{transactionError}</div>
            )}
            <div className="dialog__actions hardware-event-dialog__actions">
              <button type="button" className="secondary-button" onClick={onReviewLater} disabled={busy}>Review later</button>
              <button
                type="button"
                className="primary-button primary-button--inline"
                data-transaction-focus
                onClick={() => {
                  if (receipt.resultDeliveredToHardware) void retryAcknowledgement()
                  else void retryResultDelivery()
                }}
                disabled={busy}
              >
                {retryingResultDelivery || retryingAcknowledgement
                  ? 'Retrying…'
                  : receipt.resultDeliveredToHardware
                    ? 'Retry acknowledgement'
                    : 'Retry result delivery'}
              </button>
            </div>
          </div>
        )}

        {acknowledgementError !== null && receipt === null && (
          <div className="form-alert form-alert--error" role="alert">{acknowledgementError}</div>
        )}
        {receipt === null && !checkingReceipt && receiptCheckError !== null && (
          <div className="dialog__actions hardware-event-dialog__actions">
            <button type="button" className="secondary-button" onClick={onReviewLater}>Review later</button>
            <button type="button" className="primary-button primary-button--inline" data-transaction-focus onClick={() => setRetryVersion((current) => current + 1)}>Retry transaction check</button>
          </div>
        )}
        {receipt === null && !checkingReceipt && receiptCheckError === null && lookup.state !== 'known' && (
          <div className="dialog__actions hardware-event-dialog__actions">
            <button type="button" className="secondary-button" onClick={onReviewLater} disabled={busy}>Review later</button>
            {lookup.state === 'error' && <button type="button" className="primary-button primary-button--inline" data-transaction-focus onClick={() => setRetryVersion((current) => current + 1)}>Retry lookup</button>}
            {lookup.state === 'unknown' && <button type="button" className="primary-button primary-button--inline" data-transaction-focus onClick={onReject} disabled={acknowledging}>{acknowledging ? 'Acknowledging…' : 'Reject scan'}</button>}
          </div>
        )}
      </section>
    </div>
  )
}
