import { UnauthorizedAccessException } from "@/entities/exceptions";
import type { Permission } from "@/entities/RolePermissionMatrix";
import type { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import type { AuthorizedUserDto } from "@/usecases/authorization/dtos";
import type { SessionAuthenticator } from "./SessionAuthenticator";

/**
 * The reusable authorization helper for protected endpoints. A controller does this first:
 *
 *     const { user, requiresScopeCheck } = await this.guard.require(request, "tender:create");
 *
 * Step 1, authentication (SessionAuthenticator): a valid session whose account is Active.
 *   Failure: AuthenticationRequiredException (401) or AccountInactiveException (403).
 * Step 2, authorization (AuthorizeUseCase): the user's CURRENT role is read from storage and must
 *   hold the permission. Failure: UnauthorizedAccessException (403). The role in the JWT is never used.
 *
 * Both steps throw AppErrors, which errorResponse() turns into the standard error body, so a
 * controller needs no try/catch of its own beyond the one it already has. If anything cannot be
 * read, the error is thrown and the request is refused.
 *
 * `requiresScopeCheck` tells the controller's use case that the role holds the permission only for
 * its own or assigned records and that the module must check that (not enforced by this guard).
 */
export class AuthorizationGuard {
  constructor(
    private readonly sessions: SessionAuthenticator,
    private readonly authorization: AuthorizeUseCase,
  ) {}

  async require(request: Request, permission: Permission): Promise<AuthorizedUserDto> {
    const caller = await this.sessions.authenticate(request);
    return this.authorization.execute({ userId: caller.userId, permission });
  }

  /**
   * For endpoints that two kinds of caller use under different permissions (for example staff with "supplier:manage" and
   * a Supplier with "supplier:update_own"). The session is authenticated once, then each permission is tried in order;
   * the first the CURRENT stored role holds wins. Only "not allowed" moves on: any other failure stops the request.
   * Whether the grant fits the record (ownership) is still the use case's job.
   */
  async requireAny(request: Request, permissions: readonly Permission[]): Promise<AuthorizedUserDto> {
    const caller = await this.sessions.authenticate(request);
    let refusal: unknown = new UnauthorizedAccessException();
    for (const permission of permissions) {
      try {
        return await this.authorization.execute({ userId: caller.userId, permission });
      } catch (error) {
        if (!(error instanceof UnauthorizedAccessException)) throw error;
        refusal = error;
      }
    }
    throw refusal;
  }
}
