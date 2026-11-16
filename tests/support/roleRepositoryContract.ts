import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateRoleException, RoleNotFoundException } from "@/entities/exceptions";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import { catchAsyncError, makeRole } from "./fixtures";

/** Behaviour every RoleRepositoryInterface implementation must have. */
export function runRoleRepositoryContract(name: string, createRepository: () => Promise<RoleRepositoryInterface> | RoleRepositoryInterface) {
  describe(`RoleRepositoryInterface contract: ${name}`, () => {
    let repository: RoleRepositoryInterface;

    beforeEach(async () => {
      repository = await createRepository();
    });

    it("create() stores a role that findById() and findByName() return", async () => {
      const role = makeRole({ roleName: "Administrator", permissions: ["user:manage"] });
      await repository.create(role);

      expect((await repository.findById(role.roleId))?.toJSON()).toEqual(role.toJSON());
      expect((await repository.findByName("Administrator"))?.roleId).toBe(role.roleId);
    });

    it("findById() and findByName() return null when nothing matches", async () => {
      expect(await repository.findById("missing")).toBeNull();
      expect(await repository.findByName("Evaluation Committee")).toBeNull();
    });

    it("create() rejects a second role with the same name with DuplicateRoleException", async () => {
      await repository.create(makeRole({ roleName: "Supplier" }));
      const error = await catchAsyncError(() => repository.create(makeRole({ roleName: "Supplier" })));
      expect(error).toBeInstanceOf(DuplicateRoleException);
    });

    it("findAll() returns every available role", async () => {
      expect(await repository.findAll()).toEqual([]);
      await repository.create(makeRole({ roleName: "Administrator" }));
      await repository.create(makeRole({ roleName: "Supplier" }));

      const names = (await repository.findAll()).map((role) => role.roleName).sort();
      expect(names).toEqual(["Administrator", "Supplier"]);
    });

    it("update() changes the given fields and returns the updated role", async () => {
      const role = await repository.create(makeRole({ roleName: "Procurement Broker" }));
      const updated = await repository.update(role.roleId, { permissions: ["tender:publish"] });

      expect(updated.getPermissions()).toEqual(["tender:publish"]);
      expect(updated.description).toBe(role.description);
      expect((await repository.findById(role.roleId))?.getPermissions()).toEqual(["tender:publish"]);
    });

    it("update() throws RoleNotFoundException for an unknown role", async () => {
      const error = await catchAsyncError(() => repository.update("missing", { description: "Anything" }));
      expect(error).toBeInstanceOf(RoleNotFoundException);
    });
  });
}
