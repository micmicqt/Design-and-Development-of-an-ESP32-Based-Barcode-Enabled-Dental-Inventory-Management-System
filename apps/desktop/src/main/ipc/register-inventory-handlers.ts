import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import {
  InventoryServiceError,
  type InventoryService,
  type MovementHistoryRecord,
  type ProductRecord
} from '../inventory'
import { ProductImageError, type ProductImageStore } from '../images'
import type { OfflineInventoryCacheCoordinator } from '../hardware/offline-inventory-cache'
import {
  IPC_CHANNELS,
  type CreateProductInput,
  type DeletedProductResult,
  type IpcError,
  type IpcResult,
  type MovementHistoryDto,
  type ProductDto,
  type ProductListQuery,
  type SelectedImageDto,
  type UpdateProductInput
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'
import {
  PayloadValidationError,
  validateBarcodeLookupPayload,
  validateCreateProductInput,
  validateDeleteProductInput,
  validateDroppedImagePath,
  validateProductListQuery,
  validateUpdateProductInput
} from './payload-validation'

export interface RegisterInventoryIpcHandlersOptions {
  inventoryService: InventoryService
  imageStore: ProductImageStore
  authSession: AuthSessionController
  getMainWindow: MainWindowProvider
  offlineInventoryCacheCoordinator?: OfflineInventoryCacheCoordinator | null
}

const unauthorizedError: IpcError = {
  code: 'UNAUTHORIZED',
  message: 'Administrator authentication is required.'
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function failure<T>(error: IpcError): IpcResult<T> {
  return { ok: false, error }
}

function toProductDto(product: ProductRecord, imageStore: ProductImageStore): ProductDto {
  return {
    id: product.id,
    barcode: product.barcode,
    itemName: product.itemName,
    category: product.category,
    imageUrl: imageStore.toRendererUrl(product.imagePath),
    currentStock: product.currentStock,
    lowStockThreshold: product.lowStockThreshold,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  }
}

function toMovementHistoryDto(record: MovementHistoryRecord): MovementHistoryDto {
  return {
    transactionId: record.transactionId,
    occurredAt: record.occurredAt,
    itemName: record.itemName,
    category: record.category,
    action: record.action,
    quantity: record.quantity,
    newTotal: record.newTotal
  }
}

function sanitizedFailure<T>(error: unknown): IpcResult<T> {
  if (error instanceof PayloadValidationError) {
    return failure({
      code: 'VALIDATION_ERROR',
      message: 'Check the highlighted fields and try again.',
      fieldErrors: error.fieldErrors
    })
  }

  if (error instanceof ProductImageError) {
    return failure({ code: error.code, message: error.message })
  }

  if (error instanceof InventoryServiceError) {
    switch (error.code) {
      case 'DUPLICATE_BARCODE':
        return failure({
          code: 'DUPLICATE_BARCODE',
          message: 'An item with this barcode already exists.',
          fieldErrors: { barcode: 'This barcode is already registered.' }
        })
      case 'PRODUCT_NOT_FOUND':
        return failure({ code: 'NOT_FOUND', message: 'The requested item was not found.' })
      case 'VALIDATION_ERROR':
        return failure({ code: 'VALIDATION_ERROR', message: error.message })
    }
  }

  console.error('Inventory IPC request failed internally.', error)
  return failure({ code: 'INTERNAL_ERROR', message: 'Unable to complete the request.' })
}

function isAuthorized(
  event: IpcMainInvokeEvent,
  authSession: AuthSessionController,
  getMainWindow: MainWindowProvider
): boolean {
  return isTrustedMainFrame(event, getMainWindow) && authSession.isAuthenticated()
}

async function compensateImageCopy(
  imageStore: ProductImageStore,
  relativePath: string | undefined
): Promise<void> {
  if (relativePath === undefined) return
  try {
    await imageStore.removeManagedImage(relativePath)
  } catch (error: unknown) {
    console.error('Unable to remove an uncommitted managed product image.', error)
  }
}

async function removeReplacedImage(
  imageStore: ProductImageStore,
  previousPath: string | null | undefined
): Promise<void> {
  try {
    await imageStore.removeManagedImage(previousPath)
  } catch (error: unknown) {
    // The database operation already succeeded. An orphaned file is safer than
    // reporting a failed inventory mutation and inviting a duplicate retry.
    console.warn('Unable to remove an obsolete managed product image.', error)
  }
}

export function registerInventoryIpcHandlers(
  options: RegisterInventoryIpcHandlersOptions
): () => void {
  const {
    inventoryService,
    imageStore,
    authSession,
    getMainWindow,
    offlineInventoryCacheCoordinator = null
  } = options

  function refreshOfflineCacheAfterMutation(): void {
    if (offlineInventoryCacheCoordinator === null) return
    try {
      void offlineInventoryCacheCoordinator.refresh().catch(() => {
        // The desktop database is authoritative. A cache transport failure must
        // never turn a successful inventory write into a failed UI operation.
      })
    } catch {
      // A cache implementation failure must not escape into inventory IPC.
    }
  }

  ipcMain.handle(
    IPC_CHANNELS.productsFindByBarcode,
    (event, rawBarcode: unknown): IpcResult<ProductDto | null> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        const barcode = validateBarcodeLookupPayload(rawBarcode)
        const product = inventoryService.findProductByBarcode(barcode)
        return ok(product === null ? null : toProductDto(product, imageStore))
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsList,
    (event, rawQuery: unknown): IpcResult<ProductDto[]> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        const query: ProductListQuery = validateProductListQuery(rawQuery)
        return ok(
          inventoryService
            .listProducts(query)
            .map((product) => toProductDto(product, imageStore))
        )
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsCreate,
    async (event, rawInput: unknown): Promise<IpcResult<ProductDto>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      let storedImagePath: string | undefined
      let selectionToken: string | null = null
      try {
        const input: CreateProductInput = validateCreateProductInput(rawInput)
        selectionToken = input.imageSelectionToken
        if (selectionToken !== null) {
          storedImagePath = (await imageStore.persistSelection(selectionToken)).relativePath
        }

        const product = inventoryService.createProduct({
          barcode: input.barcode,
          itemName: input.itemName,
          category: input.category,
          initialStock: input.initialStock,
          lowStockThreshold: input.lowStockThreshold,
          managedImagePath: storedImagePath
        })
        if (selectionToken !== null) imageStore.discardSelection(selectionToken)
        refreshOfflineCacheAfterMutation()
        return ok(toProductDto(product, imageStore))
      } catch (error: unknown) {
        await compensateImageCopy(imageStore, storedImagePath)
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsUpdate,
    async (event, rawInput: unknown): Promise<IpcResult<ProductDto>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      let storedImagePath: string | undefined
      let selectionToken: string | undefined
      try {
        const input: UpdateProductInput = validateUpdateProductInput(rawInput)
        selectionToken = input.replacementImageSelectionToken ?? undefined
        const previousProduct = inventoryService.listProducts().find((product) => product.id === input.id)

        if (selectionToken !== undefined) {
          storedImagePath = (await imageStore.persistSelection(selectionToken)).relativePath
        }

        const product = inventoryService.updateProduct({
          id: input.id,
          itemName: input.itemName,
          category: input.category,
          currentStock: input.currentStock,
          lowStockThreshold: input.lowStockThreshold,
          managedImagePath: input.removeImage === true ? null : storedImagePath
        })

        if (selectionToken !== undefined) {
          imageStore.discardSelection(selectionToken)
        }
        if (selectionToken !== undefined || input.removeImage === true) {
          await removeReplacedImage(imageStore, previousProduct?.imagePath)
        }
        refreshOfflineCacheAfterMutation()
        return ok(toProductDto(product, imageStore))
      } catch (error: unknown) {
        await compensateImageCopy(imageStore, storedImagePath)
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsDelete,
    async (event, rawInput: unknown): Promise<IpcResult<DeletedProductResult>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        const input = validateDeleteProductInput(rawInput)
        const deletedProduct = inventoryService.deleteProduct(input)
        await removeReplacedImage(imageStore, deletedProduct.imagePath)
        refreshOfflineCacheAfterMutation()
        return ok({ deletedProductId: deletedProduct.id })
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsSelectImage,
    async (event): Promise<IpcResult<SelectedImageDto | null>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)
      const window = getMainWindow()
      if (window === null) return failure(unauthorizedError)

      try {
        const selection = await dialog.showOpenDialog(window, {
          title: 'Select a product reference image',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        })
        if (selection.canceled || selection.filePaths.length === 0) return ok(null)
        const selectedPath = selection.filePaths[0]
        if (selectedPath === undefined) return ok(null)
        return ok(await imageStore.createSelectionFromPath(selectedPath))
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.productsSelectDroppedImage,
    async (event, rawInput: unknown): Promise<IpcResult<SelectedImageDto>> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        const sourcePath = validateDroppedImagePath(rawInput)
        return ok(await imageStore.createSelectionFromPath(sourcePath))
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.movementHistoryList,
    (event): IpcResult<MovementHistoryDto[]> => {
      if (!isAuthorized(event, authSession, getMainWindow)) return failure(unauthorizedError)

      try {
        return ok(inventoryService.listMovementHistory().map(toMovementHistoryDto))
      } catch (error: unknown) {
        return sanitizedFailure(error)
      }
    }
  )

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.productsFindByBarcode)
    ipcMain.removeHandler(IPC_CHANNELS.productsList)
    ipcMain.removeHandler(IPC_CHANNELS.productsCreate)
    ipcMain.removeHandler(IPC_CHANNELS.productsUpdate)
    ipcMain.removeHandler(IPC_CHANNELS.productsDelete)
    ipcMain.removeHandler(IPC_CHANNELS.productsSelectImage)
    ipcMain.removeHandler(IPC_CHANNELS.productsSelectDroppedImage)
    ipcMain.removeHandler(IPC_CHANNELS.movementHistoryList)
  }
}
