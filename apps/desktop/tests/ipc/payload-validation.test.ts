// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  PayloadValidationError,
  validateCreateProductInput,
  validateDeleteProductInput,
  validateProductListQuery,
  validateUpdateProductInput
} from '../../src/main/ipc/payload-validation'

describe('Phase 2 IPC payload validation', () => {
  it('preserves leading zeroes while normalizing a product barcode', () => {
    const result = validateCreateProductInput({
      barcode: ' 001234567890 ',
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      initialStock: 4,
      lowStockThreshold: 2,
      imageSelectionToken: null
    })

    expect(result.barcode).toBe('001234567890')
  })

  it.each([
    [{ category: 'Custom category' }, 'category'],
    [{ initialStock: -1 }, 'initialStock'],
    [{ lowStockThreshold: -1 }, 'lowStockThreshold']
  ])('rejects invalid create input for %s', (override, expectedField) => {
    expect(() =>
      validateCreateProductInput({
        barcode: '0001',
        itemName: 'Dental item',
        category: 'General',
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
      currentStock: 2,
      lowStockThreshold: 1,
      replacementImageSelectionToken: null
    })

    expect(result).not.toHaveProperty('replacementImageSelectionToken')
  })

  it('validates list queries and product identifiers', () => {
    expect(validateProductListQuery(undefined)).toEqual({ search: '', category: null })
    expect(
      validateProductListQuery({ search: ' 00012 ', category: 'Endodontics' })
    ).toEqual({ search: '00012', category: 'Endodontics' })
    expect(() => validateDeleteProductInput({ id: 0 })).toThrowError(PayloadValidationError)
  })
})
