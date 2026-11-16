import { DuplicateRoleException, RoleNotFoundException } from "@/entities/exceptions";
import { Role, type RestoreRoleProps, type RoleName } from "@/entities/Role";
import type { RoleRepositoryInterface, RoleUpdateData } from "@/interfaces/repositories/RoleRepositoryInterface";

/** Test double that implements RoleRepositoryInterface in memory. */
export class InMemoryRoleRepository implements RoleRepositoryInterface {
  private readonly rows = new Map<string, RestoreRoleProps>();

  async create(role: Role): Promise<Role> {
    if (this.findRowByName(role.roleName)) throw new DuplicateRoleException();
    this.rows.set(role.roleId, toRow(role));
    return Role.restore(this.requireRow(role.roleId));
  }

  async findById(roleId: string): Promise<Role | null> {
    const row = this.rows.get(roleId);
    return row ? Role.restore(row) : null;
  }

  async findByName(roleName: RoleName): Promise<Role | null> {
    const row = this.findRowByName(roleName);
    return row ? Role.restore(row) : null;
  }

  async findAll(): Promise<Role[]> {
    return [...this.rows.values()].map((row) => Role.restore(row));
  }

  async update(roleId: string, roleData: RoleUpdateData): Promise<Role> {
    const current = this.requireRow(roleId);
    const next: RestoreRoleProps = {
      ...current,
      description: roleData.description ?? current.description,
      permissions: roleData.permissions ?? current.permissions,
    };
    const validated = Role.restore(next);
    this.rows.set(roleId, toRow(validated));
    return validated;
  }

  private requireRow(roleId: string): RestoreRoleProps {
    const row = this.rows.get(roleId);
    if (!row) throw new RoleNotFoundException();
    return row;
  }

  private findRowByName(roleName: RoleName): RestoreRoleProps | undefined {
    return [...this.rows.values()].find((row) => row.roleName === roleName);
  }
}

function toRow(role: Role): RestoreRoleProps {
  return {
    roleId: role.roleId,
    roleName: role.roleName,
    description: role.description,
    permissions: role.getPermissions(),
    createdAt: role.createdAt,
  };
}
