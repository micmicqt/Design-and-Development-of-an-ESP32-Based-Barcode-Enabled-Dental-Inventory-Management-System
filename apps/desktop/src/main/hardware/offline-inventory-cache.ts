import { createHash } from 'node:crypto'
import type { InventoryService, ProductRecord } from '../inventory'
import type {
  OfflineInventoryCacheGateway,
  OfflineInventoryCacheInstallResult,
  OfflineInventoryCacheProduct,
  OfflineInventoryCacheSnapshot,
  Esp32StatusResponse
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
  gateway: OfflineInventoryCacheGateway & { getStatus: () => Promise<Esp32StatusResponse> }
  /** Injectable monotonic-enough wall clock used only to throttle retries. */
  now?: () => number
  /** Failed background attempts wait this long; explicit mutations still retry immediately. */
  failureRetryDelayMs?: number
}

const DEFAULT_FAILURE_RETRY_DELAY_MS = 30_000
export class OfflineCacheRefreshDeferredError extends Error {
  constructor(readonly reason: string) { super('Offline cache publication is deferred until journal retirement is confirmed.') }
}

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
        const snapshot = buildOfflineInventoryCacheSnapshot(options.inventoryService)
        // A heartbeat may begin the final refresh just before Sync requests it.
        // Coalesce an identical trailing snapshot rather than installing twice;
        // a real SQLite mutation changes generation and still publishes again.
        if (latestResult?.generation === snapshot.generation) return latestResult
        {
          const status = await options.gateway.getStatus()
          const ackActive = status.offlineAckState === 'QUEUED' ||
            status.offlineAckState === 'RUNNING' || status.offlineAckState === 'VERIFYING'
          if (status.pendingSyncItems !== 0 || ackActive) {
            const reason = ackActive ? 'retirement_in_progress' :
              status.pendingSyncItems === undefined ? 'journal_not_confirmed_empty' : 'pending_records'
            console.info(`[Offline cache] stage=deferred reason=${reason}`)
            throw new OfflineCacheRefreshDeferredError(reason)
          }
        }
        console.info('[Offline cache] stage=publication_start')
        latestResult = await options.gateway.installOfflineInventoryCache(
          snapshot
        )
        lastResult = latestResult
        retryNotBefore = 0
        latestError = undefined
        console.info('[Offline cache] stage=publication_complete')
      } catch (error: unknown) {
        refreshRequired = true
        retryNotBefore = now() + failureRetryDelayMs
        latestError = error
        if (!(error instanceof OfflineCacheRefreshDeferredError)) console.warn('[Offline cache] stage=publication_failed')
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
