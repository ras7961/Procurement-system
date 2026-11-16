import type { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import type { UserResponseDto } from "@/usecases/authentication/dtos";
import { readSessionToken, type SessionCookieSettings } from "./sessionCookie";

/**
 * The reusable authentication helper for protected endpoints.
 *
 * A controller that needs the caller's identity does this and nothing more:
 *
 *     const user = await this.sessions.authenticate(request);
 *
 * It reads the session cookie, then AuthenticateSessionUseCase checks the token (signature,
 * issuer, audience, expiry, revocation) and loads the CURRENT account from the database. It throws
 *   - AuthenticationRequiredException (401) for a missing, invalid, expired or revoked token,
 *   - AccountInactiveException (403) when the account is no longer Active.
 * Both are AppErrors, which errorResponse() turns into the standard error body.
 *
 * What it does NOT do: decide what the user may do. Role-based authorization comes in a later
 * stage and stays in the use cases, which check the permission of the user returned here.
 * Only the HTTP part (reading the cookie) lives here; all rules live in the use case.
 */
export class SessionAuthenticator {
  constructor(
    private readonly authenticateSession: AuthenticateSessionUseCase,
    private readonly cookie: SessionCookieSettings,
  ) {}

  /** The session token from the request, if any. Exposed so logout can revoke it. */
  readToken(request: Request): string | undefined {
    return readSessionToken(request, this.cookie.name);
  }

  async authenticate(request: Request): Promise<UserResponseDto> {
    return this.authenticateSession.execute({ token: this.readToken(request) });
  }
}
