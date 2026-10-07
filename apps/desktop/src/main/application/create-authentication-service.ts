import { hasConfiguredAdmin, initializeAdminCredentials, verifyAdminCredentials } from '../auth'
import type { SqliteDatabase } from '../database'
import {
  authenticationServiceFromVerifier,
  type AuthenticationService,
  type FirstRunAdminService
} from './authentication-service'

/**
 * Phase 1 composition point.
 *
 * Keeping the SQLite adapter here prevents the renderer and preload from
 * knowing anything about database implementation.
 */
export function createAuthenticationService(database: SqliteDatabase): AuthenticationService {
  return authenticationServiceFromVerifier((credentials) =>
    verifyAdminCredentials(database, credentials)
  )
}

export function createFirstRunAdminService(database: SqliteDatabase): FirstRunAdminService {
  return {
    needsSetup: () => !hasConfiguredAdmin(database),
    createFirstAdmin: (credentials) => initializeAdminCredentials(database, credentials)
  }
}
