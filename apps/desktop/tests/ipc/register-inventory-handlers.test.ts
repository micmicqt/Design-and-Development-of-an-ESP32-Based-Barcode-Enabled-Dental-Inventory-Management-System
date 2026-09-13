// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
import type { OfflineInventoryCacheCoordinator } from '../../src/main/hardware/offline-inventory-cache'
import { ProductImageStore } from '../../src/main/images'
import {
  InventoryServiceError,
  type InventoryService,
  type ProductRecord
} from '../../src/main/inventory'
import { registerInventoryIpcHandlers } from '../../src/main/ipc/register-inventory-handlers'
import {
  IPC_CHANNELS,
  type IpcResult,
  type ProductDto
} from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    showOpenDialog: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler
  },
  dialog: { showOpenDialog: electronMock.showOpenDialog }
}))

const PRODUCT: ProductRecord = {
  id: 1,
  barcode: '00123',
  itemName: 'Dental item',
  category: 'General',
  unitType: 'Piece',
  imagePath: '',
  currentStock: 2,
  lowStockThreshold: 1,
  status: 'HIGH',
  createdAt: '2026-08-31T12:00:00.000Z',
  updatedAt: '2026-08-31T12:00:00.000Z'
}

function createService(): InventoryService {
  return {
    listProducts: vi.fn(() => [PRODUCT]),
    findProductByBarcode: vi.fn(() => PRODUCT),
    createProduct: vi.fn(() => PRODUCT),
    updateProduct: vi.fn(() => PRODUCT),
    deleteProduct: vi.fn(() => PRODUCT),
    listMovementHistory: vi.fn(() => [])
  }
}

describe('authenticated inventory IPC boundary', () => {
  let temporaryDirectory: string
  let imageStore: ProductImageStore
  let inventoryService: InventoryService
  let offlineInventoryCacheCoordinator: OfflineInventoryCacheCoordinator
  let authSession: ReturnType<typeof createAuthSessionController>
  let trustedEvent: IpcMainInvokeEvent
  let mainWindow: BrowserWindow
  let dispose: () => void

  beforeEach(async () => {
    electronMock.handlers.clear()
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'dental-ipc-handler-'))
    imageStore = new ProductImageStore(join(temporaryDirectory, 'product-images'))
    inventoryService = createService()
    offlineInventoryCacheCoordinator = {
      refresh: vi.fn().mockResolvedValue({
        generation: `v1-${'a'.repeat(64)}`,
        itemCount: 1,
        alreadyCurrent: false
      }),
      refreshIfNeeded: vi.fn().mockResolvedValue(null),
      markStale: vi.fn()
    }
    authSession = createAuthSessionController()

    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    }
    mainWindow = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    trustedEvent = {
      sender: webContents,
      senderFrame: mainFrame
    } as unknown as IpcMainInvokeEvent

    dispose = registerInventoryIpcHandlers({
      inventoryService,
      imageStore,
      authSession,
      getMainWindow: () => mainWindow,
      offlineInventoryCacheCoordinator
    })
  })

  afterEach(async () => {
    dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  function handler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
    const registered = electronMock.handlers.get(channel)
    if (registered === undefined) throw new Error(`Missing test IPC handler: ${channel}`)
    return registered
  }

  it('rejects inventory access until the main-process session is authenticated', () => {
    const result = handler(IPC_CHANNELS.productsList)(trustedEvent, {
      search: '',
      category: null
    }) as IpcResult<ProductDto[]>

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Administrator authentication is required.'
      }
    })
    expect(inventoryService.listProducts).not.toHaveBeenCalled()
  })

  it('also rejects an authenticated request from any other frame or window', () => {
    authSession.signIn('admin')
    const untrustedEvent = {
      sender: { isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    } as unknown as IpcMainInvokeEvent

    const result = handler(IPC_CHANNELS.productsList)(untrustedEvent, {
      search: '',
      category: null
    }) as IpcResult<ProductDto[]>

    expect(result.ok).toBe(false)
    expect(inventoryService.listProducts).not.toHaveBeenCalled()
  })

  it('returns renderer-safe DTOs after authentication without exposing image paths', () => {
    authSession.signIn('admin')
    const result = handler(IPC_CHANNELS.productsList)(trustedEvent, {
      search: '001',
      category: null
    }) as IpcResult<ProductDto[]>

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 1,
          barcode: '00123',
          itemName: 'Dental item',
          category: 'General',
          unitType: 'Piece',
          imageUrl: null,
          currentStock: 2,
          lowStockThreshold: 1,
          status: 'HIGH',
          createdAt: '2026-08-31T12:00:00.000Z',
          updatedAt: '2026-08-31T12:00:00.000Z'
        }
      ]
    })
    expect(result).not.toHaveProperty('value.0.imagePath')
  })

  it.each(['00123', ' 00123 ', 'A'.repeat(256)])(
    'passes an exact barcode string to the lookup service without normalization: %s',
    (barcode) => {
      authSession.signIn('admin')
      vi.mocked(inventoryService.findProductByBarcode).mockReturnValue({ ...PRODUCT, barcode })

      const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, barcode)

      expect(inventoryService.findProductByBarcode).toHaveBeenCalledExactlyOnceWith(barcode)
      expect(result).toMatchObject({ ok: true, value: { barcode, currentStock: 2, status: 'HIGH' } })
      expect(inventoryService.createProduct).not.toHaveBeenCalled()
      expect(inventoryService.updateProduct).not.toHaveBeenCalled()
      expect(inventoryService.deleteProduct).not.toHaveBeenCalled()
      expect(inventoryService.listMovementHistory).not.toHaveBeenCalled()
      expect(inventoryService.listProducts).not.toHaveBeenCalled()
    }
  )

  it('returns a successful null lookup for an unregistered barcode', () => {
    authSession.signIn('admin')
    vi.mocked(inventoryService.findProductByBarcode).mockReturnValue(null)

    const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, 'unknown-001')

    expect(result).toEqual({ ok: true, value: null })
    expect(inventoryService.findProductByBarcode).toHaveBeenCalledExactlyOnceWith('unknown-001')
    expect(inventoryService.createProduct).not.toHaveBeenCalled()
    expect(inventoryService.updateProduct).not.toHaveBeenCalled()
    expect(inventoryService.deleteProduct).not.toHaveBeenCalled()
  })

  it('uses the existing managed-image DTO sanitization for a found product', () => {
    authSession.signIn('admin')
    const imagePath = 'product-images/00000000-0000-4000-8000-000000000001.jpg'
    vi.mocked(inventoryService.findProductByBarcode).mockReturnValue({ ...PRODUCT, imagePath })
    const toRendererUrl = vi.spyOn(imageStore, 'toRendererUrl')

    const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, PRODUCT.barcode)

    expect(result).toMatchObject({
      ok: true,
      value: { imageUrl: 'dental-image://product/00000000-0000-4000-8000-000000000001.jpg' }
    })
    expect(toRendererUrl).toHaveBeenCalledExactlyOnceWith(imagePath)
    expect(result).not.toHaveProperty('value.imagePath')
  })

  it('does not expose an unmanaged image path in a barcode lookup result', () => {
    authSession.signIn('admin')
    vi.mocked(inventoryService.findProductByBarcode).mockReturnValue({
      ...PRODUCT,
      imagePath: 'C:/private/clinic/photo.jpg'
    })

    const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, PRODUCT.barcode)

    expect(result).toMatchObject({ ok: true, value: { imageUrl: null } })
    expect(JSON.stringify(result)).not.toContain('C:/private')
  })

  it('blocks barcode lookup when signed out, from another window, or from a subframe', () => {
    const lookup = handler(IPC_CHANNELS.productsFindByBarcode)
    expect(lookup(trustedEvent, PRODUCT.barcode)).toMatchObject({
      ok: false, error: { code: 'UNAUTHORIZED' }
    })

    authSession.signIn('admin')
    for (const event of [
      { ...trustedEvent, sender: { isDestroyed: () => false, mainFrame: {} } },
      { ...trustedEvent, senderFrame: {} }
    ]) {
      expect(lookup(event, PRODUCT.barcode)).toMatchObject({
        ok: false, error: { code: 'UNAUTHORIZED' }
      })
    }
    expect(inventoryService.findProductByBarcode).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 123, {}, ['00123'], '', ' ', 'A'.repeat(257), '001\u0000', '001\n'])(
    'rejects invalid barcode lookup payload before service access: %j',
    (payload) => {
      authSession.signIn('admin')
      const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, payload)

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
      expect(inventoryService.findProductByBarcode).not.toHaveBeenCalled()
    }
  )

  it('sanitizes unexpected lookup errors without returning database details', () => {
    authSession.signIn('admin')
    vi.mocked(inventoryService.findProductByBarcode).mockImplementation(() => {
      throw new Error('SQLITE_ERROR C:/private/clinic/inventory.db')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = handler(IPC_CHANNELS.productsFindByBarcode)(trustedEvent, PRODUCT.barcode)

      expect(result).toEqual({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Unable to complete the request.' }
      })
      expect(JSON.stringify(result)).not.toContain('SQLITE_ERROR')
      expect(JSON.stringify(result)).not.toContain('C:/private')
    } finally {
      log.mockRestore()
    }
  })

  it('disposes the barcode lookup handler with the other inventory handlers', () => {
    expect(electronMock.handlers.has(IPC_CHANNELS.productsFindByBarcode)).toBe(true)
    dispose()
    expect(electronMock.handlers.has(IPC_CHANNELS.productsFindByBarcode)).toBe(false)
  })

  it('validates a dropped image through the existing managed selection store', async () => {
    authSession.signIn('admin')
    const sourcePath = join(temporaryDirectory, 'dropped.png')
    const selection = {
      selectionToken: '00000000-0000-4000-8000-000000000001',
      previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
      originalName: 'dropped.png'
    }
    const createSelection = vi
      .spyOn(imageStore, 'createSelectionFromPath')
      .mockResolvedValue(selection)

    const result = (await handler(IPC_CHANNELS.productsSelectDroppedImage)(trustedEvent, {
      sourcePath
    })) as IpcResult<typeof selection>

    expect(result).toEqual({ ok: true, value: selection })
    expect(createSelection).toHaveBeenCalledWith(sourcePath)
  })

  it('clears an image reference before best-effort cleanup of the old managed file', async () => {
    authSession.signIn('admin')
    const previousProduct = {
      ...PRODUCT,
      imagePath: 'product-images/00000000-0000-4000-8000-000000000001.jpg'
    }
    vi.mocked(inventoryService.listProducts).mockReturnValue([previousProduct])
    vi.mocked(inventoryService.updateProduct).mockReturnValue({
      ...previousProduct,
      imagePath: ''
    })
    const removeManagedImage = vi
      .spyOn(imageStore, 'removeManagedImage')
      .mockResolvedValue(undefined)

    const result = (await handler(IPC_CHANNELS.productsUpdate)(trustedEvent, {
      id: 1,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      currentStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      removeImage: true
    })) as IpcResult<ProductDto>

    expect(result).toMatchObject({ ok: true, value: { id: 1, imageUrl: null } })
    expect(inventoryService.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({ managedImagePath: null })
    )
    expect(removeManagedImage).toHaveBeenCalledWith(previousProduct.imagePath)
    expect(vi.mocked(inventoryService.updateProduct).mock.invocationCallOrder[0]).toBeLessThan(
      removeManagedImage.mock.invocationCallOrder[0] as number
    )
  })

  it('preserves the old managed image when an explicit removal update fails', async () => {
    authSession.signIn('admin')
    const previousProduct = {
      ...PRODUCT,
      imagePath: 'product-images/00000000-0000-4000-8000-000000000001.jpg'
    }
    vi.mocked(inventoryService.listProducts).mockReturnValue([previousProduct])
    vi.mocked(inventoryService.updateProduct).mockImplementation(() => {
      throw new Error('database unavailable')
    })
    const removeManagedImage = vi
      .spyOn(imageStore, 'removeManagedImage')
      .mockResolvedValue(undefined)

    const result = (await handler(IPC_CHANNELS.productsUpdate)(trustedEvent, {
      id: 1,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      currentStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      removeImage: true
    })) as IpcResult<ProductDto>

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(removeManagedImage).not.toHaveBeenCalled()
  })

  it('maps database errors to a stable code without leaking backend details', async () => {
    authSession.signIn('admin')
    vi.mocked(inventoryService.createProduct).mockImplementation(() => {
      throw new InventoryServiceError('DUPLICATE_BARCODE', 'SQLITE_CONSTRAINT products.barcode')
    })

    const result = (await handler(IPC_CHANNELS.productsCreate)(trustedEvent, {
      barcode: '00123',
      itemName: 'Dental item',
      category: 'General',
      unitType: 'Piece',
      initialStock: 0,
      lowStockThreshold: 0,
      imageSelectionToken: null
    })) as IpcResult<ProductDto>

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'DUPLICATE_BARCODE',
        message: 'An item with this barcode already exists.'
      }
    })
    expect(JSON.stringify(result)).not.toContain('SQLITE_CONSTRAINT')
    expect(offlineInventoryCacheCoordinator.refresh).not.toHaveBeenCalled()
  })

  it('refreshes the offline cache only after each authoritative create, update, and delete', async () => {
    authSession.signIn('admin')

    await expect(handler(IPC_CHANNELS.productsCreate)(trustedEvent, {
      barcode: PRODUCT.barcode,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      initialStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      imageSelectionToken: null,
      offlineCacheProducts: [{ barcode: 'renderer-controlled' }]
    })).resolves.toMatchObject({ ok: true, value: { id: PRODUCT.id } })
    const createOrder = vi.mocked(inventoryService.createProduct).mock.invocationCallOrder[0]
    const createRefreshOrder = vi.mocked(
      offlineInventoryCacheCoordinator.refresh
    ).mock.invocationCallOrder[0]
    expect(createOrder).toBeLessThan(createRefreshOrder as number)
    expect(offlineInventoryCacheCoordinator.refresh).toHaveBeenNthCalledWith(1)

    await expect(handler(IPC_CHANNELS.productsUpdate)(trustedEvent, {
      id: PRODUCT.id,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      currentStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold
    })).resolves.toMatchObject({ ok: true, value: { id: PRODUCT.id } })
    const updateOrder = vi.mocked(inventoryService.updateProduct).mock.invocationCallOrder[0]
    const updateRefreshOrder = vi.mocked(
      offlineInventoryCacheCoordinator.refresh
    ).mock.invocationCallOrder[1]
    expect(updateOrder).toBeLessThan(updateRefreshOrder as number)

    await expect(handler(IPC_CHANNELS.productsDelete)(trustedEvent, {
      id: PRODUCT.id
    })).resolves.toEqual({ ok: true, value: { deletedProductId: PRODUCT.id } })
    const deleteOrder = vi.mocked(inventoryService.deleteProduct).mock.invocationCallOrder[0]
    const deleteRefreshOrder = vi.mocked(
      offlineInventoryCacheCoordinator.refresh
    ).mock.invocationCallOrder[2]
    expect(deleteOrder).toBeLessThan(deleteRefreshOrder as number)
    expect(offlineInventoryCacheCoordinator.refresh).toHaveBeenCalledTimes(3)
  })

  it('keeps a successful inventory mutation successful when pending records defer cache refresh', async () => {
    authSession.signIn('admin')
    vi.mocked(offlineInventoryCacheCoordinator.refresh).mockRejectedValueOnce(
      new Error('ESP32 has pending offline records')
    )

    await expect(handler(IPC_CHANNELS.productsCreate)(trustedEvent, {
      barcode: PRODUCT.barcode,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      initialStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      imageSelectionToken: null
    })).resolves.toMatchObject({ ok: true, value: { id: PRODUCT.id } })
    expect(inventoryService.createProduct).toHaveBeenCalledOnce()
    expect(offlineInventoryCacheCoordinator.refresh).toHaveBeenCalledOnce()
  })

  it('does not refresh after unauthorized, invalid, or failed inventory mutations', async () => {
    const create = handler(IPC_CHANNELS.productsCreate)
    await expect(create(trustedEvent, {
      barcode: PRODUCT.barcode,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      initialStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      imageSelectionToken: null
    })).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })

    authSession.signIn('admin')
    await expect(create(trustedEvent, { barcode: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    vi.mocked(inventoryService.createProduct).mockImplementationOnce(() => {
      throw new Error('database unavailable')
    })
    await expect(create(trustedEvent, {
      barcode: PRODUCT.barcode,
      itemName: PRODUCT.itemName,
      category: PRODUCT.category,
      unitType: PRODUCT.unitType,
      initialStock: PRODUCT.currentStock,
      lowStockThreshold: PRODUCT.lowStockThreshold,
      imageSelectionToken: null
    })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })

    expect(offlineInventoryCacheCoordinator.refresh).not.toHaveBeenCalled()
  })
})
