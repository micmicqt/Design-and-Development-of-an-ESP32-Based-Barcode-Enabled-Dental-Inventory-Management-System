import type { HardwareTransactionMode } from './ipc-contract'

/** Per-scan guard against accidental extreme entries; this does not change stock limits. */
export const MAX_TRANSACTION_QUANTITY = 10_000

export type TransactionQuantityValidation =
  | { ok: true; quantity: number }
  | { ok: false; message: string }

/** Immediate UI feedback; the backend independently repeats all authoritative checks. */
export function validateTransactionQuantity(
  value: string,
  mode: HardwareTransactionMode,
  currentStock: number
): TransactionQuantityValidation {
  const text = value.trim()
  if (text.length === 0) return { ok: false, message: 'Enter a quantity.' }
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, message: 'Quantity must be a positive whole number.' }
  }

  const quantity = Number(text)
  if (quantity === 0) return { ok: false, message: 'Quantity must be greater than zero.' }
  if (!Number.isSafeInteger(quantity) || quantity > MAX_TRANSACTION_QUANTITY) {
    return { ok: false, message: 'Quantity must not exceed 10,000 per scan.' }
  }
  if (!Number.isSafeInteger(currentStock) || currentStock < 0) {
    return { ok: false, message: 'Current stock is unavailable. Refresh the item and try again.' }
  }
  if (mode === 'checkout') {
    if (currentStock === 0) {
      return { ok: false, message: 'Checkout cannot proceed: this item has no available stock.' }
    }
    if (quantity > currentStock) {
      return { ok: false, message: `Insufficient stock. Only ${currentStock} available for checkout.` }
    }
  }
  return { ok: true, quantity }
}
