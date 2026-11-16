import { InvalidRoleException, PermissionNotFoundException, UnauthorizedAccessException } from "./exceptions";

/**
 * ODD: entities.Role
 *
 * Defines a category of users and the permissions that category holds. The system
 * supports exactly four roles (SRS: "A user is assigned one role").
 *
 * ODD operation mapping:
 *   createRole()        -> Role.create()   (and Role.restore() when loading stored data)
 *   updateRole()        -> updateRole()
 *   assignPermission()  -> assignPermission()
 *   removePermission()  -> removePermission()
 *   getPermissions()    -> getPermissions()
 *   validateAccess()    -> validateAccess() (boolean) and assertAccess() (throws)
 *
 * Saving and loading roles is NOT done here. Use cases do it through
 * RoleRepositoryInterface. The class has no framework or database types.
 */

export const ROLE_NAMES = ["Administrator", "Procurement Broker", "Supplier", "Evaluation Committee"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * A permission is "<resource>:<action>" in lowercase, e.g. "tender:publish".
 * The docs do not define a permission catalogue, so only the format is enforced.
 * Concrete permissions are introduced by the module that needs them.
 */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;
export const ROLE_DESCRIPTION_MAX_LENGTH = 500;

export function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
}

export interface CreateRoleProps {
  roleId: string;
  roleName: RoleName;
  description: string;
  permissions?: readonly string[];
  /** Defaults to now. */
  createdAt?: Date;
}

export interface RestoreRoleProps {
  roleId: string;
  roleName: RoleName;
  description: string;
  permissions: readonly string[];
  createdAt: Date;
}

export interface UpdateRoleProps {
  description?: string;
}

interface ValidRoleData {
  roleId: string;
  roleName: RoleName;
  description: string;
  permissions: string[];
  createdAt: Date;
}

export class Role {
  readonly #roleId: string;
  readonly #roleName: RoleName;
  #description: string;
  #permissions: string[];
  readonly #createdAt: Date;

  private constructor(data: ValidRoleData) {
    this.#roleId = data.roleId;
    this.#roleName = data.roleName;
    this.#description = data.description;
    this.#permissions = data.permissions;
    this.#createdAt = data.createdAt;
  }

  /** ODD createRole(): builds a new, validated role. */
  static create(props: CreateRoleProps): Role {
    return new Role(
      validateRoleData({
        roleId: props.roleId,
        roleName: props.roleName,
        description: props.description,
        permissions: props.permissions ?? [],
        createdAt: props.createdAt ?? new Date(),
      }),
    );
  }

  /** Rebuilds a role from stored data (used by repository implementations). Validates too. */
  static restore(props: RestoreRoleProps): Role {
    return new Role(validateRoleData(props));
  }

  get roleId(): string {
    return this.#roleId;
  }

  get roleName(): RoleName {
    return this.#roleName;
  }

  get description(): string {
    return this.#description;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  /** ODD updateRole(). The role name is fixed; only the description can change. */
  updateRole(changes: UpdateRoleProps): void {
    if (changes.description === undefined) {
      throw new InvalidRoleException(["at least one field to update is required"]);
    }
    const issues: string[] = [];
    const description = normalizeDescription(changes.description, issues);
    if (issues.length > 0) throw new InvalidRoleException(issues);
    this.#description = description;
  }

  /** ODD assignPermission(). Assigning a permission twice has no effect. */
  assignPermission(permission: string): void {
    if (!isValidPermission(permission)) {
      throw new PermissionNotFoundException({ details: { reason: "invalid permission format" } });
    }
    if (!this.#permissions.includes(permission)) {
      this.#permissions.push(permission);
    }
  }

  /** ODD removePermission(). Throws when the permission is not assigned. */
  removePermission(permission: string): void {
    const index = this.#permissions.indexOf(permission);
    if (index === -1) {
      throw new PermissionNotFoundException({ details: { reason: "permission not assigned", permission } });
    }
    this.#permissions.splice(index, 1);
  }

  /** ODD getPermissions(). Returns a copy, so callers cannot change the role by accident. */
  getPermissions(): string[] {
    return [...this.#permissions];
  }

  /** ODD validateAccess(): does this role hold the permission? */
  validateAccess(permission: string): boolean {
    return this.#permissions.includes(permission);
  }

  /** Like validateAccess(), but throws UnauthorizedAccessException when access is not granted. */
  assertAccess(permission: string): void {
    if (!this.validateAccess(permission)) {
      throw new UnauthorizedAccessException({ details: { permission } });
    }
  }

  toJSON(): {
    roleId: string;
    roleName: RoleName;
    description: string;
    permissions: string[];
    createdAt: string;
  } {
    return {
      roleId: this.#roleId,
      roleName: this.#roleName,
      description: this.#description,
      permissions: [...this.#permissions],
      createdAt: this.#createdAt.toISOString(),
    };
  }
}

function isValidPermission(value: unknown): value is string {
  return typeof value === "string" && PERMISSION_PATTERN.test(value);
}

function normalizeDescription(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("description is required");
    return "";
  }
  const description = value.trim();
  if (description.length > ROLE_DESCRIPTION_MAX_LENGTH) {
    issues.push(`description must be at most ${ROLE_DESCRIPTION_MAX_LENGTH} characters`);
  }
  return description;
}

/** Validates everything, collects every problem, and returns clean data or throws. */
function validateRoleData(data: {
  roleId: unknown;
  roleName: unknown;
  description: unknown;
  permissions: unknown;
  createdAt: unknown;
}): ValidRoleData {
  const issues: string[] = [];

  if (typeof data.roleId !== "string" || !/^\S+$/.test(data.roleId)) {
    issues.push("roleId is required and must not contain spaces");
  }
  if (!isRoleName(data.roleName)) {
    issues.push(`roleName must be one of: ${ROLE_NAMES.join(", ")}`);
  }
  const description = normalizeDescription(data.description, issues);

  const permissions: string[] = [];
  if (!Array.isArray(data.permissions)) {
    issues.push("permissions must be a list");
  } else {
    for (const permission of data.permissions) {
      if (!isValidPermission(permission)) {
        // Fail with the ODD's PermissionNotFoundException, not a generic role error.
        throw new PermissionNotFoundException({ details: { reason: "invalid permission format" } });
      }
      if (!permissions.includes(permission)) permissions.push(permission);
    }
  }

  if (!(data.createdAt instanceof Date) || Number.isNaN(data.createdAt.getTime())) {
    issues.push("createdAt must be a valid date");
  }

  if (issues.length > 0) throw new InvalidRoleException(issues);

  return {
    roleId: data.roleId as string,
    roleName: data.roleName as RoleName,
    description,
    permissions,
    createdAt: new Date((data.createdAt as Date).getTime()),
  };
}
