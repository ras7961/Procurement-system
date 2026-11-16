import { describe, expect, it } from "vitest";
import {
  DatabaseOperationException,
  DuplicateRoleException,
  InvalidRoleException,
} from "@/entities/exceptions";
import { ROLE_NAMES, type Role, type RoleName } from "@/entities/Role";
import { PERMISSIONS, getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import type { SeedRolesResult } from "@/usecases/authorization/dtos";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { formatSeedReport, runRoleSeeding } from "../../scripts/seedRolesRunner";
import { catchAsyncError, makeRole } from "../support/fixtures";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";

/** Counts writes so tests can prove that nothing was changed. */
class SpyRoleRepository extends InMemoryRoleRepository {
  creates = 0;
  updates = 0;
  override async create(role: Role) {
    this.creates += 1;
    return super.create(role);
  }
  override async update(...args: Parameters<InMemoryRoleRepository["update"]>) {
    this.updates += 1;
    return super.update(...args);
  }
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("SeedRolesUseCase: creating the four approved roles", () => {
  it("creates Administrator, Procurement Broker, Supplier and Evaluation Committee from the matrix", async () => {
    const repository = new SpyRoleRepository();
    const result = await new SeedRolesUseCase(repository).execute();

    expect(result.created).toEqual([...ROLE_NAMES]);
    expect(result.unchanged).toEqual([]);
    expect(result.customized).toEqual([]);
    expect(result.conflicts).toEqual([]);

    const stored = await repository.findAll();
    expect(sorted(stored.map((role) => role.roleName))).toEqual(sorted(ROLE_NAMES));
    for (const role of stored) {
      expect(role.getPermissions()).toEqual(getPermissionsForRole(role.roleName));
      expect(role.description.length).toBeGreaterThan(0);
    }
    expect(new Set(stored.map((role) => role.roleId)).size).toBe(4);
  });

  it("applies the approved rules to the seeded roles and invents no permission", async () => {
    const repository = new InMemoryRoleRepository();
    await new SeedRolesUseCase(repository).execute();
    const permissionsOf = async (name: RoleName) => (await repository.findByName(name))!.getPermissions();

    const administrator = await permissionsOf("Administrator");
    const broker = await permissionsOf("Procurement Broker");
    const supplier = await permissionsOf("Supplier");
    const committee = await permissionsOf("Evaluation Committee");

    // Only Administrators manage users and roles.
    expect(administrator).toEqual(expect.arrayContaining(["user:manage", "role:manage"]));
    for (const other of [broker, supplier, committee]) {
      expect(other).not.toContain("user:manage");
      expect(other).not.toContain("role:manage");
    }
    // Only the Evaluation Committee manages evaluations; brokers cannot touch scores.
    expect(committee).toContain("evaluation:manage");
    for (const other of [administrator, broker, supplier]) expect(other).not.toContain("evaluation:manage");
    // Suppliers get own-profile permissions only, never general supplier access.
    expect(supplier).toEqual(expect.arrayContaining(["supplier:read_own", "supplier:update_own"]));
    expect(supplier).not.toContain("supplier:manage");
    expect(supplier).not.toContain("supplier:read");
    // No award permission exists for anyone.
    for (const permissions of [administrator, broker, supplier, committee]) {
      expect(permissions.filter((permission) => permission.startsWith("award"))).toEqual([]);
      for (const permission of permissions) expect(PERMISSIONS as readonly string[]).toContain(permission);
    }
  });

  it("creates only the missing roles when some already exist", async () => {
    const repository = new SpyRoleRepository();
    const supplier = await repository.create(makeRole({ roleName: "Supplier", permissions: getPermissionsForRole("Supplier") }));
    repository.creates = 0;

    const result = await new SeedRolesUseCase(repository).execute();

    expect(result.created).toEqual(["Administrator", "Procurement Broker", "Evaluation Committee"]);
    expect(result.unchanged).toEqual(["Supplier"]);
    expect((await repository.findByName("Supplier"))?.roleId).toBe(supplier.roleId);
    expect(repository.creates).toBe(3);
  });
});

describe("SeedRolesUseCase: repeated seeding", () => {
  it("creates nothing and changes nothing the second and third time", async () => {
    const repository = new SpyRoleRepository();
    const seeder = new SeedRolesUseCase(repository);
    await seeder.execute();
    const before = (await repository.findAll()).map((role) => role.toJSON());

    for (let run = 0; run < 2; run += 1) {
      const result = await seeder.execute();
      expect(result.created).toEqual([]);
      expect(result.unchanged).toEqual([...ROLE_NAMES]);
      expect(result.customized).toEqual([]);
      expect(result.conflicts).toEqual([]);
    }

    expect(repository.creates).toBe(4);
    expect(repository.updates).toBe(0);
    expect(await repository.findAll()).toHaveLength(4);
    expect((await repository.findAll()).map((role) => role.toJSON())).toEqual(before);
  });
});

describe("SeedRolesUseCase: existing customized roles are preserved", () => {
  it("keeps added and removed permissions and the description, and reports the difference", async () => {
    const repository = new SpyRoleRepository();
    const seeder = new SeedRolesUseCase(repository);
    await seeder.execute();

    const broker = (await repository.findByName("Procurement Broker"))!;
    broker.assignPermission("report:read"); // beyond the matrix
    broker.removePermission("tender:publish"); // taken away
    broker.updateRole({ description: "Custom broker description." });
    await repository.update(broker.roleId, { description: broker.description, permissions: broker.getPermissions() });
    repository.updates = 0;
    const customized = (await repository.findByName("Procurement Broker"))!.toJSON();

    const result = await seeder.execute();

    expect(result.created).toEqual([]);
    expect(result.unchanged).toEqual(["Administrator", "Supplier", "Evaluation Committee"]);
    expect(result.customized).toEqual([
      { roleName: "Procurement Broker", missingPermissions: ["tender:publish"], extraPermissions: ["report:read"] },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(repository.updates).toBe(0);
    expect((await repository.findByName("Procurement Broker"))!.toJSON()).toEqual(customized);

    // Running again reports the same thing and still repairs nothing.
    expect((await seeder.execute()).customized).toHaveLength(1);
    expect((await repository.findByName("Procurement Broker"))!.toJSON()).toEqual(customized);
  });

  it("preserves a role that has no permissions at all", async () => {
    const repository = new SpyRoleRepository();
    await repository.create(makeRole({ roleName: "Evaluation Committee", permissions: [] }));
    const result = await new SeedRolesUseCase(repository).execute();

    expect(result.customized).toEqual([
      {
        roleName: "Evaluation Committee",
        missingPermissions: getPermissionsForRole("Evaluation Committee"),
        extraPermissions: [],
      },
    ]);
    expect((await repository.findByName("Evaluation Committee"))!.getPermissions()).toEqual([]);
    expect(repository.updates).toBe(0);
  });
});

describe("SeedRolesUseCase: conflicts and failures", () => {
  it("reports an unreadable stored role as a conflict, leaves it alone and still seeds the others", async () => {
    class CorruptSupplierRepository extends SpyRoleRepository {
      override async findByName(roleName: RoleName) {
        if (roleName === "Supplier") throw new InvalidRoleException(["permissions must be a list"]);
        return super.findByName(roleName);
      }
    }
    const repository = new CorruptSupplierRepository();
    const result = await new SeedRolesUseCase(repository).execute();

    expect(result.created).toEqual(["Administrator", "Procurement Broker", "Evaluation Committee"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.roleName).toBe("Supplier");
    expect(repository.creates).toBe(3);
    expect(repository.updates).toBe(0);
  });

  it("uses the stored role when another process created it first (duplicate on create)", async () => {
    class RacyRepository extends SpyRoleRepository {
      private raced = false;
      override async findByName(roleName: RoleName) {
        if (roleName === "Supplier" && !this.raced) return null; // looks missing the first time
        return super.findByName(roleName);
      }
      override async create(role: Role) {
        if (role.roleName === "Supplier" && !this.raced) {
          this.raced = true;
          await super.create(makeRole({ roleName: "Supplier", permissions: getPermissionsForRole("Supplier") }));
          throw new DuplicateRoleException();
        }
        return super.create(role);
      }
    }
    const repository = new RacyRepository();
    const result = await new SeedRolesUseCase(repository).execute();

    expect(result.conflicts).toEqual([]);
    expect(result.unchanged).toEqual(["Supplier"]);
    expect(result.created).toEqual(["Administrator", "Procurement Broker", "Evaluation Committee"]);
    expect(await repository.findAll()).toHaveLength(4);
  });

  it("reports a conflict when a duplicate is signalled but no such role can be found", async () => {
    class GhostRepository extends SpyRoleRepository {
      override async create(role: Role) {
        if (role.roleName === "Supplier") throw new DuplicateRoleException();
        return super.create(role);
      }
    }
    const result = await new SeedRolesUseCase(new GhostRepository()).execute();
    expect(result.conflicts.map((conflict) => conflict.roleName)).toEqual(["Supplier"]);
    expect(result.created).toEqual(["Administrator", "Procurement Broker", "Evaluation Committee"]);
  });

  it("does not swallow a storage failure: it is thrown and nothing else is written", async () => {
    class DownRepository extends SpyRoleRepository {
      override async findByName(): Promise<never> {
        throw new DatabaseOperationException({ cause: new Error("connection refused") });
      }
    }
    const repository = new DownRepository();
    const error = await catchAsyncError(() => new SeedRolesUseCase(repository).execute());

    expect(error).toBeInstanceOf(DatabaseOperationException);
    expect(repository.creates).toBe(0);
  });

  it("does not swallow a failing create", async () => {
    class FailingCreate extends SpyRoleRepository {
      override async create(): Promise<never> {
        throw new DatabaseOperationException();
      }
    }
    const error = await catchAsyncError(() => new SeedRolesUseCase(new FailingCreate()).execute());
    expect(error).toBeInstanceOf(DatabaseOperationException);
  });
});

describe("role seeding runner (npm run seed:roles)", () => {
  const emptyResult: SeedRolesResult = { created: [], unchanged: [], customized: [], conflicts: [] };

  function harness(execute: () => Promise<SeedRolesResult>, options: { prepare?: () => Promise<void>; close?: () => Promise<void> } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[] = [];
    const deps = {
      prepareStorage: async () => {
        calls.push("prepare");
        await options.prepare?.();
      },
      seedRoles: { execute },
      closeStorage: async () => {
        calls.push("close");
        await options.close?.();
      },
      print: (line: string) => void out.push(line),
      printError: (line: string) => void err.push(line),
    };
    return { deps, out, err, calls };
  }

  it("exits 0 and reports what was created", async () => {
    const h = harness(async () => ({ ...emptyResult, created: [...ROLE_NAMES] }));
    expect(await runRoleSeeding(h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Created:   Administrator, Procurement Broker, Supplier, Evaluation Committee");
    expect(h.out.join("\n")).toContain("Unchanged: none");
    expect(h.err).toEqual([]);
    expect(h.calls).toEqual(["prepare", "close"]);
  });

  it("exits 0 for preserved customizations and says so", async () => {
    const h = harness(async () => ({
      ...emptyResult,
      customized: [{ roleName: "Supplier" as const, missingPermissions: ["bid:submit"], extraPermissions: [] }],
    }));
    expect(await runRoleSeeding(h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Customized (kept as stored): Supplier");
  });

  it("exits 1 for a conflict", async () => {
    const h = harness(async () => ({ ...emptyResult, conflicts: [{ roleName: "Supplier" as const, reason: "unreadable" }] }));
    expect(await runRoleSeeding(h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("CONFLICT: Supplier: unreadable");
  });

  it("exits 1 on a database failure, prints no driver message or credentials, and still closes", async () => {
    const h = harness(async () => {
      throw new DatabaseOperationException({ cause: new Error("mongodb://admin:hunter2@db.internal refused") });
    });
    expect(await runRoleSeeding(h.deps)).toBe(1);
    const printed = h.err.join("\n");
    expect(printed).toContain("Role seeding failed (DatabaseOperationException)");
    expect(printed).not.toContain("hunter2");
    expect(h.calls).toEqual(["prepare", "close"]);
  });

  it("does not seed when the storage cannot be prepared", async () => {
    let seeded = false;
    const h = harness(
      async () => {
        seeded = true;
        return emptyResult;
      },
      { prepare: async () => { throw new Error("index failed"); } },
    );
    expect(await runRoleSeeding(h.deps)).toBe(1);
    expect(seeded).toBe(false);
  });

  it("ignores a failure while closing", async () => {
    const h = harness(async () => emptyResult, { close: async () => { throw new Error("close failed"); } });
    expect(await runRoleSeeding(h.deps)).toBe(0);
  });

  it("formats an empty result", () => {
    expect(formatSeedReport(emptyResult)).toEqual(["Created:   none", "Unchanged: none"]);
  });
});
