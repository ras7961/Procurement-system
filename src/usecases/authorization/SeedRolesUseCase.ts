import {
  DuplicateRoleException,
  InvalidRoleException,
  PermissionNotFoundException,
} from "@/entities/exceptions";
import { ROLE_NAMES, Role, type RoleName } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import { generateId } from "@/shared/utilities/uuid";
import type { RoleSeedConflict, RoleSeedCustomization, SeedRolesResult } from "./dtos";

/** Descriptions stored with newly created roles. Existing roles keep whatever description they have. */
export const ROLE_DESCRIPTIONS: Readonly<Record<RoleName, string>> = {
  Administrator: "Manages user accounts and roles and oversees the whole system.",
  "Procurement Broker": "Prepares and publishes tenders, manages suppliers and administers contracts.",
  Supplier: "Submits bids and maintains its own company profile.",
  "Evaluation Committee": "Evaluates bids for assigned tenders and records evaluation scores.",
};

/**
 * Creates the four approved roles with the permissions of the approved matrix (Stage 1B,
 * RolePermissionMatrix.ts). Not named in the ODD; it is the "role seeding" step of the Role entity.
 *
 * Safe to run any number of times:
 *  - A missing role is created from the matrix.
 *  - A role that exists is NEVER modified: not its permissions, not its description. If its
 *    permissions differ from the matrix it is reported in `customized` so an administrator can
 *    decide; running the seeder again does not "repair" it.
 *  - A role that cannot be read (corrupt stored data) or that keeps colliding is reported in
 *    `conflicts`. The remaining roles are still processed.
 *  - Storage failures (database down) are not swallowed: they are thrown and nothing is assumed.
 *
 * It creates no users, in particular no default administrator. It does not log.
 */
export class SeedRolesUseCase {
  constructor(private readonly roles: RoleRepositoryInterface) {}

  async execute(): Promise<SeedRolesResult> {
    const result: SeedRolesResult = { created: [], unchanged: [], customized: [], conflicts: [] };

    for (const roleName of ROLE_NAMES) {
      const lookup = await this.find(roleName);
      if (lookup.conflict) {
        result.conflicts.push(lookup.conflict);
        continue;
      }

      let existing = lookup.role;
      if (existing === null) {
        const created = await this.createRole(roleName);
        if (created.conflict) {
          result.conflicts.push(created.conflict);
          continue;
        }
        if (created.createdNow) {
          result.created.push(roleName);
          continue;
        }
        existing = created.role;
      }

      const customization = compareWithMatrix(roleName, existing.getPermissions());
      if (customization === null) result.unchanged.push(roleName);
      else result.customized.push(customization);
    }

    return result;
  }

  private async find(roleName: RoleName): Promise<{ role: Role | null; conflict?: RoleSeedConflict }> {
    try {
      return { role: await this.roles.findByName(roleName) };
    } catch (error) {
      if (isStoredDataProblem(error)) {
        return { role: null, conflict: { roleName, reason: "The stored role is invalid and cannot be read. It was not changed." } };
      }
      throw error;
    }
  }

  /** Creates the role. If another process created it first, the existing one is used instead. */
  private async createRole(
    roleName: RoleName,
  ): Promise<{ role: Role; createdNow: boolean; conflict?: undefined } | { conflict: RoleSeedConflict; role?: undefined; createdNow?: undefined }> {
    const role = Role.create({
      roleId: generateId(),
      roleName,
      description: ROLE_DESCRIPTIONS[roleName],
      permissions: getPermissionsForRole(roleName),
    });
    try {
      return { role: await this.roles.create(role), createdNow: true };
    } catch (error) {
      if (!(error instanceof DuplicateRoleException)) throw error;
    }

    // Lost a race with another seeder run (or the unique index fired): use what is stored now.
    const lookup = await this.find(roleName);
    if (lookup.conflict) return { conflict: lookup.conflict };
    if (lookup.role === null) {
      return { conflict: { roleName, reason: "The role reported a duplicate but could not be found afterwards. It was not changed." } };
    }
    return { role: lookup.role, createdNow: false };
  }
}

function compareWithMatrix(roleName: RoleName, stored: readonly string[]): RoleSeedCustomization | null {
  const approved: readonly string[] = getPermissionsForRole(roleName);
  const missingPermissions = approved.filter((permission) => !stored.includes(permission));
  const extraPermissions = stored.filter((permission) => !approved.includes(permission));
  if (missingPermissions.length === 0 && extraPermissions.length === 0) return null;
  return { roleName, missingPermissions, extraPermissions };
}

function isStoredDataProblem(error: unknown): boolean {
  return error instanceof InvalidRoleException || error instanceof PermissionNotFoundException;
}
