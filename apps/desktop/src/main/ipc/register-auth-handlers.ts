import { ipcMain } from 'electron'
import type { AuthenticationService } from '../application/authentication-service'
import type { AuthSessionController } from '../application/auth-session'
import {
  IPC_CHANNELS,
  type AuthSession,
  type LoginCredentials,
  type LoginResult
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'

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

export function registerAuthIpcHandlers(
  authentication: AuthenticationService,
  authSession: AuthSessionController,
  getMainWindow: MainWindowProvider
): () => void {
  ipcMain.handle(IPC_CHANNELS.authGetSession, (event): AuthSession => {
    if (!isTrustedMainFrame(event, getMainWindow)) return signedOutSession()
    return authSession.getSession()
  })

  ipcMain.handle(
    IPC_CHANNELS.authLogin,
    async (event, rawCredentials: unknown): Promise<LoginResult> => {
      if (!isTrustedMainFrame(event, getMainWindow)) {
        return { ok: false, message: 'Access Denied', session: signedOutSession() }
      }

      const credentials = normalizeCredentials(rawCredentials)
      if (credentials === null) {
        authSession.signOut()
        return { ok: false, message: 'Access Denied', session: signedOutSession() }
      }

      try {
        const authenticated = await authentication.authenticate(credentials)
        if (!authenticated) {
          authSession.signOut()
          return { ok: false, message: 'Access Denied', session: signedOutSession() }
        }

        const session = authSession.signIn(credentials.username)
        return {
          ok: true,
          session
        }
      } catch (error: unknown) {
        // Do not leak database details or credential material to the renderer.
        console.error('Administrator authentication failed internally.', error)
        authSession.signOut()
        return { ok: false, message: 'Access Denied', session: signedOutSession() }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.authLogout, (event): AuthSession => {
    if (!isTrustedMainFrame(event, getMainWindow)) return signedOutSession()
    return authSession.signOut()
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.authGetSession)
    ipcMain.removeHandler(IPC_CHANNELS.authLogin)
    ipcMain.removeHandler(IPC_CHANNELS.authLogout)
    authSession.signOut()
  }
}
