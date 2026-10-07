import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  type CreateProductInput,
  type DeleteProductInput,
  type DesktopApi,
  type BluetoothCandidate,
  type DiscoveredInventoryDevice,
  type IpcResult,
  type LoginCredentials,
  type ProcessHardwareTransactionInput,
  type ProductListQuery,
  type SelectedImageDto,
  type UpdateProductInput
} from '../shared/ipc-contract'
import { DENTAL_BLE_INFO_UUID, DENTAL_BLE_SERVICE_UUID, parseDeviceIdentity } from '../shared/device-discovery-protocol'

interface DiscoveryBluetoothDevice {
  gatt?: {
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<{
      getCharacteristic(uuid: string): Promise<{ readValue(): Promise<DataView> }>
    }> }>
    disconnect(): void
  }
}

async function boundedBle<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('BLE timeout')), 8000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function scanBluetooth(
  onCandidates: (candidates: BluetoothCandidate[]) => void
): Promise<IpcResult<DiscoveredInventoryDevice>> {
  const bluetooth = (navigator as Navigator & { bluetooth?: {
    requestDevice(options: object): Promise<DiscoveryBluetoothDevice>
  } }).bluetooth
  if (!bluetooth) return { ok: false, error: {
    code: 'DEVICE_DISCOVERY_FAILED', message: 'Bluetooth discovery is not available on this computer.'
  } }
  const onList = (_event: unknown, candidates: BluetoothCandidate[]): void => {
    onCandidates(candidates.filter((item) =>
      typeof item.id === 'string' && item.name.startsWith('AnyTimeDental-Inventory')))
  }
  ipcRenderer.on('device-setup:bluetooth-candidates', onList)
  let device: DiscoveryBluetoothDevice | null = null
  try {
    // requestDevice is invoked directly in the button's user-activation turn.
    // Electron's main process handles the chooser; React gets only the selected identity.
    device = await bluetooth.requestDevice({ filters: [{ services: [DENTAL_BLE_SERVICE_UUID] }] })
    if (!device.gatt) throw new Error('No GATT server')
    const server = await boundedBle(device.gatt.connect())
    const service = await boundedBle(server.getPrimaryService(DENTAL_BLE_SERVICE_UUID))
    const characteristic = await boundedBle(service.getCharacteristic(DENTAL_BLE_INFO_UUID))
    const value = await boundedBle(characteristic.readValue())
    if (value.byteLength > 112) throw new Error('Oversized BLE identity')
    const identity = parseDeviceIdentity(new TextDecoder().decode(value))
    if (!identity) throw new Error('Invalid BLE identity')
    return { ok: true, value: identity }
  } catch {
    return { ok: false, error: {
      code: 'DEVICE_DISCOVERY_FAILED',
      message: 'Bluetooth identification did not complete. Check Bluetooth, select the Inventory Device, and try again.'
    } }
  } finally {
    device?.gatt?.disconnect()
    ipcRenderer.removeListener('device-setup:bluetooth-candidates', onList)
  }
}

function droppedImageFailure(message: string): Promise<IpcResult<SelectedImageDto>> {
  return Promise.resolve({
    ok: false,
    error: { code: 'IMAGE_UNAVAILABLE', message }
  })
}

const desktopApi: DesktopApi = Object.freeze({
  auth: Object.freeze({
    getSession: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSession),
    needsSetup: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSetupState),
    createFirstAdmin: (credentials: LoginCredentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.authCreateFirstAdmin, {
        username: credentials.username,
        password: credentials.password
      }),
    login: (credentials: LoginCredentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.authLogin, {
        username: credentials.username,
        password: credentials.password
      }),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout)
  }),
  inventory: Object.freeze({
    findProductByBarcode: (barcode: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsFindByBarcode, barcode),
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
        unitType: input.unitType,
        initialStock: input.initialStock,
        lowStockThreshold: input.lowStockThreshold,
        imageSelectionToken: input.imageSelectionToken
      }),
    updateProduct: (input: UpdateProductInput) => {
      const payload: UpdateProductInput = {
        id: input.id,
        itemName: input.itemName,
        category: input.category,
        unitType: input.unitType,
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
  }),
  hardware: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.hardwareGetStatus),
    sendDesktopHeartbeat: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareSendDesktopHeartbeat),
    getNextOfflineEvent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareGetNextOfflineEvent),
    reconcileNextOfflineEvent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareReconcileNextOfflineEvent),
    synchronizeOfflineInventory: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareSynchronizeOfflineInventory),
    getNextTransactionEvent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareGetNextTransactionEvent),
    acknowledgeTransactionEvent: (eventId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent, eventId),
    getTransactionReceipt: (eventId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareGetTransactionReceipt, eventId),
    processTransaction: (input: ProcessHardwareTransactionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareProcessTransaction, {
        eventId: input.eventId,
        quantity: input.quantity
      }),
    retryTransactionResultDelivery: (eventId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareRetryTransactionResultDelivery, eventId),
    retryTransactionAcknowledgement: (eventId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareRetryTransactionAcknowledgement, eventId),
    captureRegistrationBarcode: () =>
      ipcRenderer.invoke(IPC_CHANNELS.hardwareCaptureRegistrationBarcode)
  }),
  deviceSetup: Object.freeze({
    getConfiguration: () => ipcRenderer.invoke(IPC_CHANNELS.deviceSetupGet),
    testConnection: (address: string) => ipcRenderer.invoke(IPC_CHANNELS.deviceSetupTest, address),
    saveConfiguration: (address: string, token: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.deviceSetupSave, { address, token }),
    listSerialPorts: () => ipcRenderer.invoke(IPC_CHANNELS.deviceSetupListSerialPorts),
    identifyUsbDevice: (port: string) => ipcRenderer.invoke(IPC_CHANNELS.deviceSetupIdentifyUsb, port),
    scanBluetooth,
    selectBluetoothDevice: async (id: string) => {
      await ipcRenderer.invoke(IPC_CHANNELS.deviceSetupSelectBluetooth, id)
    }
  })
})

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
