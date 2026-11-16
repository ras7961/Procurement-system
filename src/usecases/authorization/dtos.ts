import type { Permission } from "@/entities/RolePermissionMatrix";
import type { RoleName } from "@/entities/Role";
import type { UserResponseDto } from "@/usecases/authentication/dtos";

/** Input of AuthorizeUseCase. `userId` comes from an already authenticated session. */
export interface AuthorizeInput {
  userId: string;
  permission: Permission;
}

/**
 * The outcome of a successful authorization check.
 *
 * `requiresScopeCheck` is true when the approved matrix grants the permission to this role only
 * for records it is entitled to ("restricted": a Supplier's own records, an Evaluation Committee
 * member's assigned tenders). General RBAC cannot decide that. The module that owns the record
 * (Tender, Bid, Supplier, ...) must perform the ownership or assignment check when it exists.
 */
export interface AuthorizedUserDto {
  user: UserResponseDto;
  permission: Permission;
  requiresScopeCheck: boolean;
}

export interface RoleSeedConflict {
  roleName: RoleName;
  reason: string;
}

/** A stored role whose permissions differ from the approved matrix. It was left as it is. */
export interface RoleSeedCustomization {
  roleName: RoleName;
  missingPermissions: string[];
  extraPermissions: string[];
}

export interface SeedRolesResult {
  /** Roles that did not exist and were created from the matrix. */
  created: RoleName[];
  /** Roles that exist and already match the matrix. */
  unchanged: RoleName[];
  /** Roles that exist with different permissions. Preserved, never overwritten. */
  customized: RoleSeedCustomization[];
  /** Roles that could not be seeded safely. Nothing was changed for these. */
  conflicts: RoleSeedConflict[];
}
