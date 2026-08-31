export const IPC_CHANNELS = {
  authGetSession: 'auth:get-session',
  authLogin: 'auth:login',
  authLogout: 'auth:logout'
} as const

export interface LoginCredentials {
  username: string
  password: string
}

export interface AuthSession {
  authenticated: boolean
  username: string | null
}

export type LoginResult =
  | {
      ok: true
      session: AuthSession & { authenticated: true; username: string }
    }
  | {
      ok: false
      message: 'Access Denied'
      session: AuthSession & { authenticated: false; username: null }
    }

export interface DesktopApi {
  auth: {
    getSession: () => Promise<AuthSession>
    login: (credentials: LoginCredentials) => Promise<LoginResult>
    logout: () => Promise<AuthSession>
  }
}
