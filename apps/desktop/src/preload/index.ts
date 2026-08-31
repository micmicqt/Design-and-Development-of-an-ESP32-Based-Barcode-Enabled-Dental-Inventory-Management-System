import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type DesktopApi,
  type LoginCredentials
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
  })
})

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
