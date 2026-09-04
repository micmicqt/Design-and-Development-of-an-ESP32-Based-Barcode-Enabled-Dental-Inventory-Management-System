export const INVENTORY_CATEGORIES = [
  'General',
  'Restorative & Esthetic',
  'Endodontics',
  'Prosthodontics',
  'Surgery',
  'Orthodontics'
] as const

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number]

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
  hardwareGetNextTransactionEvent: 'hardware:get-next-transaction-event',
  hardwareAcknowledgeTransactionEvent: 'hardware:acknowledge-transaction-event'
} as const

export type HardwareConnectionStatus = 'CONNECTED' | 'OFFLINE'

export type HardwareMode = 'idle' | 'restock' | 'checkout' | 'busy'

export interface HardwareStatusDto {
  connection: HardwareConnectionStatus
  device: string | null
  mode: HardwareMode | null
  rtc: boolean | null
  sd: boolean | null
}

export type HardwareTransactionMode = 'restock' | 'checkout'

export interface HardwareTransactionEvent {
  eventId: string
  mode: HardwareTransactionMode
  barcode: string
  timestamp: string
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
  initialStock: number
  lowStockThreshold: number
  imageSelectionToken: string | null
}

export interface UpdateProductInput {
  id: number
  itemName: string
  category: InventoryCategory
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
    getNextTransactionEvent: () => Promise<HardwareTransactionEvent | null>
    acknowledgeTransactionEvent: (
      eventId: string
    ) => Promise<IpcResult<{ eventId: string }>>
  }
}
