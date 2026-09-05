import {
  INVENTORY_CATEGORIES,
  type CreateProductInput,
  type DeleteProductInput,
  type InventoryCategory,
  type ProcessHardwareTransactionInput,
  type ProductListQuery,
  type UpdateProductInput
} from '../../shared/ipc-contract'
import { isValidHardwareTransactionEventId } from '../hardware/hardware-gateway'
import { MAX_TRANSACTION_QUANTITY } from '../../shared/transaction-quantity'
import { isAbsolute } from 'node:path'

const MAX_BARCODE_LENGTH = 128
const MAX_ITEM_NAME_LENGTH = 200
const MAX_SEARCH_LENGTH = 256
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class PayloadValidationError extends Error {
  readonly fieldErrors: Readonly<Record<string, string>>

  constructor(fieldErrors: Readonly<Record<string, string>>) {
    super('One or more fields are invalid.')
    this.name = 'PayloadValidationError'
    this.fieldErrors = fieldErrors
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PayloadValidationError({ form: 'Invalid request payload.' })
  }
  return value as Record<string, unknown>
}

function requiredTrimmedString(
  value: unknown,
  field: string,
  label: string,
  maximumLength: number,
  fieldErrors: Record<string, string>
): string {
  if (typeof value !== 'string') {
    fieldErrors[field] = `${label} is required.`
    return ''
  }

  const normalized = value.trim()
  if (normalized.length === 0) fieldErrors[field] = `${label} is required.`
  else if (normalized.length > maximumLength) {
    fieldErrors[field] = `${label} must be ${maximumLength} characters or fewer.`
  }
  return normalized
}

function categoryValue(
  value: unknown,
  fieldErrors: Record<string, string>
): InventoryCategory {
  if (
    typeof value !== 'string' ||
    !(INVENTORY_CATEGORIES as readonly string[]).includes(value)
  ) {
    fieldErrors.category = 'Select one of the six supported categories.'
    return INVENTORY_CATEGORIES[0]
  }
  return value as InventoryCategory
}

function nonNegativeSafeInteger(
  value: unknown,
  field: string,
  label: string,
  fieldErrors: Record<string, string>
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fieldErrors[field] = `${label} must be a non-negative integer.`
    return 0
  }
  return value as number
}

function positiveSafeInteger(
  value: unknown,
  field: string,
  label: string,
  fieldErrors: Record<string, string>
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fieldErrors[field] = `${label} must be a positive integer.`
    return 0
  }
  return value as number
}

function optionalSelectionToken(
  value: unknown,
  field: string,
  fieldErrors: Record<string, string>
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fieldErrors[field] = 'Select the image again.'
    return undefined
  }
  return value
}

function throwIfInvalid(fieldErrors: Record<string, string>): void {
  if (Object.keys(fieldErrors).length > 0) throw new PayloadValidationError(fieldErrors)
}

export function validateProductListQuery(value: unknown): ProductListQuery {
  if (value === undefined) return { search: '', category: null }
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const search =
    typeof candidate.search === 'string' ? candidate.search.trim() : candidate.search === undefined ? '' : ''

  if (candidate.search !== undefined && typeof candidate.search !== 'string') {
    fieldErrors.search = 'Search text must be valid text.'
  } else if (search.length > MAX_SEARCH_LENGTH) {
    fieldErrors.search = `Search text must be ${MAX_SEARCH_LENGTH} characters or fewer.`
  }

  let category: InventoryCategory | null = null
  if (candidate.category !== undefined && candidate.category !== null) {
    if (
      typeof candidate.category !== 'string' ||
      !(INVENTORY_CATEGORIES as readonly string[]).includes(candidate.category)
    ) {
      fieldErrors.category = 'Select one of the six supported categories.'
    } else {
      category = candidate.category as InventoryCategory
    }
  }

  throwIfInvalid(fieldErrors)
  return { search, category }
}

/** Validate scanner text without trimming, case folding, or numeric conversion. */
export function validateBarcodeLookupPayload(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 256 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw new PayloadValidationError({ barcode: 'Barcode must be valid text, 1–256 characters long.' })
  }
  return value
}

export function validateHardwareTransactionEventIdPayload(value: unknown): string {
  if (!isValidHardwareTransactionEventId(value)) {
    throw new PayloadValidationError({ eventId: 'The transaction event ID is invalid.' })
  }
  return value
}

export function validateProcessHardwareTransactionInput(
  value: unknown
): ProcessHardwareTransactionInput {
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const eventId = isValidHardwareTransactionEventId(candidate.eventId)
    ? candidate.eventId
    : ''
  if (eventId.length === 0) {
    fieldErrors.eventId = 'The transaction event ID is invalid.'
  }

  const quantity = candidate.quantity
  if (
    !Number.isSafeInteger(quantity) ||
    (quantity as number) <= 0 ||
    (quantity as number) > MAX_TRANSACTION_QUANTITY
  ) {
    fieldErrors.quantity = `Quantity must be a positive whole number no greater than ${MAX_TRANSACTION_QUANTITY.toLocaleString('en-US')}.`
  }

  throwIfInvalid(fieldErrors)
  return { eventId, quantity: quantity as number }
}

export function validateCreateProductInput(value: unknown): CreateProductInput {
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const barcode = requiredTrimmedString(
    candidate.barcode,
    'barcode',
    'Barcode / SKU',
    MAX_BARCODE_LENGTH,
    fieldErrors
  )
  const itemName = requiredTrimmedString(
    candidate.itemName,
    'itemName',
    'Item name',
    MAX_ITEM_NAME_LENGTH,
    fieldErrors
  )
  const category = categoryValue(candidate.category, fieldErrors)
  const initialStock = nonNegativeSafeInteger(
    candidate.initialStock,
    'initialStock',
    'Initial stock',
    fieldErrors
  )
  const lowStockThreshold = nonNegativeSafeInteger(
    candidate.lowStockThreshold,
    'lowStockThreshold',
    'Low-stock threshold',
    fieldErrors
  )
  const imageSelectionToken = optionalSelectionToken(
    candidate.imageSelectionToken,
    'imageSelectionToken',
    fieldErrors
  )

  throwIfInvalid(fieldErrors)
  return {
    barcode,
    itemName,
    category,
    initialStock,
    lowStockThreshold,
    imageSelectionToken: imageSelectionToken ?? null
  }
}

export function validateUpdateProductInput(value: unknown): UpdateProductInput {
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const id = positiveSafeInteger(candidate.id, 'id', 'Product ID', fieldErrors)
  const itemName = requiredTrimmedString(
    candidate.itemName,
    'itemName',
    'Item name',
    MAX_ITEM_NAME_LENGTH,
    fieldErrors
  )
  const category = categoryValue(candidate.category, fieldErrors)
  const currentStock = nonNegativeSafeInteger(
    candidate.currentStock,
    'currentStock',
    'Current stock',
    fieldErrors
  )
  const lowStockThreshold = nonNegativeSafeInteger(
    candidate.lowStockThreshold,
    'lowStockThreshold',
    'Low-stock threshold',
    fieldErrors
  )
  const replacementImageSelectionToken = optionalSelectionToken(
    candidate.replacementImageSelectionToken,
    'replacementImageSelectionToken',
    fieldErrors
  )
  let removeImage = false
  if (candidate.removeImage !== undefined) {
    if (typeof candidate.removeImage !== 'boolean') {
      fieldErrors.removeImage = 'Image removal must be a valid choice.'
    } else {
      removeImage = candidate.removeImage
    }
  }
  if (removeImage && replacementImageSelectionToken !== undefined) {
    fieldErrors.removeImage = 'Choose either a replacement image or remove the current image.'
  }

  throwIfInvalid(fieldErrors)
  return {
    id,
    itemName,
    category,
    currentStock,
    lowStockThreshold,
    ...(replacementImageSelectionToken === undefined ? {} : { replacementImageSelectionToken }),
    ...(removeImage ? { removeImage: true } : {})
  }
}

export function validateDroppedImagePath(value: unknown): string {
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const sourcePath = candidate.sourcePath

  if (
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath.length > 32_767 ||
    sourcePath.includes('\0') ||
    !isAbsolute(sourcePath)
  ) {
    fieldErrors.image = 'The dropped image could not be accessed.'
  }

  throwIfInvalid(fieldErrors)
  return sourcePath as string
}

export function validateDeleteProductInput(value: unknown): DeleteProductInput {
  const candidate = asRecord(value)
  const fieldErrors: Record<string, string> = {}
  const id = positiveSafeInteger(candidate.id, 'id', 'Product ID', fieldErrors)
  throwIfInvalid(fieldErrors)
  return { id }
}
