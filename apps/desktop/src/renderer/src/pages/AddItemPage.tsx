import { useState, type FormEvent } from 'react'
import {
  INVENTORY_CATEGORIES,
  PRODUCT_UNIT_TYPES,
  type InventoryCategory,
  type ProductUnitType,
  type SelectedImageDto
} from '../../../shared/ipc-contract'
import {
  validateProductForm,
  type ProductFormDraft,
  type ProductFormErrors
} from '../features/product-form-validation'
import { ReferenceImagePicker } from '../components/ReferenceImagePicker'

const INITIAL_FORM: ProductFormDraft = {
  barcode: '',
  itemName: '',
  category: '',
  unitType: 'Piece',
  currentStock: '0',
  lowStockThreshold: '0'
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <span className="field-error" id={id}>
      {message}
    </span>
  )
}

export function AddItemPage({ onCreated }: { onCreated: (itemName: string) => void }) {
  const [form, setForm] = useState<ProductFormDraft>(INITIAL_FORM)
  const [errors, setErrors] = useState<ProductFormErrors>({})
  const [selectedImage, setSelectedImage] = useState<SelectedImageDto | null>(null)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const [imageProcessing, setImageProcessing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [barcodeMode, setBarcodeMode] = useState<'scan' | 'manual'>('scan')
  const [captureState, setCaptureState] = useState<'idle' | 'waiting' | 'captured' | 'error'>('idle')

  function setField<Key extends keyof ProductFormDraft>(
    field: Key,
    value: ProductFormDraft[Key]
  ): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setSubmissionError(null)
  }

  async function captureBarcode(): Promise<void> {
    if (submitting || captureState === 'waiting') return
    setCaptureState('waiting')
    setSubmissionError(null)
    setErrors((current) => ({ ...current, barcode: undefined }))

    try {
      const result = await window.desktopApi.hardware.captureRegistrationBarcode()
      if (!result.ok) {
        setCaptureState('error')
        setSubmissionError(result.error.message)
        return
      }

      const barcode = result.value.barcode
      setField('barcode', barcode)
      const existing = await window.desktopApi.inventory.findProductByBarcode(barcode)
      if (!existing.ok) {
        setCaptureState('error')
        setSubmissionError(existing.error.message)
      } else if (existing.value !== null) {
        setCaptureState('error')
        setErrors((current) => ({ ...current, barcode: 'This barcode is already registered.' }))
      } else {
        setCaptureState('captured')
      }
    } catch {
      setCaptureState('error')
      setSubmissionError('Unable to capture a barcode. Check the scanner connection and try again.')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting || imageProcessing) return

    const validation = validateProductForm(form, { requireBarcode: true })
    setErrors(validation.errors)
    setSubmissionError(null)
    if (validation.value === null || validation.value.barcode === undefined) return

    setSubmitting(true)
    try {
      const result = await window.desktopApi.inventory.createProduct({
        barcode: validation.value.barcode,
        itemName: validation.value.itemName,
        category: validation.value.category,
        unitType: validation.value.unitType,
        initialStock: validation.value.currentStock,
        lowStockThreshold: validation.value.lowStockThreshold,
        imageSelectionToken: selectedImage?.selectionToken ?? null
      })

      if (!result.ok) {
        setSubmissionError(result.error.message)
        return
      }

      const registeredName = result.value.itemName
      setForm(INITIAL_FORM)
      setErrors({})
      setSelectedImage(null)
      setCaptureState('idle')
      onCreated(registeredName)
    } catch {
      setSubmissionError('The item could not be saved. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="product-form" onSubmit={submit} noValidate>
      <div className="barcode-entry-panel" aria-labelledby="barcode-entry-title">
        <div>
          <strong id="barcode-entry-title">Barcode registration</strong>
          <span>Scan with the clinic kiosk or enter the code manually.</span>
        </div>
        <div className="barcode-mode-switch" role="group" aria-label="Barcode entry method">
          <button
            type="button"
            className={barcodeMode === 'scan' ? 'is-active' : ''}
            aria-pressed={barcodeMode === 'scan'}
            onClick={() => setBarcodeMode('scan')}
            disabled={submitting || captureState === 'waiting'}
          >
            Scan Barcode
          </button>
          <button
            type="button"
            className={barcodeMode === 'manual' ? 'is-active' : ''}
            aria-pressed={barcodeMode === 'manual'}
            onClick={() => setBarcodeMode('manual')}
            disabled={submitting || captureState === 'waiting'}
          >
            Enter Manually
          </button>
        </div>
      </div>

      {submissionError !== null && (
        <div className="form-alert form-alert--error" role="alert">
          {submissionError}
        </div>
      )}

      <div className="product-form__layout">
        <section className="product-form__fields" aria-label="Item details">
          <div className="form-field form-field--wide">
            <label htmlFor="new-barcode">Barcode / SKU</label>
            {barcodeMode === 'scan' ? (
              <div className="barcode-capture">
                <input
                  id="new-barcode"
                  type="text"
                  value={form.barcode ?? ''}
                  placeholder="Barcode will appear after scanning"
                  readOnly
                  aria-invalid={Boolean(errors.barcode)}
                  aria-describedby={errors.barcode ? 'new-barcode-error' : 'barcode-capture-status'}
                />
                <button
                  className="secondary-button barcode-capture__button"
                  type="button"
                  aria-label={form.barcode ? 'Rescan barcode' : 'Start barcode scan'}
                  onClick={() => void captureBarcode()}
                  disabled={submitting || captureState === 'waiting'}
                >
                  {captureState === 'waiting'
                    ? 'Waiting for scan…'
                    : form.barcode
                      ? 'Rescan'
                      : 'Scan Barcode'}
                </button>
              </div>
            ) : (
              <input
                id="new-barcode"
                type="text"
                autoComplete="off"
                maxLength={128}
                value={form.barcode ?? ''}
                onChange={(event) => {
                  setField('barcode', event.target.value)
                  setCaptureState('idle')
                }}
                aria-invalid={Boolean(errors.barcode)}
                aria-describedby={errors.barcode ? 'new-barcode-error' : undefined}
                disabled={submitting}
              />
            )}
            <FieldError id="new-barcode-error" message={errors.barcode} />
            <small id="barcode-capture-status" role="status" aria-live="polite">
              {barcodeMode === 'scan' && captureState === 'waiting'
                ? 'Waiting for barcode scan…'
                : barcodeMode === 'scan' && captureState === 'captured'
                  ? `Captured barcode: ${form.barcode}`
                  : 'Leading zeroes are preserved.'}
            </small>
          </div>

          <div className="form-field form-field--wide">
            <label htmlFor="new-item-name">Item Name</label>
            <input
              id="new-item-name"
              type="text"
              maxLength={200}
              value={form.itemName}
              onChange={(event) => setField('itemName', event.target.value)}
              aria-invalid={Boolean(errors.itemName)}
              aria-describedby={errors.itemName ? 'new-item-name-error' : undefined}
              disabled={submitting}
            />
            <FieldError id="new-item-name-error" message={errors.itemName} />
          </div>

          <div className="form-field form-field--wide">
            <label htmlFor="new-category">Category</label>
            <select
              id="new-category"
              value={form.category}
              onChange={(event) => setField('category', event.target.value as InventoryCategory | '')}
              aria-invalid={Boolean(errors.category)}
              aria-describedby={errors.category ? 'new-category-error' : undefined}
              disabled={submitting}
            >
              <option value="">Select a category</option>
              {INVENTORY_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <FieldError id="new-category-error" message={errors.category} />
          </div>

          <div className="form-field form-field--wide">
            <label htmlFor="new-unit-type">Unit Type</label>
            <select
              id="new-unit-type"
              value={form.unitType}
              onChange={(event) => setField('unitType', event.target.value as ProductUnitType)}
              aria-invalid={Boolean(errors.unitType)}
              aria-describedby={errors.unitType ? 'new-unit-type-error' : undefined}
              disabled={submitting}
            >
              {PRODUCT_UNIT_TYPES.map((unitType) => (
                <option key={unitType} value={unitType}>{unitType}</option>
              ))}
            </select>
            <FieldError id="new-unit-type-error" message={errors.unitType} />
          </div>

          <div className="form-field">
            <label htmlFor="new-stock">Initial Stock</label>
            <input
              id="new-stock"
              type="text"
              inputMode="numeric"
              value={form.currentStock}
              onChange={(event) => setField('currentStock', event.target.value)}
              aria-invalid={Boolean(errors.currentStock)}
              aria-describedby={errors.currentStock ? 'new-stock-error' : undefined}
              disabled={submitting}
            />
            <FieldError id="new-stock-error" message={errors.currentStock} />
          </div>

          <div className="form-field">
            <label htmlFor="new-threshold">Low Stock Threshold</label>
            <input
              id="new-threshold"
              type="text"
              inputMode="numeric"
              value={form.lowStockThreshold}
              onChange={(event) => setField('lowStockThreshold', event.target.value)}
              aria-invalid={Boolean(errors.lowStockThreshold)}
              aria-describedby={errors.lowStockThreshold ? 'new-threshold-error' : undefined}
              disabled={submitting}
            />
            <FieldError id="new-threshold-error" message={errors.lowStockThreshold} />
          </div>
        </section>

        <ReferenceImagePicker
          selectedImage={selectedImage}
          disabled={submitting}
          onImageSelected={setSelectedImage}
          onRemove={() => {
            setSelectedImage(null)
            setSubmissionError(null)
          }}
          onError={setSubmissionError}
          onProcessingChange={setImageProcessing}
        />
      </div>

      <div className="product-form__actions">
        <button
          className="primary-button primary-button--inline"
          type="submit"
          disabled={submitting || imageProcessing}
        >
          {submitting ? 'Saving item…' : 'Add item'}
        </button>
      </div>
    </form>
  )
}
