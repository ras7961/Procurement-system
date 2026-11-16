import { describe, expect, it } from "vitest";
import { PERMISSION_PATTERN, Role, ROLE_NAMES, type RoleName } from "@/entities/Role";
import {
  getPermissionsForRole,
  isRestrictedPermission,
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  type AccessLevel,
} from "@/entities/RolePermissionMatrix";

/** The approved table, copied from the Stage 1B decision, plus the two supplier own-profile rows added in the Stage 1B review. The test parses it and compares it with the code. */
const APPROVED_TABLE = `
| Permission | Administrator | Broker | Supplier | Evaluation Committee |
|---|---|---|---|---|
| user:manage | Yes | No | No | No |
| role:manage | Yes | No | No | No |
| tender:create | Yes | Yes | No | No |
| tender:update | Yes | Yes | No | No |
| tender:publish | Yes | Yes | No | No |
| tender:read | Yes | Yes | Yes* | Yes* |
| supplier:manage | Yes | Yes | No | No |
| supplier:read | Yes | Yes | No | No |
| supplier:read_own | No | No | Yes* | No |
| supplier:update_own | No | No | Yes* | No |
| bid:submit | No | No | Yes | No |
| bid:read | Yes | Yes | No | Yes* |
| evaluation:manage | No | No | No | Yes* |
| evaluation:read | Yes | Yes | Yes* | Yes* |
| contract:manage | Yes | Yes | No | No |
| contract:read | Yes | Yes | Yes* | No |
| report:read | Yes | No | No | Yes* |
`;

function parseApprovedTable(): Record<string, Record<RoleName, AccessLevel>> {
  const rows = APPROVED_TABLE.trim().split("\n").slice(2);
  const result: Record<string, Record<RoleName, AccessLevel>> = {};
  for (const row of rows) {
    const [permission = "", ...cells] = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    const level = (cell: string): AccessLevel => (cell === "Yes*" ? "restricted" : cell === "Yes" ? "yes" : "no");
    const [administrator = "", broker = "", supplier = "", committee = ""] = cells;
    result[permission] = {
      Administrator: level(administrator),
      "Procurement Broker": level(broker),
      Supplier: level(supplier),
      "Evaluation Committee": level(committee),
    };
  }
  return result;
}

describe("approved role-permission matrix", () => {
  it("matches the approved table cell for cell", () => {
    const approved = parseApprovedTable();
    expect(Object.keys(approved)).toEqual([...PERMISSIONS]);
    expect(ROLE_PERMISSION_MATRIX).toEqual(approved);
  });

  it("covers exactly the four roles and uses valid permission names", () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(PERMISSION_PATTERN);
      expect(Object.keys(ROLE_PERMISSION_MATRIX[permission]).sort()).toEqual([...ROLE_NAMES].sort());
    }
  });

  it("gives each role the permissions listed in the approved table", () => {
    expect(getPermissionsForRole("Administrator")).toHaveLength(13);
    expect(getPermissionsForRole("Procurement Broker")).toHaveLength(10);
    expect(getPermissionsForRole("Supplier")).toEqual([
      "tender:read",
      "supplier:read_own",
      "supplier:update_own",
      "bid:submit",
      "evaluation:read",
      "contract:read",
    ]);
    expect(getPermissionsForRole("Evaluation Committee")).toEqual([
      "tender:read",
      "bid:read",
      "evaluation:manage",
      "evaluation:read",
      "report:read",
    ]);
  });

  it("marks exactly the starred cells as restricted", () => {
    expect(isRestrictedPermission("Supplier", "tender:read")).toBe(true);
    expect(isRestrictedPermission("Evaluation Committee", "evaluation:manage")).toBe(true);
    expect(isRestrictedPermission("Evaluation Committee", "bid:read")).toBe(true);
    expect(isRestrictedPermission("Administrator", "tender:read")).toBe(false);
    expect(isRestrictedPermission("Supplier", "bid:submit")).toBe(false);
  });

  it("keeps the approved safety rules", () => {
    const holders = (permission: (typeof PERMISSIONS)[number]) =>
      ROLE_NAMES.filter((role) => ROLE_PERMISSION_MATRIX[permission][role] !== "no");

    // Brokers (and administrators) cannot modify committee scores.
    expect(holders("evaluation:manage")).toEqual(["Evaluation Committee"]);
    // Only suppliers submit bids.
    expect(holders("bid:submit")).toEqual(["Supplier"]);
    // Suppliers maintain only their own profile; general supplier management stays with admins and brokers.
    expect(holders("supplier:manage")).toEqual(["Administrator", "Procurement Broker"]);
    expect(holders("supplier:read")).toEqual(["Administrator", "Procurement Broker"]);
    expect(holders("supplier:read_own")).toEqual(["Supplier"]);
    expect(holders("supplier:update_own")).toEqual(["Supplier"]);
    // Only administrators manage users and roles.
    expect(holders("user:manage")).toEqual(["Administrator"]);
    expect(holders("role:manage")).toEqual(["Administrator"]);
    // Committee members see only assigned tenders, suppliers only their own records.
    expect(isRestrictedPermission("Evaluation Committee", "tender:read")).toBe(true);
    expect(isRestrictedPermission("Supplier", "contract:read")).toBe(true);
    expect(isRestrictedPermission("Supplier", "supplier:update_own")).toBe(true);
    // No award permission exists, and there is no AI role that could hold one.
    expect(PERMISSIONS.filter((permission) => /award|approve/i.test(permission))).toEqual([]);
    expect([...ROLE_NAMES].filter((role) => /\bai\b|assistant|model/i.test(role))).toEqual([]);
  });

  it("can be loaded into Role entities without errors", () => {
    for (const [index, roleName] of ROLE_NAMES.entries()) {
      const role = Role.create({
        roleId: `r-${index}`,
        roleName,
        description: `The ${roleName} role.`,
        permissions: getPermissionsForRole(roleName),
      });
      expect(role.getPermissions()).toEqual(getPermissionsForRole(roleName));
    }
  });
});
