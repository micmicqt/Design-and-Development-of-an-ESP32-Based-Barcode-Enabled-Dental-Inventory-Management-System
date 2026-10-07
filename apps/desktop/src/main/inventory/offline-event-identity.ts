import { createHash } from 'node:crypto'

export interface OfflineIdentityPayload {
  eventId: string
  timestamp: string
  productId: string | number
  barcode: string
  action: string
  delta: number
  resultingStock: number
  stockStatus: string
  cacheGeneration: string
}

// Fixed field order, versioned encoding, exact barcode and timestamp bytes.
export function offlineEventFingerprint(event: OfflineIdentityPayload): string {
  return createHash('sha256').update(JSON.stringify([1, event.eventId, event.timestamp,
    String(event.productId), event.barcode, event.action, event.delta,
    event.resultingStock, event.stockStatus, event.cacheGeneration]), 'utf8').digest('hex')
}

// High-bit sequence values are the corrected durable allocator namespace.
export function isLegacyOfflineEventId(eventId: string): boolean {
  return /^off-[0-9A-F]{12}-[0-7][0-9A-F]{15}$/.test(eventId)
}

export function legacyReceiptIdentity(fingerprint: string): string {
  // Fits the existing receipt key's 63-byte bound; full hash is stored too.
  return `lc-${fingerprint.slice(0, 60)}`
}
