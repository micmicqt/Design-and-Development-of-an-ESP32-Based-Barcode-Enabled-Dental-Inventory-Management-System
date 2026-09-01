import { useState, type FormEvent } from 'react'
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
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

  function setField<Key extends keyof ProductFormDraft>(
    field: Key,
    value: ProductFormDraft[Key]
  ): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setSubmissionError(null)
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
      onCreated(registeredName)
    } catch {
      setSubmissionError('The item could not be saved. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="product-form" onSubmit={submit} noValidate>
      <div className="manual-entry-note" role="note">
        <strong>Manual barcode entry</strong>
        <span>Enter or paste the barcode printed on the item or package.</span>
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
            <input
              id="new-barcode"
              type="text"
              autoComplete="off"
              maxLength={128}
              value={form.barcode ?? ''}
              onChange={(event) => setField('barcode', event.target.value)}
              aria-invalid={Boolean(errors.barcode)}
              aria-describedby={errors.barcode ? 'new-barcode-error' : undefined}
              disabled={submitting}
            />
            <FieldError id="new-barcode-error" message={errors.barcode} />
            <small>Leading zeroes are preserved.</small>
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
