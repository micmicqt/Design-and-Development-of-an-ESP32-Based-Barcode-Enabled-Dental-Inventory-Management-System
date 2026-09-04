import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { HardwareTransactionEvent, IpcResult, ProductDto } from '../../../shared/ipc-contract'
import { MAX_TRANSACTION_QUANTITY, validateTransactionQuantity } from '../../../shared/transaction-quantity'
import clinicLogo from '../assets/branding/any-time-dental-logo.png'
import { ProductImage } from './ProductImage'
import { StockStatusBadge } from './StockStatusBadge'

type ProductLookup =
  | { state: 'loading' }
  | { state: 'known'; product: ProductDto }
  | { state: 'unknown' }
  | { state: 'error' }

export function HardwareTransactionDialog({
  event, open, acknowledging, acknowledgementError, onReject, onReviewLater
}: {
  event: HardwareTransactionEvent
  open: boolean
  acknowledging: boolean
  acknowledgementError: string | null
  onReject: () => void
  onReviewLater: () => void
}) {
  const [lookup, setLookup] = useState<ProductLookup>({ state: 'loading' })
  const [retryVersion, setRetryVersion] = useState(0)
  const [quantity, setQuantity] = useState('')
  const [quantityError, setQuantityError] = useState<string | null>(null)
  const [validatedQuantity, setValidatedQuantity] = useState<number | null>(null)
  const [validating, setValidating] = useState(false)
  const dialog = useRef<HTMLElement | null>(null)
  const requestVersion = useRef(0)
  const validationInFlight = useRef(false)
  const lookupTail = useRef<Promise<IpcResult<ProductDto | null> | undefined>>(Promise.resolve(undefined))

  // Serializes reads even across Review later / Resume and StrictMode effect replay.
  // Obsolete queued reads are skipped; resuming always requests fresh product information.
  const queueLookup = useCallback((isCurrent: () => boolean) => {
    const request = lookupTail.current.catch(() => undefined).then(() => {
      if (!isCurrent()) return undefined
      return window.desktopApi.inventory.findProductByBarcode(event.barcode)
    })
    lookupTail.current = request
    return request
  }, [event.barcode])

  useEffect(() => {
    const version = ++requestVersion.current
    if (!open) return undefined
    let active = true
    const isCurrent = () => active && requestVersion.current === version
    setLookup({ state: 'loading' })
    setQuantityError(null)
    setValidatedQuantity(null)
    setValidating(false)
    validationInFlight.current = false

    void queueLookup(isCurrent).then((result) => {
      if (!isCurrent() || result === undefined) return
      if (!result.ok) setLookup({ state: 'error' })
      else if (result.value === null) setLookup({ state: 'unknown' })
      else setLookup({ state: 'known', product: result.value })
    }).catch(() => {
      if (isCurrent()) setLookup({ state: 'error' })
    })

    return () => {
      active = false
      requestVersion.current += 1
    }
  }, [open, queueLookup, retryVersion])

  useEffect(() => {
    if (!open) return
    const target = !acknowledging && !validating
      ? dialog.current?.querySelector<HTMLElement>('[data-transaction-focus]')
      : null
    const focusTarget = target ?? dialog.current
    focusTarget?.focus()
  }, [open, lookup.state, acknowledging, validating])

  async function validate(eventToValidate: FormEvent<HTMLFormElement>): Promise<void> {
    eventToValidate.preventDefault()
    if (lookup.state !== 'known' || validationInFlight.current || acknowledging) return
    validationInFlight.current = true
    setValidating(true)
    setQuantityError(null)
    setValidatedQuantity(null)
    const version = requestVersion.current
    const isCurrent = () => requestVersion.current === version

    try {
      const result = await queueLookup(isCurrent)
      if (!isCurrent() || result === undefined) return
      if (!result.ok) {
        setLookup({ state: 'error' })
        return
      }
      if (result.value === null) {
        setLookup({ state: 'unknown' })
        return
      }
      setLookup({ state: 'known', product: result.value })
      const validation = validateTransactionQuantity(quantity, event.mode, result.value.currentStock)
      if (!validation.ok) setQuantityError(validation.message)
      else setValidatedQuantity(validation.quantity)
    } catch {
      if (isCurrent()) setLookup({ state: 'error' })
    } finally {
      if (isCurrent()) {
        validationInFlight.current = false
        setValidating(false)
      }
    }
  }

  if (!open) return null

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
          Review this scan and quantity. Inventory and movement history have not been changed.
        </p>
        <dl className="hardware-event-details">
          <div><dt>Barcode</dt><dd>{event.barcode}</dd></div>
          <div><dt>Scanned</dt><dd>{event.timestamp}</dd></div>
        </dl>

        {lookup.state === 'loading' && <p role="status">Looking up barcode in inventory…</p>}
        {lookup.state === 'error' && (
          <div className="form-alert form-alert--error" role="alert">
            Could not look up this barcode. The scan remains pending. Please retry.
          </div>
        )}
        {lookup.state === 'unknown' && (
          <div className="form-alert form-alert--error" role="alert">
            <h3>ITEM NOT FOUND</h3>
            <p>This barcode is not registered in inventory.</p>
            <p>Reject scan acknowledges this event without changing inventory.</p>
          </div>
        )}
        {lookup.state === 'known' && (
          <form onSubmit={(formEvent) => void validate(formEvent)} noValidate>
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
                disabled={validating}
                aria-invalid={quantityError !== null}
                aria-describedby={quantityError === null ? 'hardware-quantity-help' : 'hardware-quantity-error'}
                onChange={(changeEvent) => {
                  setQuantity(changeEvent.target.value)
                  setQuantityError(null)
                  setValidatedQuantity(null)
                }}
              />
              <small id="hardware-quantity-help">Whole numbers only, from 1 to {MAX_TRANSACTION_QUANTITY.toLocaleString('en-US')}.</small>
              {quantityError !== null && <p id="hardware-quantity-error" className="field-error" role="alert">{quantityError}</p>}
            </div>
            {validatedQuantity !== null && (
              <div className="form-alert form-alert--success" role="status">
                Quantity {validatedQuantity} validated. Ready for Phase 5 Step 2 database transaction.
                Stock is unchanged and this scan remains pending.
              </div>
            )}
            <div className="dialog__actions hardware-event-dialog__actions">
              <button type="button" className="secondary-button" onClick={onReviewLater}>Review later</button>
              <button className="primary-button primary-button--inline" type="submit" disabled={validating}>
                {validating ? 'Validating…' : 'Validate'}
              </button>
            </div>
          </form>
        )}
        {acknowledgementError !== null && <div className="form-alert form-alert--error" role="alert">{acknowledgementError}</div>}
        {lookup.state !== 'known' && (
          <div className="dialog__actions hardware-event-dialog__actions">
            <button type="button" className="secondary-button" onClick={onReviewLater} disabled={acknowledging}>Review later</button>
            {lookup.state === 'error' && <button type="button" className="primary-button primary-button--inline" data-transaction-focus onClick={() => setRetryVersion((current) => current + 1)}>Retry lookup</button>}
            {lookup.state === 'unknown' && <button type="button" className="primary-button primary-button--inline" data-transaction-focus onClick={onReject} disabled={acknowledging}>{acknowledging ? 'Acknowledging…' : 'Reject scan'}</button>}
          </div>
        )}
      </section>
    </div>
  )
}
