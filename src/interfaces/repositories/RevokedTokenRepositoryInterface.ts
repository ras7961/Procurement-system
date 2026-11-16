/**
 * Not in the ODD (added in Stage 1D, like RoleRepositoryInterface): server-side storage of
 * revoked authentication tokens, so that logout really ends a session.
 *
 * Only the token id (the JWT `jti`) and the token's expiry are stored, never the token itself.
 * A revocation record is only needed until the token would have expired anyway, so
 * implementations may delete records after `expiresAt` (MongoRevokedTokenRepository does this
 * with a TTL index).
 *
 * Failures throw an AppError. They are never swallowed: callers must not treat "could not
 * check" as "not revoked".
 */
export interface RevokedTokenRepositoryInterface {
  /** Marks the token id as revoked until `expiresAt`. Idempotent: revoking twice is not an error. */
  revoke(tokenId: string, expiresAt: Date): Promise<void>;

  /** True when the token id has been revoked. */
  isRevoked(tokenId: string): Promise<boolean>;
}
