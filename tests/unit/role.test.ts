import { describe, expect, it } from "vitest";
import {
  InvalidRoleException,
  PermissionNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import { isRoleName, Role, ROLE_NAMES } from "@/entities/Role";
import { catchError, makeRole } from "../support/fixtures";

describe("Role creation", () => {
  it("creates a valid role for each of the four supported roles", () => {
    expect([...ROLE_NAMES]).toEqual(["Administrator", "Procurement Broker", "Supplier", "Evaluation Committee"]);

    for (const [index, roleName] of ROLE_NAMES.entries()) {
      const role = Role.create({ roleId: `r-${index}`, roleName, description: `The ${roleName} role.` });
      expect(role.roleId).toBe(`r-${index}`);
      expect(role.roleName).toBe(roleName);
      expect(role.getPermissions()).toEqual([]);
      expect(role.createdAt).toBeInstanceOf(Date);
    }
  });

  it("trims the description and removes duplicate permissions", () => {
    const role = makeRole({ description: "  Manages tenders.  ", permissions: ["tender:create", "tender:create", "tender:publish"] });
    expect(role.description).toBe("Manages tenders.");
    expect(role.getPermissions()).toEqual(["tender:create", "tender:publish"]);
  });

  it("rejects unsupported role names with InvalidRoleException", () => {
    for (const roleName of ["Hacker", "administrator", "", "Supplier "]) {
      const error = catchError(() => makeRole({ roleName: roleName as never }));
      expect(error).toBeInstanceOf(InvalidRoleException);
      expect((error as InvalidRoleException).issues.join(" ")).toContain("roleName");
    }
    expect(isRoleName("Supplier")).toBe(true);
    expect(isRoleName("Janitor")).toBe(false);
    expect(isRoleName(42)).toBe(false);
  });

  it("rejects missing or invalid required attributes and reports every problem", () => {
    const error = catchError(() =>
      Role.create({ roleId: "has space", roleName: "Supplier", description: "   ", createdAt: new Date("nope") }),
    ) as InvalidRoleException;

    expect(error).toBeInstanceOf(InvalidRoleException);
    expect(error.issues).toEqual([
      "roleId is required and must not contain spaces",
      "description is required",
      "createdAt must be a valid date",
    ]);
    expect(error.httpStatus).toBe(400);
  });

  it("rejects an over-long description", () => {
    expect(catchError(() => makeRole({ description: "x".repeat(501) }))).toBeInstanceOf(InvalidRoleException);
  });

  it("rejects malformed permissions with PermissionNotFoundException", () => {
    for (const permission of ["Tender:Publish", "publish", "tender:", ":publish", "tender publish", ""]) {
      expect(catchError(() => makeRole({ permissions: [permission] }))).toBeInstanceOf(PermissionNotFoundException);
    }
  });

  it("restore() validates stored data too", () => {
    const stored = makeRole({ roleName: "Administrator", permissions: ["user:manage"] }).toJSON();
    const restored = Role.restore({ ...stored, createdAt: new Date(stored.createdAt) });
    expect(restored.toJSON()).toEqual(stored);

    expect(
      catchError(() => Role.restore({ ...stored, roleName: "Root" as never, createdAt: new Date(stored.createdAt) })),
    ).toBeInstanceOf(InvalidRoleException);
  });

  it("does not let callers change the creation date or the permission list from outside", () => {
    const role = makeRole({ permissions: ["bid:submit"] });
    role.createdAt.setFullYear(1999);
    role.getPermissions().push("admin:everything");

    expect(role.createdAt.getFullYear()).not.toBe(1999);
    expect(role.getPermissions()).toEqual(["bid:submit"]);
  });
});

describe("Role permissions and access", () => {
  it("assignPermission() adds a permission once", () => {
    const role = makeRole();
    role.assignPermission("bid:submit");
    role.assignPermission("bid:submit");
    expect(role.getPermissions()).toEqual(["bid:submit"]);
  });

  it("assignPermission() rejects an invalid permission", () => {
    expect(catchError(() => makeRole().assignPermission("NOT VALID"))).toBeInstanceOf(PermissionNotFoundException);
  });

  it("removePermission() removes an assigned permission and rejects one that is not assigned", () => {
    const role = makeRole({ permissions: ["bid:submit", "bid:view"] });
    role.removePermission("bid:submit");
    expect(role.getPermissions()).toEqual(["bid:view"]);
    expect(catchError(() => role.removePermission("bid:submit"))).toBeInstanceOf(PermissionNotFoundException);
  });

  it("validateAccess() reports whether the role holds a permission", () => {
    const role = makeRole({ permissions: ["bid:submit"] });
    expect(role.validateAccess("bid:submit")).toBe(true);
    expect(role.validateAccess("tender:publish")).toBe(false);
  });

  it("assertAccess() throws UnauthorizedAccessException without the permission", () => {
    const role = makeRole({ permissions: ["bid:submit"] });
    expect(() => role.assertAccess("bid:submit")).not.toThrow();

    const error = catchError(() => role.assertAccess("tender:publish"));
    expect(error).toBeInstanceOf(UnauthorizedAccessException);
    expect((error as UnauthorizedAccessException).httpStatus).toBe(403);
  });
});

describe("Role updates and serialization", () => {
  it("updateRole() changes the description", () => {
    const role = makeRole();
    role.updateRole({ description: "  New description  " });
    expect(role.description).toBe("New description");
  });

  it("updateRole() rejects an empty update and an invalid description, leaving the role unchanged", () => {
    const role = makeRole({ description: "Original" });
    expect(catchError(() => role.updateRole({}))).toBeInstanceOf(InvalidRoleException);
    expect(catchError(() => role.updateRole({ description: " " }))).toBeInstanceOf(InvalidRoleException);
    expect(role.description).toBe("Original");
  });

  it("serializes to plain JSON", () => {
    const role = makeRole({ roleName: "Administrator", permissions: ["user:manage"] });
    const json = JSON.parse(JSON.stringify(role)) as Record<string, unknown>;
    expect(json).toMatchObject({ roleName: "Administrator", permissions: ["user:manage"] });
    expect(typeof json.createdAt).toBe("string");
  });
});
