import { app, BrowserWindow, Menu, session } from 'electron'
import { join } from 'node:path'
import { resolveApplicationPaths } from './application/application-paths'
import { createAuthSessionController } from './application/auth-session'
import { createAuthenticationService } from './application/create-authentication-service'
import { initializeDatabase, type SqliteDatabase } from './database'
import {
  ProductImageStore,
  registerDentalImageProtocol,
  registerDentalImageSchemePrivileges
} from './images'
import { createInventoryService } from './inventory'
import { registerAuthIpcHandlers } from './ipc/register-auth-handlers'
import { registerInventoryIpcHandlers } from './ipc/register-inventory-handlers'

let mainWindow: BrowserWindow | null = null
let disposeIpcHandlers: (() => void) | null = null
let disposeImageProtocol: (() => void) | null = null
let database: SqliteDatabase | null = null
let imageStore: ProductImageStore | null = null

const WINDOW_TITLE = 'Any Time Dental — Dental Inventory Management System'

// Keep the internal app name stable so existing userData and database paths do not move.
app.setName('Dental Inventory System')
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

function configureApplicationSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
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
  configureApplicationSecurity()
  const applicationPaths = resolveApplicationPaths(
    app.getPath('userData'),
    getDevelopmentDatabasePath()
  )
  database = initializeDatabase({ databasePath: applicationPaths.databasePath })
  imageStore = new ProductImageStore(applicationPaths.productImagesDirectory)
  await imageStore.initialize()

  const authSession = createAuthSessionController()
  const getMainWindow = (): BrowserWindow | null => mainWindow
  const inventoryService = createInventoryService(database)

  disposeImageProtocol = registerDentalImageProtocol(session.defaultSession, imageStore)
  mainWindow = createMainWindow()

  const disposeAuthHandlers = registerAuthIpcHandlers(
    createAuthenticationService(database),
    authSession,
    getMainWindow
  )
  const disposeInventoryHandlers = registerInventoryIpcHandlers({
    inventoryService,
    imageStore,
    authSession,
    getMainWindow
  })
  disposeIpcHandlers = () => {
    disposeInventoryHandlers()
    disposeAuthHandlers()
  }

  await loadMainWindow(mainWindow)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
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
  console.error('Unable to start Dental Inventory System.', error)
  closeApplicationResources()
  app.quit()
})
