import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type CreateProductInput,
  type DeleteProductInput,
  type DesktopApi,
  type LoginCredentials,
  type ProductListQuery,
  type UpdateProductInput
} from '../shared/ipc-contract'

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

      return ipcRenderer.invoke(IPC_CHANNELS.productsUpdate, payload)
    },
    deleteProduct: (input: DeleteProductInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsDelete, { id: input.id }),
    selectImage: () => ipcRenderer.invoke(IPC_CHANNELS.productsSelectImage),
    listMovementHistory: () => ipcRenderer.invoke(IPC_CHANNELS.movementHistoryList)
  })
})

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
