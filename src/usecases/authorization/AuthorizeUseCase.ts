import {
  AuthenticationRequiredException,
  RoleNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import { PERMISSIONS, isRestrictedPermission } from "@/entities/RolePermissionMatrix";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { toUserResponse } from "@/usecases/authentication/dtos";
import type { AuthorizedUserDto, AuthorizeInput } from "./dtos";

/**
 * Decides whether a user may perform an operation. Authorization only: who the caller is comes
 * from the authentication use cases; this one is given a user id and a permission.
 *
 * Everything is read from storage on every call. Nothing from a token (including a role claim) is
 * an input, so a role change, suspension or deletion takes effect immediately.
 *
 *  - no such user                      -> AuthenticationRequiredException (401)
 *  - account not Active (Pending, Inactive, Suspended)
 *                                      -> AccountInactiveException (403)
 *  - the user's role record is missing -> RoleNotFoundException (reported as a server error)
 *  - the role does not hold the permission, or the permission is not one of the approved
 *    permissions                       -> UnauthorizedAccessException (403)
 *  - storage failure                   -> the storage error is thrown. It is never caught here, so
 *                                         unavailable permission data can never turn into access.
 *
 * The permissions that count are the ones STORED on the role (so an administrator's customization
 * is respected), not the matrix. The matrix is only consulted to tell whether the grant is
 * "restricted" to the caller's own or assigned records; see AuthorizedUserDto.requiresScopeCheck.
 * This use case does not check tender assignments or record ownership: those modules do not exist yet.
 */
export class AuthorizeUseCase {
  constructor(
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
  ) {}

  async execute(input: AuthorizeInput): Promise<AuthorizedUserDto> {
    const userId = input?.userId;
    const permission = input?.permission;

    if (typeof userId !== "string" || userId === "") throw new AuthenticationRequiredException();
    // Fail closed on a permission the system does not define (a typo in calling code must not open anything).
    if (!(PERMISSIONS as readonly unknown[]).includes(permission)) throw new UnauthorizedAccessException();

    const user = await this.users.findById(userId);
    if (user === null) throw new AuthenticationRequiredException();
    user.assertCanAuthenticate();

    const role = await this.roles.findById(user.roleId);
    if (role === null) throw new RoleNotFoundException();
    role.assertAccess(permission);

    return {
      user: toUserResponse(user, role),
      permission,
      requiresScopeCheck: isRestrictedPermission(role.roleName, permission),
    };
  }
}
