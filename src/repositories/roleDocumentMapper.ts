import { DatabaseOperationException } from "@/entities/exceptions";
import { Role, type RoleName } from "@/entities/Role";
import { describeDriverError } from "./mongoErrors";
import { toDomainDate, toDomainId } from "./userDocumentMapper";

/** How a role is stored in the "roles" collection. `_id` holds the domain roleId. */
export interface RoleDocument {
  _id: string;
  roleName: RoleName;
  description: string;
  permissions: string[];
  createdAt: Date;
}

export type StoredRoleDocument = Omit<RoleDocument, "_id" | "createdAt"> & {
  _id: unknown;
  createdAt: Date | string | number;
};

export function toRoleDocument(role: Role): RoleDocument {
  return {
    _id: role.roleId,
    roleName: role.roleName,
    description: role.description,
    permissions: role.getPermissions(),
    createdAt: role.createdAt,
  };
}

/** Converts a stored document to a validated Role. A corrupt document is a storage problem. */
export function toRole(document: StoredRoleDocument): Role {
  try {
    return Role.restore({
      roleId: toDomainId(document._id),
      roleName: document.roleName,
      description: document.description,
      permissions: Array.isArray(document.permissions) ? document.permissions : [],
      createdAt: toDomainDate(document.createdAt),
    });
  } catch (error) {
    throw new DatabaseOperationException({
      cause: error,
      details: { reason: "stored role document is invalid", ...describeDriverError(error) },
    });
  }
}
