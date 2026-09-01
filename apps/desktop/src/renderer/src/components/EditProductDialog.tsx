import { useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
  type ProductDto,
  type SelectedImageDto
} from '../../../shared/ipc-contract'
import {
  validateProductForm,
  type ProductFormDraft,
  type ProductFormErrors
} from '../features/product-form-validation'
import { ReferenceImagePicker } from './ReferenceImagePicker'

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <span className="field-error" id={id}>
      {message}
    </span>
  )
}

export function EditProductDialog({
  product,
  onClose,
  onSaved,
  onDeleted
}: {
  product: ProductDto
  onClose: () => void
  onSaved: (stockChanged: boolean) => void
  onDeleted: () => void
}) {
  const [form, setForm] = useState<ProductFormDraft>({
    itemName: product.itemName,
    category: product.category,
    currentStock: String(product.currentStock),
    lowStockThreshold: String(product.lowStockThreshold)
  })
  const [errors, setErrors] = useState<ProductFormErrors>({})
  const [replacementImage, setReplacementImage] = useState<SelectedImageDto | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [selectingImage, setSelectingImage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const busy = saving || deleting || selectingImage

  function setField<Key extends keyof ProductFormDraft>(
    field: Key,
    value: ProductFormDraft[Key]
  ): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setOperationError(null)
  }

  function handleEscape(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || busy) return
    if (confirmingDelete) {
      setConfirmingDelete(false)
    } else {
      onClose()
    }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return

    const validation = validateProductForm(form, { requireBarcode: false })
    setErrors(validation.errors)
    setOperationError(null)
    if (validation.value === null) return

    setSaving(true)
    try {
      const result = await window.desktopApi.inventory.updateProduct({
        id: product.id,
        itemName: validation.value.itemName,
        category: validation.value.category,
        currentStock: validation.value.currentStock,
        lowStockThreshold: validation.value.lowStockThreshold,
        ...(replacementImage !== null
          ? { replacementImageSelectionToken: replacementImage.selectionToken }
          : removeImage
            ? { removeImage: true }
            : {})
      })

      if (!result.ok) {
        setOperationError(result.error.message)
        return
      }

      onSaved(result.value.currentStock !== product.currentStock)
    } catch {
      setOperationError('The item could not be updated. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (busy) return
    setDeleting(true)
    setOperationError(null)

    try {
      const result = await window.desktopApi.inventory.deleteProduct({ id: product.id })
      if (!result.ok) {
        setOperationError(result.error.message)
        return
      }

      onDeleted()
    } catch {
      setOperationError('The item could not be deleted. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  if (confirmingDelete) {
    return (
      <div className="dialog-backdrop" onKeyDown={handleEscape}>
        <section
          className="dialog dialog--confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          aria-describedby="delete-dialog-description"
        >
          <span className="danger-mark" aria-hidden="true">
            !
          </span>
          <p className="dialog__eyebrow">Confirmation required</p>
          <h2 id="delete-dialog-title">Delete {product.itemName}?</h2>
          <p id="delete-dialog-description">
            This item will disappear from active inventory. Its existing movement history will be
            preserved.
          </p>

          {operationError !== null && (
            <div className="form-alert form-alert--error" role="alert">
              {operationError}
            </div>
          )}

          <div className="dialog__actions dialog__actions--centered">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Keep item
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : `Delete ${product.itemName}`}
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="dialog-backdrop" onKeyDown={handleEscape}>
      <section
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-dialog-title"
      >
        <header className="dialog__header">
          <div>
            <p className="dialog__eyebrow">Inventory administration</p>
            <h2 id="edit-dialog-title">Edit {product.itemName}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close edit item"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </header>

        <form onSubmit={save} noValidate>
          {operationError !== null && (
            <div className="form-alert form-alert--error" role="alert">
              {operationError}
            </div>
          )}

          <div className="edit-layout">
            <div className="product-form__fields">
              <div className="form-field form-field--wide">
                <span className="form-label">Barcode / SKU</span>
                <div className="read-only-value">{product.barcode}</div>
                <small>Barcode changes are disabled to protect transaction identity.</small>
              </div>

              <div className="form-field form-field--wide">
                <label htmlFor="edit-item-name">Item Name</label>
                <input
                  id="edit-item-name"
                  type="text"
                  maxLength={200}
                  value={form.itemName}
                  onChange={(event) => setField('itemName', event.target.value)}
                  aria-invalid={Boolean(errors.itemName)}
                  aria-describedby={errors.itemName ? 'edit-item-name-error' : undefined}
                  disabled={busy}
                />
                <FieldError id="edit-item-name-error" message={errors.itemName} />
              </div>

              <div className="form-field form-field--wide">
                <label htmlFor="edit-category">Category</label>
                <select
                  id="edit-category"
                  value={form.category}
                  onChange={(event) =>
                    setField('category', event.target.value as InventoryCategory | '')
                  }
                  aria-invalid={Boolean(errors.category)}
                  aria-describedby={errors.category ? 'edit-category-error' : undefined}
                  disabled={busy}
                >
                  {INVENTORY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <FieldError id="edit-category-error" message={errors.category} />
              </div>

              <div className="form-field">
                <label htmlFor="edit-stock">Current Stock — administrative correction</label>
                <input
                  id="edit-stock"
                  type="text"
                  inputMode="numeric"
                  value={form.currentStock}
                  onChange={(event) => setField('currentStock', event.target.value)}
                  aria-invalid={Boolean(errors.currentStock)}
                  aria-describedby={errors.currentStock ? 'edit-stock-error' : 'stock-correction-note'}
                  disabled={busy}
                />
                <FieldError id="edit-stock-error" message={errors.currentStock} />
                <small id="stock-correction-note">
                  A change creates a permanent STOCK_CORRECTION record.
                </small>
              </div>

              <div className="form-field">
                <label htmlFor="edit-threshold">Low Stock Threshold</label>
                <input
                  id="edit-threshold"
                  type="text"
                  inputMode="numeric"
                  value={form.lowStockThreshold}
                  onChange={(event) => setField('lowStockThreshold', event.target.value)}
                  aria-invalid={Boolean(errors.lowStockThreshold)}
                  aria-describedby={errors.lowStockThreshold ? 'edit-threshold-error' : undefined}
                  disabled={busy}
                />
                <FieldError id="edit-threshold-error" message={errors.lowStockThreshold} />
              </div>
            </div>

            <ReferenceImagePicker
              selectedImage={replacementImage}
              existingImage={
                !removeImage && product.imageUrl !== null
                  ? { imageUrl: product.imageUrl, itemName: product.itemName }
                  : null
              }
              compact
              disabled={saving || deleting}
              onImageSelected={(image) => {
                setReplacementImage(image)
                setRemoveImage(false)
                setOperationError(null)
              }}
              onRemove={() => {
                setReplacementImage(null)
                setRemoveImage(product.imageUrl !== null)
                setOperationError(null)
              }}
              onError={setOperationError}
              onProcessingChange={setSelectingImage}
            />
          </div>

          <footer className="dialog__actions dialog__actions--spread">
            <button
              className="danger-button danger-button--quiet"
              type="button"
              onClick={() => {
                setOperationError(null)
                setConfirmingDelete(true)
              }}
              disabled={busy}
            >
              Delete item
            </button>
            <div>
              <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="primary-button primary-button--inline" type="submit" disabled={busy}>
                {saving ? 'Saving changes…' : 'Save changes'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
