import type { AuthSession } from '../../shared/ipc-contract'

export interface AuthSessionController {
  getSession: () => AuthSession
  isAuthenticated: () => boolean
  signIn: (username: string) => AuthSession & { authenticated: true; username: string }
  signOut: () => AuthSession & { authenticated: false; username: null }
}

const signedOutSession = (): AuthSession & { authenticated: false; username: null } => ({
  authenticated: false,
  username: null
})

export function createAuthSessionController(): AuthSessionController {
  let session: AuthSession = signedOutSession()

  return {
    getSession: () => ({ ...session }),
    isAuthenticated: () => session.authenticated,
    signIn: (username) => {
      const authenticatedSession = { authenticated: true as const, username }
      session = authenticatedSession
      return { ...authenticatedSession }
    },
    signOut: () => {
      session = signedOutSession()
      return signedOutSession()
    }
  }
}
