import { ipcMain } from 'electron'
import type { AuthenticationService } from '../application/authentication-service'
import {
  IPC_CHANNELS,
  type AuthSession,
  type LoginCredentials,
  type LoginResult
} from '../../shared/ipc-contract'

const MAX_USERNAME_LENGTH = 128
const MAX_PASSWORD_LENGTH = 1_024

const signedOutSession = (): AuthSession & {
  authenticated: false
  username: null
} => ({ authenticated: false, username: null })

function normalizeCredentials(value: unknown): LoginCredentials | null {
  if (typeof value !== 'object' || value === null) return null

  const candidate = value as Record<string, unknown>
  if (typeof candidate.username !== 'string' || typeof candidate.password !== 'string') {
    return null
  }

  const username = candidate.username.trim()
  const password = candidate.password

  if (
    username.length === 0 ||
    username.length > MAX_USERNAME_LENGTH ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return null
  }

  return { username, password }
}

export function registerAuthIpcHandlers(authentication: AuthenticationService): () => void {
  let session: AuthSession = signedOutSession()

  ipcMain.handle(IPC_CHANNELS.authGetSession, (): AuthSession => ({ ...session }))

  ipcMain.handle(
    IPC_CHANNELS.authLogin,
    async (_event, rawCredentials: unknown): Promise<LoginResult> => {
      const credentials = normalizeCredentials(rawCredentials)
      if (credentials === null) {
        session = signedOutSession()
        return { ok: false, message: 'Access Denied', session: signedOutSession() }
      }

      try {
        const authenticated = await authentication.authenticate(credentials)
        if (!authenticated) {
          session = signedOutSession()
          return { ok: false, message: 'Access Denied', session: signedOutSession() }
        }

        session = { authenticated: true, username: credentials.username }
        return {
          ok: true,
          session: {
            authenticated: true,
            username: credentials.username
          }
        }
      } catch (error: unknown) {
        // Do not leak database details or credential material to the renderer.
        console.error('Administrator authentication failed internally.', error)
        session = signedOutSession()
        return { ok: false, message: 'Access Denied', session: signedOutSession() }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.authLogout, (): AuthSession => {
    session = signedOutSession()
    return { ...session }
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.authGetSession)
    ipcMain.removeHandler(IPC_CHANNELS.authLogin)
    ipcMain.removeHandler(IPC_CHANNELS.authLogout)
    session = signedOutSession()
  }
}
