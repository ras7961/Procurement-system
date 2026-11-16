import { jwtVerify, SignJWT } from "jose";
import { AuthenticationServiceException, InvalidConfigurationException } from "@/entities/exceptions";
import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { RevokedTokenRepositoryInterface } from "@/interfaces/repositories/RevokedTokenRepositoryInterface";
import type { AuthTokenClaims, IssuedToken, TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";
import { generateId } from "@/shared/utilities/uuid";

/** The only signing algorithm accepted, for signing and for verifying. */
export const JWT_ALGORITHM = "HS256";
const MAX_TOKEN_LENGTH = 4096;
/** How far in the future an `iat` may be before the token is distrusted (clock differences between servers). */
const CLOCK_TOLERANCE_SECONDS = 30;
const SECRET_MIN_LENGTH = 32;

export interface JwtTokenServiceOptions {
  /** Clock, replaceable in tests. */
  now?: () => Date;
  /** Called once if the settings use a temporary, per-process secret (development/test only). */
  onEphemeralSecret?: () => void;
}

interface ParsedToken {
  tokenId: string;
  userId: string;
  roleId: string;
  expiresAt: Date;
}

/**
 * services.JwtTokenService, implementing TokenServiceInterface (ODD: AuthenticationService).
 *
 * Tokens are JWTs signed with HS256 by the `jose` library. The payload holds only:
 *   sub (user id), jti (unique token id), iat, exp, iss, aud, and roleId (an opaque id).
 * No email, name, password or hash. Roles are re-read from storage when authorization needs them.
 *
 * verify() checks, in this order: format and length, algorithm allow-list (HS256 only), signature,
 * header type, issuer, audience, required claims, expiry, and then the revocation store. If the
 * revocation store cannot be reached the error is thrown (fail closed); the token is never accepted.
 *
 * revoke() first verifies the token's signature and expiry, so only genuine, unexpired tokens ever
 * create a revocation record (nobody can fill the collection with made-up ids). It stores the
 * `jti` and the expiry, never the token.
 *
 * The settings are read lazily on first use, so building the application never fails because of
 * token configuration. Neither the secret nor a token is ever logged or put in an error.
 */
export class JwtTokenService implements TokenServiceInterface {
  readonly #settingsProvider: () => JwtSettings;
  readonly #revokedTokens: RevokedTokenRepositoryInterface;
  readonly #now: () => Date;
  readonly #onEphemeralSecret: () => void;
  #ready: { settings: JwtSettings; key: Uint8Array } | null = null;

  constructor(
    settingsProvider: () => JwtSettings,
    revokedTokens: RevokedTokenRepositoryInterface,
    options: JwtTokenServiceOptions = {},
  ) {
    this.#settingsProvider = settingsProvider;
    this.#revokedTokens = revokedTokens;
    this.#now = options.now ?? (() => new Date());
    this.#onEphemeralSecret = options.onEphemeralSecret ?? (() => undefined);
  }

  async issue(claims: AuthTokenClaims): Promise<IssuedToken> {
    if (!isNonEmptyString(claims?.userId) || !isNonEmptyString(claims?.roleId)) {
      throw new AuthenticationServiceException({ details: { reason: "token claims are incomplete" } });
    }
    const { settings, key } = this.#load();
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const expiresAt = issuedAt + settings.accessTokenTtlSeconds;
    try {
      const token = await new SignJWT({ roleId: claims.roleId })
        .setProtectedHeader({ alg: JWT_ALGORITHM, typ: "JWT" })
        .setSubject(claims.userId)
        .setJti(generateId())
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .setIssuer(settings.issuer)
        .setAudience(settings.audience)
        .sign(key);
      return { token, expiresAt: new Date(expiresAt * 1000) };
    } catch (error) {
      throw new AuthenticationServiceException({ cause: error });
    }
  }

  async verify(token: string): Promise<AuthTokenClaims | null> {
    const parsed = await this.#parse(token);
    if (parsed === null) return null;
    // A failure here propagates on purpose: "could not check" must never mean "not revoked".
    if (await this.#revokedTokens.isRevoked(parsed.tokenId)) return null;
    return { userId: parsed.userId, roleId: parsed.roleId };
  }

  async revoke(token: string): Promise<void> {
    const parsed = await this.#parse(token);
    // Invalid, unknown or already expired tokens need no record: they are rejected anyway.
    if (parsed === null) return;
    await this.#revokedTokens.revoke(parsed.tokenId, parsed.expiresAt);
  }

  /** Cryptographic and claim checks only. Returns null for anything that is not a valid, current token. */
  async #parse(token: unknown): Promise<ParsedToken | null> {
    if (!isNonEmptyString(token) || token.length > MAX_TOKEN_LENGTH) return null;
    const { settings, key } = this.#load();
    const now = this.#now();
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [JWT_ALGORITHM],
        typ: "JWT",
        issuer: settings.issuer,
        audience: settings.audience,
        requiredClaims: ["sub", "jti", "iat", "exp", "iss", "aud"],
        currentDate: now,
      });
      const { sub, jti, iat, exp, roleId } = payload;
      if (!isNonEmptyString(sub) || !isNonEmptyString(jti) || !isNonEmptyString(roleId)) return null;
      if (typeof iat !== "number" || typeof exp !== "number") return null;
      if (iat > now.getTime() / 1000 + CLOCK_TOLERANCE_SECONDS) return null;
      return { tokenId: jti, userId: sub, roleId, expiresAt: new Date(exp * 1000) };
    } catch {
      // Malformed, wrong signature, wrong algorithm, wrong issuer/audience, expired, missing claims, ...
      return null;
    }
  }

  #load(): { settings: JwtSettings; key: Uint8Array } {
    if (this.#ready) return this.#ready;
    const settings = this.#settingsProvider();
    if (typeof settings.secret !== "string" || settings.secret.length < SECRET_MIN_LENGTH) {
      throw new InvalidConfigurationException([`JWT_SECRET: must be at least ${SECRET_MIN_LENGTH} characters`]);
    }
    if (settings.secretSource === "ephemeral") this.#onEphemeralSecret();
    this.#ready = { settings, key: new TextEncoder().encode(settings.secret) };
    return this.#ready;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
