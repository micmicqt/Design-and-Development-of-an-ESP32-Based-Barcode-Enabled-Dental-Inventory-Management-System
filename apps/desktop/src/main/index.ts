import { app, BrowserWindow, Menu, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { prepareStableUserDataPath, resolveApplicationPaths } from './application/application-paths'
import { createAuthSessionController, type AuthSessionController } from './application/auth-session'
import { createAuthenticationService, createFirstRunAdminService } from './application/create-authentication-service'
import { initializeDatabase, type SqliteDatabase } from './database'
import {
  ProductImageStore,
  registerDentalImageProtocol,
  registerDentalImageSchemePrivileges
} from './images'
import { createInventoryService } from './inventory'
import { DeviceConfigurationStore, type DeviceConfiguration } from './hardware/device-configuration-store'
import { createBluetoothSelectionController } from './hardware/bluetooth-selection'
import { Esp32HttpGateway } from './hardware/esp32-http-gateway'
import { createOfflineInventoryCacheCoordinator } from './hardware/offline-inventory-cache'
import { createOfflineSyncCoordinator } from './hardware/offline-sync-coordinator'
import { createHardwareTransactionCoordinator } from './hardware/hardware-transaction-coordinator'
import { createRtcRecoveryCoordinator } from './hardware/rtc-recovery-coordinator'
import { registerAuthIpcHandlers } from './ipc/register-auth-handlers'
import { registerDeviceSetupIpcHandlers } from './ipc/register-device-setup-handlers'
import { registerHardwareIpcHandlers } from './ipc/register-hardware-handlers'
import { registerInventoryIpcHandlers } from './ipc/register-inventory-handlers'

let mainWindow: BrowserWindow | null = null
let disposeIpcHandlers: (() => void) | null = null
let disposeImageProtocol: (() => void) | null = null
let database: SqliteDatabase | null = null
let imageStore: ProductImageStore | null = null

const WINDOW_TITLE = 'Any Time Dental Inventory System'

// Visible branding can change without moving the existing clinic database or
// product images. This must run before app.whenReady() and database startup.
app.setName('Any Time Dental Inventory System')
app.setPath('userData', prepareStableUserDataPath(app.getPath('appData')))
registerDentalImageSchemePrivileges()

function getDevelopmentDatabasePath(): string | undefined {
  const developmentPath = !app.isPackaged
    ? process.env.DENTAL_DATABASE_PATH?.trim()
    : undefined
  return developmentPath || undefined
}

function closeApplicationResources(): void {
  disposeIpcHandlers?.()
  disposeIpcHandlers = null
  disposeImageProtocol?.()
  disposeImageProtocol = null
  imageStore?.clearSelections()
  imageStore = null
  database?.close()
  database = null
}

function bluetoothPermissionAllowed(contents: Electron.WebContents | null, permission: string,
                                   authSession: AuthSessionController): boolean {
  return permission === 'bluetooth' && contents !== null && mainWindow !== null &&
    contents === mainWindow.webContents && authSession.isAuthenticated()
}

function configureApplicationSecurity(authSession: AuthSessionController): void {
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    bluetoothPermissionAllowed(contents, String(permission), authSession))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(bluetoothPermissionAllowed(contents, String(permission), authSession))
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7fb',
    title: WINDOW_TITLE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

async function loadMainWindow(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && developmentUrl) {
    await window.loadURL(developmentUrl)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function startDesktopApplication(): Promise<void> {
  await app.whenReady()

  Menu.setApplicationMenu(null)
  const authSession = createAuthSessionController()
  configureApplicationSecurity(authSession)
  const applicationPaths = resolveApplicationPaths(
    app.getPath('userData'),
    getDevelopmentDatabasePath()
  )
  database = initializeDatabase({ databasePath: applicationPaths.databasePath })
  imageStore = new ProductImageStore(applicationPaths.productImagesDirectory)
  await imageStore.initialize()

  const bluetoothSelection = createBluetoothSelectionController(authSession)
  const getMainWindow = (): BrowserWindow | null => mainWindow
  const inventoryService = createInventoryService(database)
  const deviceConfigurationStore = new DeviceConfigurationStore(app.getPath('userData'), safeStorage)

  disposeImageProtocol = registerDentalImageProtocol(session.defaultSession, imageStore)
  mainWindow = createMainWindow()
  bluetoothSelection.attach(mainWindow)

  const disposeAuthHandlers = registerAuthIpcHandlers(
    createAuthenticationService(database),
    createFirstRunAdminService(database),
    authSession,
    getMainWindow
  )
  let disposeInventoryHandlers: (() => void) | null = null
  let disposeHardwareHandlers: (() => void) | null = null
  let pendingHardwareMutations = 0
  function activateHardware(configuration: {
    baseUrl: string
    deviceToken: string | null
  } | null): void {
    // The renderer owns the sole polling loops. Switching IPC registrations
    // routes subsequent calls to a fresh immutable gateway/coordinator set;
    // any call already running finishes against its original device.
    const nextGateway = configuration === null ? null : new Esp32HttpGateway(configuration)
    const transactionCoordinator = createHardwareTransactionCoordinator({
      inventoryService, gateway: nextGateway
    })
    const offlineInventoryCacheCoordinator = nextGateway === null ? null :
      createOfflineInventoryCacheCoordinator({ inventoryService, gateway: nextGateway })
    const offlineSyncCoordinator = nextGateway === null || offlineInventoryCacheCoordinator === null
      ? null : createOfflineSyncCoordinator({
          inventoryService, gateway: nextGateway, offlineInventoryCacheCoordinator
        })
    const rtcRecoveryCoordinator = nextGateway === null ? null :
      createRtcRecoveryCoordinator({ gateway: nextGateway })

    disposeHardwareHandlers?.()
    disposeInventoryHandlers?.()
    disposeInventoryHandlers = registerInventoryIpcHandlers({
      inventoryService, imageStore: imageStore!, authSession, getMainWindow,
      offlineInventoryCacheCoordinator
    })
    disposeHardwareHandlers = registerHardwareIpcHandlers({
      gateway: nextGateway, inventoryService, transactionCoordinator,
      offlineInventoryCacheCoordinator, offlineSyncCoordinator,
      rtcRecoveryCoordinator, authSession, getMainWindow,
      unconfigured: configuration === null,
      onMutationPendingChange: (pending) => { pendingHardwareMutations = pending }
    })
  }
  activateHardware(deviceConfigurationStore.resolve().configuration)
  const disposeDeviceSetupHandlers = registerDeviceSetupIpcHandlers({
    store: deviceConfigurationStore, authSession, getMainWindow,
    canActivate: () => pendingHardwareMutations === 0,
    activate: (configuration: DeviceConfiguration) => activateHardware(configuration),
    selectBluetooth: (id) => bluetoothSelection.select(id)
  })
  disposeIpcHandlers = () => {
    disposeDeviceSetupHandlers()
    bluetoothSelection.cancel()
    disposeHardwareHandlers?.()
    disposeInventoryHandlers?.()
    disposeAuthHandlers()
  }

  await loadMainWindow(mainWindow)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      bluetoothSelection.attach(mainWindow)
      await loadMainWindow(mainWindow)
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeApplicationResources()
})

void startDesktopApplication().catch((error: unknown) => {
  console.error('Unable to start Any Time Dental Inventory System.', error)
  closeApplicationResources()
  app.quit()
})
