import {
  InvalidRoleException,
  RoleNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import { isRoleName, ROLE_NAMES, type RoleName } from "@/entities/Role";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import { toUserResponse, type CreateUserAccountInput, type UserResponseDto } from "./dtos";
import { provisionAccount } from "./provisionAccount";

/** The permission that allows creating accounts (see RolePermissionMatrix: only Administrator holds it). */
export const USER_MANAGE_PERMISSION = "user:manage";

/**
 * Roles this operation may create. Administrator accounts are controlled administrative
 * provisioning and are not created through this use case.
 */
export const ADMIN_CREATABLE_ROLES: readonly RoleName[] = ["Procurement Broker", "Supplier", "Evaluation Committee"];

/**
 * Account creation by an authorized administrator (ODD UserManagementUseCase area).
 *
 * Authorization: the acting user must exist, be Active, and hold the user:manage permission
 * through their role. Full route authorization comes later; this check stays in the use case.
 *
 * Status rule: an account created by an administrator is Active, because the administrator's
 * action is the approval. Public registration (RegisterSupplierUseCase) is the only way to get Pending.
 */
export class CreateUserAccountUseCase {
  constructor(
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
    private readonly passwords: PasswordServiceInterface,
  ) {}

  async execute(input: CreateUserAccountInput): Promise<UserResponseDto> {
    await this.assertActorIsAuthorized(input?.actingUserId);

    const roleName = input?.roleName;
    if (!isRoleName(roleName)) {
      throw new InvalidRoleException([`roleName must be one of: ${ROLE_NAMES.join(", ")}`]);
    }
    if (!ADMIN_CREATABLE_ROLES.includes(roleName)) {
      throw new InvalidRoleException(["accounts with this role cannot be created through this operation"]);
    }
    const role = await this.roles.findByName(roleName);
    if (role === null) throw new RoleNotFoundException();

    const user = await provisionAccount(this.users, this.passwords, {
      fullName: input.fullName,
      email: input.email,
      password: input.password,
      role,
      status: "Active",
    });
    return toUserResponse(user, role);
  }

  /** Every failure is the same UnauthorizedAccessException, so the caller learns nothing about why. */
  private async assertActorIsAuthorized(actingUserId: unknown): Promise<void> {
    if (typeof actingUserId !== "string" || actingUserId === "") throw new UnauthorizedAccessException();
    const actor = await this.users.findById(actingUserId);
    if (actor === null || !actor.isActive()) throw new UnauthorizedAccessException();
    const actorRole = await this.roles.findById(actor.roleId);
    if (actorRole === null) throw new UnauthorizedAccessException();
    actorRole.assertAccess(USER_MANAGE_PERMISSION);
  }
}
