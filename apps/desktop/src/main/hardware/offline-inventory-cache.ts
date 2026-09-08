import { createHash } from 'node:crypto'
import type { InventoryService, ProductRecord } from '../inventory'
import type {
  OfflineInventoryCacheGateway,
  OfflineInventoryCacheInstallResult,
  OfflineInventoryCacheProduct,
  OfflineInventoryCacheSnapshot
} from './hardware-gateway'

function toCacheProduct(product: ProductRecord): OfflineInventoryCacheProduct {
  return {
    id: String(product.id),
    barcode: product.barcode,
    name: product.itemName,
    category: product.category,
    currentStock: product.currentStock,
    lowStockThreshold: product.lowStockThreshold,
    status: product.status
  }
}

/**
 * Builds one deterministic snapshot from InventoryService's active-product
 * view. The explicit ID ordering makes the generation independent of any UI
 * search, filter, or presentation order.
 */
export function buildOfflineInventoryCacheSnapshot(
  inventoryService: InventoryService
): OfflineInventoryCacheSnapshot {
  const products = inventoryService
    .listProducts()
    .slice()
    .sort((left, right) => left.id - right.id)
    .map(toCacheProduct)

  const digest = createHash('sha256')
    .update(JSON.stringify({ version: 1, products }), 'utf8')
    .digest('hex')

  return {
    generation: `v1-${digest}`,
    products
  }
}

export interface OfflineInventoryCacheCoordinator {
  /** Reads SQLite itself; callers cannot supply renderer-owned product data. */
  refresh(): Promise<OfflineInventoryCacheInstallResult>
  /** Used by recurring heartbeats without repeatedly rebuilding a current cache. */
  refreshIfNeeded(): Promise<OfflineInventoryCacheInstallResult | null>
  /** Requires a fresh installation after the hardware connection is lost. */
  markStale(): void
}

export interface OfflineInventoryCacheCoordinatorOptions {
  inventoryService: InventoryService
  gateway: OfflineInventoryCacheGateway
  /** Injectable monotonic-enough wall clock used only to throttle retries. */
  now?: () => number
  /** Failed background attempts wait this long; explicit mutations still retry immediately. */
  failureRetryDelayMs?: number
}

const DEFAULT_FAILURE_RETRY_DELAY_MS = 30_000

/**
 * Coalesces concurrent refresh signals and performs one trailing refresh when
 * inventory changes during an active transfer. A failed transfer never rolls
 * back or otherwise affects the authoritative desktop inventory.
 */
export function createOfflineInventoryCacheCoordinator(
  options: OfflineInventoryCacheCoordinatorOptions
): OfflineInventoryCacheCoordinator {
  const now = options.now ?? Date.now
  const failureRetryDelayMs =
    options.failureRetryDelayMs ?? DEFAULT_FAILURE_RETRY_DELAY_MS
  if (!Number.isSafeInteger(failureRetryDelayMs) || failureRetryDelayMs < 0) {
    throw new TypeError('The offline cache retry delay must be a non-negative integer.')
  }

  let activeRefresh: Promise<OfflineInventoryCacheInstallResult> | null = null
  let trailingRefreshRequested = false
  let refreshRequired = true
  let lastResult: OfflineInventoryCacheInstallResult | null = null
  let retryNotBefore = 0

  async function runRefreshLoop(): Promise<OfflineInventoryCacheInstallResult> {
    let latestResult: OfflineInventoryCacheInstallResult | null = null
    let latestError: unknown

    do {
      trailingRefreshRequested = false
      refreshRequired = false
      try {
        latestResult = await options.gateway.installOfflineInventoryCache(
          buildOfflineInventoryCacheSnapshot(options.inventoryService)
        )
        lastResult = latestResult
        retryNotBefore = 0
        latestError = undefined
      } catch (error: unknown) {
        refreshRequired = true
        retryNotBefore = now() + failureRetryDelayMs
        latestError = error
      }
    } while (trailingRefreshRequested)

    if (latestResult === null || latestError !== undefined) throw latestError
    return latestResult
  }

  function refresh(): Promise<OfflineInventoryCacheInstallResult> {
    refreshRequired = true
    if (activeRefresh !== null) {
      // Only an explicit signal (an authoritative inventory mutation) requests
      // a trailing snapshot. Recurring heartbeat checks merely share the
      // active promise through refreshIfNeeded().
      trailingRefreshRequested = true
      return activeRefresh
    }

    const request = runRefreshLoop()
    activeRefresh = request
    void request.then(
      () => {
        if (activeRefresh === request) activeRefresh = null
      },
      () => {
        if (activeRefresh === request) activeRefresh = null
      }
    )
    return request
  }

  function refreshIfNeeded(): Promise<OfflineInventoryCacheInstallResult | null> {
    if (activeRefresh !== null) return activeRefresh
    if (!refreshRequired) return Promise.resolve(lastResult)
    // A failed transfer can take many bounded item requests before failing.
    // Heartbeats arrive every four seconds, so suppress automatic retries
    // during the cooldown to avoid repeatedly rewriting the MicroSD staging
    // file. An explicit post-mutation refresh bypasses this check.
    if (now() < retryNotBefore) return Promise.resolve(null)
    return refresh()
  }

  function markStale(): void {
    // Do not request an immediate trailing transfer when connection loss races
    // an active request. The next successful heartbeat will refresh, subject to
    // any failure cooldown already in effect.
    refreshRequired = true
  }

  return { refresh, refreshIfNeeded, markStale }
}
