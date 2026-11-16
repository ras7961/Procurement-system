import type { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import type { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import type { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { errorResponse, successResponse, type ErrorLogger } from "./apiResponse";
import { parseLoginRequest, parseRegisterRequest } from "./authenticationRequests";
import { assertTrustedOrigin, readJsonObject } from "./requestSecurity";
import type { SessionAuthenticator } from "./SessionAuthenticator";
import { buildClearedSessionCookie, buildSessionCookie, type SessionCookieSettings } from "./sessionCookie";

export interface AuthenticationControllerOptions {
  cookie: SessionCookieSettings;
  /**
   * The application origin that state-changing requests must come from. A function, so a
   * missing production setting fails the request instead of failing application start-up.
   */
  allowedOrigin: () => string;
  logger?: ErrorLogger;
  /** Clock, replaceable in tests. */
  now?: () => Date;
}

/**
 * controllers.AuthenticationController (ODD: register, login, logout; getCurrentUser is added for
 * GET /api/auth/me).
 *
 * Each operation takes the standard Web `Request` and returns a standard `Response`, so the Next.js
 * route handlers stay one line long and this class imports no framework. Every request goes through
 * the same steps: origin check (POST only) -> read and validate the body -> call the use case ->
 * build the response. No business rule lives here, and no operation logs credentials or tokens.
 *
 * Failures are converted by errorResponse(); the use cases' own exceptions (InvalidCredentials,
 * DuplicateEmail, AccountInactive, ...) already carry the HTTP status and a user-safe message.
 */
export class AuthenticationController {
  readonly #now: () => Date;

  constructor(
    private readonly registerSupplier: RegisterSupplierUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly sessions: SessionAuthenticator,
    private readonly options: AuthenticationControllerOptions,
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  /** POST /api/auth/register. Always creates a Pending Supplier; the use case fixes role and status. */
  async register(request: Request): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const input = parseRegisterRequest(await readJsonObject(request));
      const user = await this.registerSupplier.execute(input);
      return successResponse(201, { user }, "Registration received. Your account must be approved by an administrator before you can sign in.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "register");
    }
  }

  /** POST /api/auth/login. The token goes into the HttpOnly cookie only, never into the JSON body. */
  async login(request: Request): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const input = parseLoginRequest(await readJsonObject(request));
      const result = await this.loginUseCase.execute(input);
      const cookie = buildSessionCookie(this.options.cookie, result.token, new Date(result.expiresAt), this.#now());
      return successResponse(200, { user: result.user, expiresAt: result.expiresAt }, "Login successful.", [cookie]);
    } catch (error) {
      return errorResponse(error, this.options.logger, "login");
    }
  }

  /**
   * POST /api/auth/logout. Idempotent: with no cookie, an invalid one or an expired one it still
   * succeeds. Once the origin is accepted the cookie is cleared whatever happens next, even if
   * revoking the token fails (that failure is then reported as an error, and logged).
   */
  async logout(request: Request): Promise<Response> {
    try {
      // A forged cross-site logout is refused without clearing anything.
      assertTrustedOrigin(request, this.options.allowedOrigin());
    } catch (error) {
      return errorResponse(error, this.options.logger, "logout");
    }

    const cleared = [buildClearedSessionCookie(this.options.cookie)];
    try {
      await this.logoutUseCase.execute({ token: this.sessions.readToken(request) });
      return successResponse(200, null, "Logged out.", cleared);
    } catch (error) {
      return errorResponse(error, this.options.logger, "logout", cleared);
    }
  }

  /** GET /api/auth/me. Current account data, read from the database; the role in the token is not used. */
  async getCurrentUser(request: Request): Promise<Response> {
    try {
      const user = await this.sessions.authenticate(request);
      return successResponse(200, { user }, "Current user retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "me");
    }
  }
}
