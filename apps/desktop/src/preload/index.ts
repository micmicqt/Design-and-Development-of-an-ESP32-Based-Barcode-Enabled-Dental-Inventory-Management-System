import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  type CreateProductInput,
  type DeleteProductInput,
  type DesktopApi,
  type IpcResult,
  type LoginCredentials,
  type ProductListQuery,
  type SelectedImageDto,
  type UpdateProductInput
} from '../shared/ipc-contract'

function droppedImageFailure(message: string): Promise<IpcResult<SelectedImageDto>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'IMAGE_UNAVAILABLE', message }
  })
}

const desktopApi: DesktopApi = Object.freeze({
  auth: Object.freeze({
    getSession: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSession),
    login: (credentials: LoginCredentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.authLogin, {
        username: credentials.username,
        password: credentials.password
      }),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout)
  }),
  inventory: Object.freeze({
    listProducts: (query: ProductListQuery) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsList, {
        search: query.search,
        category: query.category
      }),
    createProduct: (input: CreateProductInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsCreate, {
        barcode: input.barcode,
        itemName: input.itemName,
        category: input.category,
        initialStock: input.initialStock,
        lowStockThreshold: input.lowStockThreshold,
        imageSelectionToken: input.imageSelectionToken
      }),
    updateProduct: (input: UpdateProductInput) => {
      const payload: UpdateProductInput = {
        id: input.id,
        itemName: input.itemName,
        category: input.category,
        currentStock: input.currentStock,
        lowStockThreshold: input.lowStockThreshold
      }

      if (input.replacementImageSelectionToken !== undefined) {
        payload.replacementImageSelectionToken = input.replacementImageSelectionToken
      }
      if (input.removeImage !== undefined) payload.removeImage = input.removeImage

      return ipcRenderer.invoke(IPC_CHANNELS.productsUpdate, payload)
    },
    deleteProduct: (input: DeleteProductInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsDelete, { id: input.id }),
    selectImage: () => ipcRenderer.invoke(IPC_CHANNELS.productsSelectImage),
    selectDroppedImage: (file: File) => {
      try {
        const sourcePath = webUtils.getPathForFile(file)
        if (sourcePath.length === 0) {
          return droppedImageFailure('The dropped image is no longer available.')
        }
        return ipcRenderer.invoke(IPC_CHANNELS.productsSelectDroppedImage, { sourcePath })
      } catch {
        return droppedImageFailure('The dropped image could not be accessed. Try browsing instead.')
      }
    },
    listMovementHistory: () => ipcRenderer.invoke(IPC_CHANNELS.movementHistoryList)
  })
})

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
