import { ROLE_NAMES, type RoleName } from "./Role";

/**
 * The approved initial role-permission matrix (Stage 1B decision).
 *
 * This file only PRESERVES the decision as data. Nothing enforces it yet: route
 * authorization and role seeding are later steps, which will read this table.
 *
 * Meaning of each cell:
 *   "yes"        the role holds the permission.
 *   "restricted" the role holds it ("Yes*" in the approved table), but only for records
 *                it is entitled to: assigned tenders for Evaluation Committee members,
 *                the supplier's own records for Suppliers. The scoping rules are enforced
 *                by the use cases of those modules (the committee-assignment model, D6,
 *                is still to be designed).
 *   "no"         the role does not hold it.
 *
 * Approved rules that follow from the table and must survive every later change:
 *   - Brokers (and Administrators) cannot modify committee evaluation scores: only
 *     Evaluation Committee holds evaluation:manage.
 *   - Only Suppliers submit bids.
 *   - No award permission exists. Awards are made by authorized humans, and the AI must
 *     never receive an award permission (no AI role exists in this matrix).
 *
 * Open points:
 *   - There is no permission for approving a procurement award. "award:approve" is
 *     recommended, but the human role that may hold it is still to be decided.
 *   - (Resolved) Suppliers maintain their own profile through supplier:read_own and
 *     supplier:update_own. These only ever apply to the authenticated supplier's own
 *     profile and never grant access to other suppliers. Suppliers must NOT receive the
 *     general supplier:manage or supplier:read.
 *   - Committee-to-tender assignment still needs a model before final authorization rules.
 *   - The human role allowed to approve awards is undecided, so "award:approve" is NOT
 *     in the matrix yet. When added, it must never be given to any AI actor.
 *   - tender:read / contract:read / evaluation:read are "restricted" for Suppliers without
 *     a stated rule for what a Supplier may see (for example only Published tenders).
 */

export const PERMISSIONS = [
  "user:manage",
  "role:manage",
  "tender:create",
  "tender:update",
  "tender:publish",
  "tender:read",
  "supplier:manage",
  "supplier:read",
  "supplier:read_own",
  "supplier:update_own",
  "bid:submit",
  "bid:read",
  "evaluation:manage",
  "evaluation:read",
  "contract:manage",
  "contract:read",
  "report:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type AccessLevel = "no" | "yes" | "restricted";

export const ROLE_PERMISSION_MATRIX: Readonly<Record<Permission, Readonly<Record<RoleName, AccessLevel>>>> = {
  "user:manage": { Administrator: "yes", "Procurement Broker": "no", Supplier: "no", "Evaluation Committee": "no" },
  "role:manage": { Administrator: "yes", "Procurement Broker": "no", Supplier: "no", "Evaluation Committee": "no" },
  "tender:create": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  "tender:update": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  "tender:publish": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  "tender:read": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "restricted", "Evaluation Committee": "restricted" },
  "supplier:manage": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  "supplier:read": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  // Added after the Stage 1B review: a supplier maintains ONLY its own profile (never general supplier:manage).
  "supplier:read_own": { Administrator: "no", "Procurement Broker": "no", Supplier: "restricted", "Evaluation Committee": "no" },
  "supplier:update_own": { Administrator: "no", "Procurement Broker": "no", Supplier: "restricted", "Evaluation Committee": "no" },
  "bid:submit": { Administrator: "no", "Procurement Broker": "no", Supplier: "yes", "Evaluation Committee": "no" },
  "bid:read": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "restricted" },
  "evaluation:manage": { Administrator: "no", "Procurement Broker": "no", Supplier: "no", "Evaluation Committee": "restricted" },
  "evaluation:read": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "restricted", "Evaluation Committee": "restricted" },
  "contract:manage": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "no", "Evaluation Committee": "no" },
  "contract:read": { Administrator: "yes", "Procurement Broker": "yes", Supplier: "restricted", "Evaluation Committee": "no" },
  "report:read": { Administrator: "yes", "Procurement Broker": "no", Supplier: "no", "Evaluation Committee": "restricted" },
};

/** Permissions a role holds, restricted ones included, in matrix order. */
export function getPermissionsForRole(roleName: RoleName): Permission[] {
  return PERMISSIONS.filter((permission) => ROLE_PERMISSION_MATRIX[permission][roleName] !== "no");
}

/** True when the role holds the permission only for the records it is entitled to. */
export function isRestrictedPermission(roleName: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSION_MATRIX[permission][roleName] === "restricted";
}

export { ROLE_NAMES };
