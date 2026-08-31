import {
  INVENTORY_CATEGORIES,
  type InventoryCategory
} from '../../../shared/ipc-contract'

const MAX_BARCODE_LENGTH = 128
const MAX_ITEM_NAME_LENGTH = 200

export interface ProductFormDraft {
  barcode?: string
  itemName: string
  category: InventoryCategory | ''
  currentStock: string
  lowStockThreshold: string
}

export type ProductFormField =
  | 'barcode'
  | 'itemName'
  | 'category'
  | 'currentStock'
  | 'lowStockThreshold'

export type ProductFormErrors = Partial<Record<ProductFormField, string>>

export interface ValidatedProductForm {
  barcode?: string
  itemName: string
  category: InventoryCategory
  currentStock: number
  lowStockThreshold: number
}

function parseNonNegativeInteger(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return null

  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function validateProductForm(
  draft: ProductFormDraft,
  options: { requireBarcode: boolean }
): { errors: ProductFormErrors; value: ValidatedProductForm | null } {
  const errors: ProductFormErrors = {}
  const barcode = draft.barcode?.trim()
  const itemName = draft.itemName.trim()
  const currentStock = parseNonNegativeInteger(draft.currentStock)
  const lowStockThreshold = parseNonNegativeInteger(draft.lowStockThreshold)

  if (options.requireBarcode && !barcode) {
    errors.barcode = 'Barcode / SKU is required.'
  } else if (barcode !== undefined && barcode.length > MAX_BARCODE_LENGTH) {
    errors.barcode = `Barcode / SKU must be ${MAX_BARCODE_LENGTH} characters or fewer.`
  }

  if (itemName.length === 0) {
    errors.itemName = 'Item name is required.'
  } else if (itemName.length > MAX_ITEM_NAME_LENGTH) {
    errors.itemName = `Item name must be ${MAX_ITEM_NAME_LENGTH} characters or fewer.`
  }

  if (
    draft.category === '' ||
    !(INVENTORY_CATEGORIES as readonly string[]).includes(draft.category)
  ) {
    errors.category = 'Select one of the approved categories.'
  }

  if (currentStock === null) {
    errors.currentStock = 'Stock must be a whole number greater than or equal to zero.'
  }

  if (lowStockThreshold === null) {
    errors.lowStockThreshold =
      'Low-stock threshold must be a whole number greater than or equal to zero.'
  }

  if (Object.keys(errors).length > 0 || currentStock === null || lowStockThreshold === null) {
    return { errors, value: null }
  }

  return {
    errors,
    value: {
      ...(barcode === undefined ? {} : { barcode }),
      itemName,
      category: draft.category as InventoryCategory,
      currentStock,
      lowStockThreshold
    }
  }
}
