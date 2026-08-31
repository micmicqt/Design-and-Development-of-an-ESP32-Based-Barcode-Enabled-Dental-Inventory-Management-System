import type { LoginCredentials } from '../../shared/ipc-contract'

/**
 * Main-process authentication boundary. The production composition root should
 * adapt the SQLite credential verifier to this interface.
 */
export interface AuthenticationService {
  authenticate(credentials: Readonly<LoginCredentials>): boolean | Promise<boolean>
}

export type CredentialVerifier = (
  credentials: Readonly<LoginCredentials>
) => boolean | Promise<boolean>

export function authenticationServiceFromVerifier(
  verifier: CredentialVerifier
): AuthenticationService {
  return {
    authenticate: verifier
  }
}

/** Safe fallback used until the database-backed service is composed at startup. */
export const denyAllAuthenticationService: AuthenticationService = {
  authenticate: () => false
}
