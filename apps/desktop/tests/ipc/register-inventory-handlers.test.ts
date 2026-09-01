// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthSessionController } from '../../src/main/application/auth-session'
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
  let authSession: ReturnType<typeof createAuthSessionController>
  let trustedEvent: IpcMainInvokeEvent
  let mainWindow: BrowserWindow
  let dispose: () => void

  beforeEach(async () => {
    electronMock.handlers.clear()
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'dental-ipc-handler-'))
    imageStore = new ProductImageStore(join(temporaryDirectory, 'product-images'))
    inventoryService = createService()
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
      getMainWindow: () => mainWindow
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
  })
})
