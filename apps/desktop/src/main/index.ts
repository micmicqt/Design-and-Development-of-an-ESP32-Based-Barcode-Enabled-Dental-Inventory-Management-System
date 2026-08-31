import { app, BrowserWindow, Menu, session } from 'electron'
import { join } from 'node:path'
import { createAuthenticationService } from './application/create-authentication-service'
import {
  initializeDatabase,
  initializeProductionDatabase,
  type SqliteDatabase
} from './database'
import { registerAuthIpcHandlers } from './ipc/register-auth-handlers'

let mainWindow: BrowserWindow | null = null
let disposeAuthHandlers: (() => void) | null = null
let database: SqliteDatabase | null = null

app.setName('Dental Inventory System')

function initializeApplicationDatabase(): SqliteDatabase {
  const developmentPath = !app.isPackaged
    ? process.env.DENTAL_DATABASE_PATH?.trim()
    : undefined

  if (developmentPath) {
    return initializeDatabase({ databasePath: developmentPath })
  }

  return initializeProductionDatabase(app.getPath('userData'))
}

function closeApplicationResources(): void {
  disposeAuthHandlers?.()
  disposeAuthHandlers = null
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

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7f6',
    title: 'Dental Inventory System',
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

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && developmentUrl) {
    await window.loadURL(developmentUrl)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function startDesktopApplication(): Promise<void> {
  await app.whenReady()

  Menu.setApplicationMenu(null)
  configureApplicationSecurity()
  database = initializeApplicationDatabase()
  disposeAuthHandlers = registerAuthIpcHandlers(createAuthenticationService(database))
  mainWindow = await createMainWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createMainWindow()
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
