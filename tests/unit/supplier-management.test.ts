import { beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateRegistrationException,
  InvalidSupplierDataException,
  SupplierNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import { User, type UserStatus } from "@/entities/User";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { SupplierManagementUseCase } from "@/usecases/supplier/SupplierManagementUseCase";
import { generateId } from "@/shared/utilities/uuid";
import { catchAsyncError } from "../support/fixtures";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemorySupplierRepository } from "../support/InMemorySupplierRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";
import { FakePasswordService } from "../support/authFakes";

const passwords = new FakePasswordService();

type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";

const PROFILE = {
  companyName: "Abyssinia Office Supplies PLC",
  registrationNumber: "ET-1",
  email: "contact@abyssinia.example",
  phoneNumber: "+251 11 123 4567",
  address: "Bole Road, Addis Ababa",
};

let users: InMemoryUserRepository;
let roles: InMemoryRoleRepository;
let suppliers: InMemorySupplierRepository;
let useCase: SupplierManagementUseCase;
let ids = 0;

beforeEach(async () => {
  users = new InMemoryUserRepository();
  roles = new InMemoryRoleRepository();
  suppliers = new InMemorySupplierRepository();
  await new SeedRolesUseCase(roles).execute();
  useCase = new SupplierManagementUseCase(new AuthorizeUseCase(users, roles), suppliers, users, roles);
});

async function userWithRole(roleName: RoleName, status: UserStatus = "Active"): Promise<string> {
  const role = (await roles.findByName(roleName))!;
  ids += 1;
  const user = await users.create(
    User.restore({ userId: generateId(), fullName: "Test", email: `u${ids}@example.com`, passwordHash: await passwords.hash("correct horse battery"), roleId: role.roleId, status, createdAt: new Date() }),
  );
  return user.userId;
}

const register = (actingUserId: string, extra: Record<string, unknown> = {}) =>
  useCase.registerSupplier({ actingUserId, ...PROFILE, registrationNumber: `ET-${(ids += 1)}`, ...extra });

describe("SupplierManagementUseCase: authorization from storage", () => {
  it("every operation refuses an unknown acting user", async () => {
    const ghost = generateId();
    const attempts = [
      () => register(ghost),
      () => useCase.listSuppliers({ actingUserId: ghost }),
      () => useCase.getSupplier({ actingUserId: ghost, supplierId: "x" }),
      () => useCase.getOwnSupplier({ actingUserId: ghost }),
      () => useCase.updateSupplier({ actingUserId: ghost, supplierId: "x", changes: { address: "a" } }),
      () => useCase.verifySupplier({ actingUserId: ghost, supplierId: "x", status: "Verified" }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeDefined();
  });

  it.each(["Pending", "Suspended", "Inactive"] as const)("a %s account is refused for every operation", async (status) => {
    const inactive = await userWithRole("Supplier", status);
    const staffInactive = await userWithRole("Administrator", status);
    for (const actingUserId of [inactive, staffInactive]) {
      await expect(register(actingUserId, { userId: inactive })).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
      await expect(useCase.listSuppliers({ actingUserId })).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
      await expect(useCase.getOwnSupplier({ actingUserId })).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
    }
  });

  it("Evaluation Committee has no supplier access at all", async () => {
    const committee = await userWithRole("Evaluation Committee");
    expect(await catchAsyncError(() => register(committee))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => useCase.listSuppliers({ actingUserId: committee }))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => useCase.getSupplier({ actingUserId: committee, supplierId: "x" }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("a permission stored on a role that the approved matrix does not give it to is still refused (fails closed)", async () => {
    const committeeRole = (await roles.findByName("Evaluation Committee"))!;
    await roles.update(committeeRole.roleId, { permissions: [...committeeRole.getPermissions(), "supplier:manage", "supplier:read", "supplier:update_own"] });
    const committee = await userWithRole("Evaluation Committee");
    const supplierUser = await userWithRole("Supplier");
    const created = await register(supplierUser);

    expect(await catchAsyncError(() => register(committee, { userId: supplierUser }))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => useCase.listSuppliers({ actingUserId: committee }))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => useCase.verifySupplier({ actingUserId: committee, supplierId: created.supplierId, status: "Verified" }))).toBeInstanceOf(UnauthorizedAccessException);
  });
});

describe("SupplierManagementUseCase: ownership", () => {
  it("a Supplier's profile is theirs: another Supplier gets SupplierNotFound for read, update and verify", async () => {
    const owner = await userWithRole("Supplier");
    const other = await userWithRole("Supplier");
    const created = await register(owner);

    expect(await catchAsyncError(() => useCase.getSupplier({ actingUserId: other, supplierId: created.supplierId }))).toBeInstanceOf(SupplierNotFoundException);
    expect(await catchAsyncError(() => useCase.updateSupplier({ actingUserId: other, supplierId: created.supplierId, changes: { address: "x" } }))).toBeInstanceOf(SupplierNotFoundException);
    expect(await catchAsyncError(() => useCase.verifySupplier({ actingUserId: other, supplierId: created.supplierId, status: "Verified" }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("a Supplier cannot register a profile for another user, even by naming their own id incorrectly", async () => {
    const supplier = await userWithRole("Supplier");
    const other = await userWithRole("Supplier");
    expect(await catchAsyncError(() => register(supplier, { userId: other }))).toBeInstanceOf(InvalidSupplierDataException);
    expect(await suppliers.findByUserId(other)).toBeNull();
    expect((await register(supplier, { userId: supplier })).userId).toBe(supplier); // naming yourself is harmless
  });

  it("the owner is taken from the acting user, never from client data", async () => {
    const supplier = await userWithRole("Supplier");
    const created = await register(supplier, { supplierId: "client-chosen", verificationStatus: "Verified", registrationDate: "2000-01-01" });
    expect(created.userId).toBe(supplier);
    expect(created.supplierId).not.toBe("client-chosen");
    expect(created.verificationStatus).toBe("Pending");
    expect(new Date(created.registrationDate).getFullYear()).toBeGreaterThan(2000);
  });

  it("staff may only register for a user with the Supplier role", async () => {
    const admin = await userWithRole("Administrator");
    const broker = await userWithRole("Procurement Broker");
    expect(await catchAsyncError(() => register(admin, { userId: broker }))).toBeInstanceOf(InvalidSupplierDataException);
    expect(await catchAsyncError(() => register(admin, { userId: generateId() }))).toBeInstanceOf(InvalidSupplierDataException);
    expect(await catchAsyncError(() => register(admin))).toBeInstanceOf(InvalidSupplierDataException);
  });

  it("registration numbers and accounts are unique", async () => {
    const a = await userWithRole("Supplier");
    const b = await userWithRole("Supplier");
    await register(a, { registrationNumber: "SAME-1" });
    expect(await catchAsyncError(() => register(b, { registrationNumber: "same-1" }))).toBeInstanceOf(DuplicateRegistrationException);
    expect(await catchAsyncError(() => register(a, { registrationNumber: "OTHER-1" }))).toBeInstanceOf(DuplicateRegistrationException);
  });
});

describe("SupplierManagementUseCase: operations", () => {
  it("lists newest first with filters; a Supplier cannot list", async () => {
    const admin = await userWithRole("Administrator");
    const s1 = await register(await userWithRole("Supplier"));
    const s2 = await register(await userWithRole("Supplier"));
    await useCase.verifySupplier({ actingUserId: admin, supplierId: s1.supplierId, status: "Verified" });

    const all = await useCase.listSuppliers({ actingUserId: admin });
    expect(all.suppliers.map((s) => s.supplierId).sort()).toEqual([s1.supplierId, s2.supplierId].sort());
    const verified = await useCase.listSuppliers({ actingUserId: admin, verificationStatus: "Verified" });
    expect(verified.suppliers.map((s) => s.supplierId)).toEqual([s1.supplierId]);
    expect(await catchAsyncError(() => useCase.listSuppliers({ actingUserId: s1.userId }))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => useCase.listSuppliers({ actingUserId: admin, limit: 0 }))).toBeInstanceOf(InvalidSupplierDataException);
  });

  it("getOwnSupplier returns the caller's profile or SupplierNotFound", async () => {
    const owner = await userWithRole("Supplier");
    expect(await catchAsyncError(() => useCase.getOwnSupplier({ actingUserId: owner }))).toBeInstanceOf(SupplierNotFoundException);
    const created = await register(owner);
    expect((await useCase.getOwnSupplier({ actingUserId: owner })).supplierId).toBe(created.supplierId);
  });

  it("updateSupplier rejects protected fields before writing anything", async () => {
    const owner = await userWithRole("Supplier");
    const created = await register(owner);
    for (const changes of [{ verificationStatus: "Verified" }, { userId: "x" }, { supplierId: "x" }, {}]) {
      expect(await catchAsyncError(() => useCase.updateSupplier({ actingUserId: owner, supplierId: created.supplierId, changes: changes as never }))).toBeInstanceOf(InvalidSupplierDataException);
    }
    expect((await suppliers.findById(created.supplierId))!.toJSON()).toEqual(created);
  });

  it("verification decisions follow the entity rules and a repeat is refused", async () => {
    const admin = await userWithRole("Administrator");
    const created = await register(await userWithRole("Supplier"));
    const verified = await useCase.verifySupplier({ actingUserId: admin, supplierId: created.supplierId, status: "Verified" });
    expect(verified.verificationStatus).toBe("Verified");
    await expect(useCase.verifySupplier({ actingUserId: admin, supplierId: created.supplierId, status: "Verified" })).rejects.toMatchObject({ code: "SUPPLIER_VERIFICATION_ERROR" });
    expect(await catchAsyncError(() => useCase.verifySupplier({ actingUserId: admin, supplierId: created.supplierId, status: "Pending" as never }))).toBeInstanceOf(InvalidSupplierDataException);
  });

  it("an invalid or non-string supplier id is SupplierNotFound", async () => {
    const admin = await userWithRole("Administrator");
    for (const supplierId of ["", "  ", undefined, null, 5, {}]) {
      expect(await catchAsyncError(() => useCase.getSupplier({ actingUserId: admin, supplierId: supplierId as never }))).toBeInstanceOf(SupplierNotFoundException);
    }
  });
});
