import type { Role, RoleName } from "@/entities/Role";

/** Fields of a role that can be changed through update(). Values must already be validated by the Role entity. */
export interface RoleUpdateData {
  description?: string;
  permissions?: readonly string[];
}

/**
 * interfaces.RoleRepositoryInterface
 *
 * NOT DEFINED IN THE ODD. The ODD gives Role persistence-style operations
 * (createRole, updateRole) and lists RoleNotFoundException and DuplicateRoleException,
 * but specifies no repository for it. This interface is the smallest one that lets
 * the authentication and user-management use cases find, list, create and update
 * roles. It follows the conventions of UserRepositoryInterface.
 *
 * Contract:
 *  - findById and findByName return null when nothing matches. They do not throw.
 *  - Role names are unique. create() throws DuplicateRoleException when the name exists.
 *  - update() throws RoleNotFoundException for an unknown roleId.
 *  - Unexpected storage failures throw DatabaseOperationException, never a raw driver error.
 *  - Returned roles are new Role instances.
 */
export interface RoleRepositoryInterface {
  /** Saves a new role and returns it. Throws DuplicateRoleException if the name exists. */
  create(role: Role): Promise<Role>;

  findById(roleId: string): Promise<Role | null>;

  findByName(roleName: RoleName): Promise<Role | null>;

  /** All available roles. */
  findAll(): Promise<Role[]>;

  /** Changes the given fields and returns the updated role. */
  update(roleId: string, roleData: RoleUpdateData): Promise<Role>;
}
