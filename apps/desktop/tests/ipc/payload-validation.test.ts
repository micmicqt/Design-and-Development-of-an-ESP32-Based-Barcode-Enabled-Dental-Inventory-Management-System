// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  PayloadValidationError,
  validateBarcodeLookupPayload,
  validateCreateProductInput,
  validateDeleteProductInput,
  validateDroppedImagePath,
  validateHardwareTransactionEventIdPayload,
  validateProcessHardwareTransactionInput,
  validateProductListQuery,
  validateUpdateProductInput
} from '../../src/main/ipc/payload-validation'

describe('exact barcode lookup IPC validation', () => {
  it.each(['001234567890', ' 001234567890 ', 'ABC-123', 'A'.repeat(256)])(
    'preserves the exact lookup text: %s',
    (barcode) => {
      expect(validateBarcodeLookupPayload(barcode)).toBe(barcode)
    }
  )

  it.each([
    undefined, null, 123, true, {}, ['00123'], { barcode: '00123' },
    '', '   ', 'A'.repeat(257), '001\u0000', '001\r', '001\n'
  ])('rejects invalid lookup payload: %j', (payload) => {
    expect(() => validateBarcodeLookupPayload(payload)).toThrowError(PayloadValidationError)
  })
})

describe('hardware transaction IPC validation', () => {
  it('accepts only a bounded event ID and a positive integer quantity', () => {
    expect(
      validateProcessHardwareTransactionInput({ eventId: 'evt-session:1', quantity: 10_000 })
    ).toEqual({ eventId: 'evt-session:1', quantity: 10_000 })
    expect(validateHardwareTransactionEventIdPayload('evt-session:1')).toBe('evt-session:1')
  })

  it.each([
    undefined,
    null,
    {},
    { eventId: '', quantity: 1 },
    { eventId: ' event', quantity: 1 },
    { eventId: 'event/id', quantity: 1 },
    { eventId: 'x'.repeat(64), quantity: 1 },
    { eventId: 'evt-1', quantity: undefined },
    { eventId: 'evt-1', quantity: '1' },
    { eventId: 'evt-1', quantity: 0 },
    { eventId: 'evt-1', quantity: -1 },
    { eventId: 'evt-1', quantity: 1.5 },
    { eventId: 'evt-1', quantity: 10_001 }
  ])('rejects an invalid processing payload: %j', (payload) => {
    expect(() => validateProcessHardwareTransactionInput(payload)).toThrowError(
      PayloadValidationError
    )
  })

  it.each([undefined, null, 1, {}, '', ' event', 'event/id', 'x'.repeat(64)])(
    'rejects an invalid receipt/ACK event ID: %j',
    (eventId) => {
      expect(() => validateHardwareTransactionEventIdPayload(eventId)).toThrowError(
        PayloadValidationError
      )
    }
  )
})

describe('Phase 2 IPC payload validation', () => {
  it('preserves leading zeroes while normalizing a product barcode', () => {
    const result = validateCreateProductInput({
      barcode: ' 001234567890 ',
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      unitType: 'Piece',
      initialStock: 4,
      lowStockThreshold: 2,
      imageSelectionToken: null
    })

    expect(result.barcode).toBe('001234567890')
  })

  it.each([
    [{ category: 'Custom category' }, 'category'],
    [{ unitType: 'Case' }, 'unitType'],
    [{ initialStock: -1 }, 'initialStock'],
    [{ lowStockThreshold: -1 }, 'lowStockThreshold']
  ])('rejects invalid create input for %s', (override, expectedField) => {
    expect(() =>
      validateCreateProductInput({
        barcode: '0001',
        itemName: 'Dental item',
        category: 'General',
        unitType: 'Piece',
        initialStock: 0,
        lowStockThreshold: 0,
        imageSelectionToken: null,
        ...override
      })
    ).toThrowError(PayloadValidationError)

    try {
      validateCreateProductInput({
        barcode: '0001',
        itemName: 'Dental item',
        category: 'General',
        unitType: 'Piece',
        initialStock: 0,
        lowStockThreshold: 0,
        imageSelectionToken: null,
        ...override
      })
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PayloadValidationError)
      expect((error as PayloadValidationError).fieldErrors).toHaveProperty(expectedField)
    }
  })

  it('treats a null replacement token as retaining the current image', () => {
    const result = validateUpdateProductInput({
      id: 8,
      itemName: 'Etchant',
      category: 'General',
      unitType: 'Piece',
      currentStock: 2,
      lowStockThreshold: 1,
      replacementImageSelectionToken: null
    })

    expect(result).not.toHaveProperty('replacementImageSelectionToken')
  })

  it('accepts explicit image removal and rejects conflicting or malformed image intent', () => {
    const baseInput = {
      id: 8,
      itemName: 'Etchant',
      category: 'General',
      unitType: 'Piece',
      currentStock: 2,
      lowStockThreshold: 1
    }

    expect(validateUpdateProductInput({ ...baseInput, removeImage: true })).toMatchObject({
      removeImage: true
    })
    expect(validateUpdateProductInput({ ...baseInput, removeImage: false })).not.toHaveProperty(
      'removeImage'
    )
    expect(() =>
      validateUpdateProductInput({ ...baseInput, removeImage: 'yes' })
    ).toThrowError(PayloadValidationError)
    expect(() =>
      validateUpdateProductInput({
        ...baseInput,
        removeImage: true,
        replacementImageSelectionToken: '00000000-0000-4000-8000-000000000001'
      })
    ).toThrowError(PayloadValidationError)
  })

  it('accepts only an absolute dropped-image path from the trusted preload', () => {
    const sourcePath = resolve('reference.png')
    expect(validateDroppedImagePath({ sourcePath })).toBe(sourcePath)
    expect(() => validateDroppedImagePath({ sourcePath: 'relative.png' })).toThrowError(
      PayloadValidationError
    )
    expect(() => validateDroppedImagePath({ sourcePath: null })).toThrowError(
      PayloadValidationError
    )
  })

  it('validates list queries and product identifiers', () => {
    expect(validateProductListQuery(undefined)).toEqual({ search: '', category: null })
    expect(
      validateProductListQuery({ search: ' 00012 ', category: 'Endodontics' })
    ).toEqual({ search: '00012', category: 'Endodontics' })
    expect(() => validateDeleteProductInput({ id: 0 })).toThrowError(PayloadValidationError)
  })
})
