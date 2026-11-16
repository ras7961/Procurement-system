/**
 * Application-level contract for authentication tokens (sessions).
 *
 * LoginUseCase and LogoutUseCase depend on this interface, never on a token library. A later
 * stage adds the implementation (for example JWT) in src/services, and the HTTP adapter
 * (controller and route) decides how the token travels, for example in an HTTP-only cookie.
 *
 * Rules every implementation must follow:
 *  - Never log a token or put it in an error message.
 *  - verify() answers null for any invalid, expired or revoked token. It never throws because of bad input.
 *    It DOES throw (and never answers with claims) when it cannot find out whether a token was revoked,
 *    for example when the revocation store is down: a failure must not let a revoked token through.
 *  - revoke() is idempotent and a no-op for an unknown or already expired token. A stateless
 *    implementation may simply do nothing, in which case clearing the cookie is the logout.
 */

/** What a token says about its holder. Roles are re-read from storage when authorization needs them. */
export interface AuthTokenClaims {
  userId: string;
  roleId: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenServiceInterface {
  /** Creates a signed, expiring token for an authenticated user. */
  issue(claims: AuthTokenClaims): Promise<IssuedToken>;

  /** Returns the claims of a valid token, or null. */
  verify(token: string): Promise<AuthTokenClaims | null>;

  /** Invalidates the token on the server side where the implementation supports it. */
  revoke(token: string): Promise<void>;
}
