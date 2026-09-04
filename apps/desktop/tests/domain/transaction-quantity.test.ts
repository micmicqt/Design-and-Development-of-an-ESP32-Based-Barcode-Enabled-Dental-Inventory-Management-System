import { describe, expect, it } from 'vitest'
import {
  MAX_TRANSACTION_QUANTITY,
  validateTransactionQuantity
} from '../../src/shared/transaction-quantity'

describe('hardware transaction quantity validation (read-only)', () => {
  it.each(['restock', 'checkout'] as const)('accepts positive whole %s quantities', (mode) => {
    expect(validateTransactionQuantity('12', mode, 12)).toEqual({ ok: true, quantity: 12 })
    expect(validateTransactionQuantity(' 001 ', mode, 12)).toEqual({ ok: true, quantity: 1 })
  })

  it.each(['', ' ', '\t', '0', '000', '-1', '+1', '1.5', '1.0', 'abc', '1e3', '0x10', '1,000', 'Infinity', 'NaN', '１２', '10001', '999999999999999999999', '9'.repeat(400)])(
    'rejects invalid or excessive input %j', (value) => {
      expect(validateTransactionQuantity(value, 'restock', 20).ok).toBe(false)
      expect(validateTransactionQuantity(value, 'checkout', 20).ok).toBe(false)
    }
  )

  it('uses an inclusive practical 10,000 per-scan limit', () => {
    expect(MAX_TRANSACTION_QUANTITY).toBe(10_000)
    expect(validateTransactionQuantity('10000', 'restock', 0)).toEqual({ ok: true, quantity: 10_000 })
    expect(validateTransactionQuantity('10000', 'checkout', 10_000)).toEqual({ ok: true, quantity: 10_000 })
  })

  it('allows restock review when empty without changing any stock', () => {
    const stock = 0
    expect(validateTransactionQuantity('1', 'restock', stock)).toEqual({ ok: true, quantity: 1 })
    expect(stock).toBe(0)
  })

  it('rejects checkout above available stock', () => {
    expect(validateTransactionQuantity('6', 'checkout', 5)).toEqual({
      ok: false, message: 'Insufficient stock. Only 5 available for checkout.'
    })
  })

  it('clearly rejects checkout of empty stock', () => {
    expect(validateTransactionQuantity('1', 'checkout', 0)).toEqual({
      ok: false, message: 'Checkout cannot proceed: this item has no available stock.'
    })
  })

  it.each([-1, 1.5, NaN, Infinity])('fails safely on invalid stock %s', (stock) => {
    expect(validateTransactionQuantity('1', 'checkout', stock).ok).toBe(false)
  })
})
