export const INVENTORY_CATEGORIES = [
  'General',
  'Restorative & Esthetic',
  'Endodontics',
  'Prosthodontics',
  'Surgery',
  'Orthodontics'
] as const

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number]

export const PRODUCT_UNIT_TYPES = [
  'Piece',
  'Box',
  'Pack',
  'Set',
  'Bottle',
  'Vial',
  'Cartridge',
  'Gram',
  'mL'
] as const

export type ProductUnitType = (typeof PRODUCT_UNIT_TYPES)[number]

export const STOCK_STATUSES = ['HIGH', 'LOW', 'EMPTY'] as const

export type StockStatus = (typeof STOCK_STATUSES)[number]

export const MOVEMENT_ACTIONS = ['RESTOCK', 'CHECKOUT', 'STOCK_CORRECTION'] as const

export type MovementAction = (typeof MOVEMENT_ACTIONS)[number]

export const IPC_CHANNELS = {
  authGetSession: 'auth:get-session',
  authLogin: 'auth:login',
  authLogout: 'auth:logout',
  productsList: 'products:list',
  productsFindByBarcode: 'products:find-by-barcode',
  productsCreate: 'products:create',
  productsUpdate: 'products:update',
  productsDelete: 'products:delete',
  productsSelectImage: 'products:select-image',
  productsSelectDroppedImage: 'products:select-dropped-image',
  movementHistoryList: 'movement-history:list',
  hardwareGetStatus: 'hardware:get-status',
  hardwareSendDesktopHeartbeat: 'hardware:send-desktop-heartbeat',
  hardwareGetNextOfflineEvent: 'hardware:get-next-offline-event',
  hardwareReconcileNextOfflineEvent: 'hardware:reconcile-next-offline-event',
  hardwareSynchronizeOfflineInventory: 'hardware:synchronize-offline-inventory',
  hardwareGetNextTransactionEvent: 'hardware:get-next-transaction-event',
  hardwareAcknowledgeTransactionEvent: 'hardware:acknowledge-transaction-event',
  hardwareGetTransactionReceipt: 'hardware:get-transaction-receipt',
  hardwareProcessTransaction: 'hardware:process-transaction',
  hardwareRetryTransactionResultDelivery: 'hardware:retry-transaction-result-delivery',
  hardwareRetryTransactionAcknowledgement: 'hardware:retry-transaction-acknowledgement',
  hardwareCaptureRegistrationBarcode: 'hardware:capture-registration-barcode'
} as const

export type HardwareConnectionStatus = 'CONNECTED' | 'OFFLINE'

export type HardwareMode = 'idle' | 'restock' | 'checkout' | 'busy'
export type HardwareRtcState = 'unavailable' | 'needs_sync' | 'ready'
export type HardwareRtcReason =
  | 'none'
  | 'communication_failure'
  | 'lost_power'
  | 'invalid_time'
  | 'verification_failed'

export interface HardwareStatusDto {
  connection: HardwareConnectionStatus
  device: string | null
  mode: HardwareMode | null
  rtc: boolean | null
  /** Omitted when connected firmware predates automatic RTC recovery. */
  rtcState?: HardwareRtcState
  rtcReason?: HardwareRtcReason
  sd: boolean | null
  /** Omitted when connected firmware predates durable offline journaling. */
  pendingSyncItems?: number
  offlineReady?: boolean
}

export type HardwareTransactionMode = 'restock' | 'checkout'

export interface HardwareTransactionEvent {
  eventId: string
  mode: HardwareTransactionMode
  barcode: string
  timestamp: string
}

export type OfflinePendingAction = 'RESTOCK' | 'CHECKOUT'

/** Read-only view of the oldest durable ESP32 offline journal record. */
export interface OfflinePendingEvent {
  eventId: string
  timestamp: string
  /** Stable SQLite identity is kept as decimal text across the embedded boundary. */
  productId: string
  barcode: string
  action: OfflinePendingAction
  delta: 1 | -1
  resultingStock: number
  stockStatus: StockStatus
  cacheGeneration: string
}

export const OFFLINE_RECONCILIATION_CONFLICT_CODES = [
  'INVALID_EVENT',
  'EVENT_ID_CONFLICT',
  'PRODUCT_NOT_ACTIVE',
  'PRODUCT_IDENTITY_CONFLICT',
  'INSUFFICIENT_STOCK',
  'STOCK_OVERFLOW'
] as const

export type OfflineReconciliationConflictCode =
  (typeof OFFLINE_RECONCILIATION_CONFLICT_CODES)[number]

/** Durable SQLite snapshot produced while reconciling one offline journal event. */
export interface OfflineReconciliationReceipt {
  eventId: string
  transactionId: string
  productId: number
  barcode: string
  itemName: string
  category: InventoryCategory
  action: OfflinePendingAction
  delta: 1 | -1
  previousStock: number
  newTotal: number
  status: StockStatus
  /** Firmware-computed audit value; SQLite `newTotal` remains authoritative. */
  offlineResultingStock: number
  /** Firmware-computed audit value; SQLite `status` remains authoritative. */
  offlineStockStatus: StockStatus
  timestamp: string
  cacheGeneration: string
}

export type OfflineReconciliationOutcome =
  | {
      status: 'APPLIED' | 'ALREADY_APPLIED'
      receipt: OfflineReconciliationReceipt
    }
  | {
      status: 'CONFLICT'
      conflict: {
        code: OfflineReconciliationConflictCode
        message: string
        eventId: string
      }
    }
  | { status: 'NO_PENDING_EVENT' }

export interface OfflineSyncCounts {
  appliedEvents: number
  alreadyAppliedEvents: number
  acknowledgedEvents: number
}

export interface OfflineSyncCacheResult {
  generation: string
  itemCount: number
  alreadyCurrent: boolean
}

/** Backend-owned synchronization result; the renderer supplies no journal data. */
export type OfflineSyncOutcome =
  | {
      status: 'COMPLETE'
      counts: OfflineSyncCounts
      pendingSyncItems: 0
      cache: OfflineSyncCacheResult
    }
  | {
      status: 'CONFLICT'
      counts: OfflineSyncCounts
      conflict: {
        code: OfflineReconciliationConflictCode
        message: string
        eventId: string
      }
    }
  | {
      status: 'ACKNOWLEDGEMENT_PENDING'
      counts: OfflineSyncCounts
      eventId: string
    }
  | {
      status: 'CACHE_REFRESH_FAILED'
      counts: OfflineSyncCounts
      pendingSyncItems: 0
    }

/** Durable snapshot of a committed online transaction, not live product stock. */
export interface HardwareTransactionReceipt extends HardwareTransactionEvent {
  transactionId: string
  productId: number
  itemName: string
  category: InventoryCategory
  quantity: number
  previousStock: number
  newTotal: number
  status: StockStatus
  /** Persisted after the ESP32 accepts this committed result. */
  resultDeliveredToHardware: boolean
}

export interface HardwareTransactionResult {
  eventId: string
  result: 'success'
  mode: HardwareTransactionMode
  quantity: number
  resultingStock: number
  stockStatus: StockStatus
}

export interface ProcessHardwareTransactionInput {
  eventId: string
  quantity: number
}

/** ok=true always means SQLite committed, even when later result delivery or ACK failed. */
export interface HardwareTransactionOutcome {
  receipt: HardwareTransactionReceipt
  acknowledged: boolean
}

export interface LoginCredentials {
  username: string
  password: string
}

export interface AuthSession {
  authenticated: boolean
  username: string | null
}

export type LoginResult =
  | {
      ok: true
      session: AuthSession & { authenticated: true; username: string }
    }
  | {
      ok: false
      message: 'Access Denied'
      session: AuthSession & { authenticated: false; username: null }
    }

export const IPC_ERROR_CODES = [
  'UNAUTHORIZED',
  'VALIDATION_ERROR',
  'DUPLICATE_BARCODE',
  'NOT_FOUND',
  'IMAGE_INVALID_TYPE',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNAVAILABLE',
  'INTERNAL_ERROR'
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcError {
  code: IpcErrorCode
  message: string
  fieldErrors?: Readonly<Record<string, string>>
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

export interface ProductListQuery {
  search: string
  category: InventoryCategory | null
}

export interface ProductDto {
  id: number
  barcode: string
  itemName: string
  category: InventoryCategory
  unitType: ProductUnitType
  imageUrl: string | null
  currentStock: number
  lowStockThreshold: number
  status: StockStatus
  createdAt: string
  updatedAt: string
}

export interface CreateProductInput {
  barcode: string
  itemName: string
  category: InventoryCategory
  unitType: ProductUnitType
  initialStock: number
  lowStockThreshold: number
  imageSelectionToken: string | null
}

export interface UpdateProductInput {
  id: number
  itemName: string
  category: InventoryCategory
  unitType: ProductUnitType
  currentStock: number
  lowStockThreshold: number
  /** Omit (or pass null) to retain the current image. */
  replacementImageSelectionToken?: string | null
  /** Explicitly removes the current image. Cannot be combined with a replacement token. */
  removeImage?: boolean
}

export interface DeleteProductInput {
  id: number
}

export interface DeletedProductResult {
  deletedProductId: number
}

export interface SelectedImageDto {
  /** Opaque, short-lived token. It is not a filesystem path. */
  selectionToken: string
  previewDataUrl: string
  originalName: string
}

export interface MovementHistoryDto {
  transactionId: string
  occurredAt: string
  itemName: string
  category: InventoryCategory
  action: MovementAction
  /** Stock corrections use a signed quantity; other actions use a positive quantity. */
  quantity: number
  newTotal: number
}

export interface DesktopApi {
  auth: {
    getSession: () => Promise<AuthSession>
    login: (credentials: LoginCredentials) => Promise<LoginResult>
    logout: () => Promise<AuthSession>
  }
  inventory: {
    listProducts: (query: ProductListQuery) => Promise<IpcResult<ProductDto[]>>
    /** Exact active-product lookup. A successful null result means unregistered. */
    findProductByBarcode: (barcode: string) => Promise<IpcResult<ProductDto | null>>
    createProduct: (input: CreateProductInput) => Promise<IpcResult<ProductDto>>
    updateProduct: (input: UpdateProductInput) => Promise<IpcResult<ProductDto>>
    deleteProduct: (input: DeleteProductInput) => Promise<IpcResult<DeletedProductResult>>
    selectImage: () => Promise<IpcResult<SelectedImageDto | null>>
    selectDroppedImage: (file: File) => Promise<IpcResult<SelectedImageDto>>
    listMovementHistory: () => Promise<IpcResult<MovementHistoryDto[]>>
  }
  hardware: {
    getStatus: () => Promise<HardwareStatusDto>
    /** Refreshes the ESP32 desktop-presence lease through a fixed backend route. */
    sendDesktopHeartbeat: () => Promise<boolean>
    /** Retrieves without retiring the oldest durable offline event. */
    getNextOfflineEvent: () => Promise<IpcResult<OfflinePendingEvent | null>>
    /** Applies the backend-retrieved oldest offline event to SQLite without acknowledging it. */
    reconcileNextOfflineEvent: () => Promise<IpcResult<OfflineReconciliationOutcome>>
    /** Drains, durably reconciles, acknowledges, and refreshes the final cache backend-side. */
    synchronizeOfflineInventory: () => Promise<IpcResult<OfflineSyncOutcome>>
    getNextTransactionEvent: () => Promise<HardwareTransactionEvent | null>
    acknowledgeTransactionEvent: (
      eventId: string
    ) => Promise<IpcResult<{ eventId: string }>>
    getTransactionReceipt: (eventId: string) => Promise<IpcResult<HardwareTransactionReceipt | null>>
    processTransaction: (input: ProcessHardwareTransactionInput) => Promise<IpcResult<HardwareTransactionOutcome>>
    retryTransactionResultDelivery: (eventId: string) => Promise<IpcResult<HardwareTransactionOutcome>>
    retryTransactionAcknowledgement: (eventId: string) => Promise<IpcResult<HardwareTransactionOutcome>>
    /** Triggers one isolated scanner capture that cannot create a stock transaction. */
    captureRegistrationBarcode: () => Promise<IpcResult<{ barcode: string }>>
  }
}
