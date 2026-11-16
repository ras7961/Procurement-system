import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateEmailException, UserNotFoundException } from "@/entities/exceptions";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { catchAsyncError, makeUser } from "./fixtures";

/**
 * Behaviour every UserRepositoryInterface implementation must have.
 * Run it against the in-memory double now and against MongoUserRepository later.
 */
export function runUserRepositoryContract(name: string, createRepository: () => Promise<UserRepositoryInterface> | UserRepositoryInterface) {
  describe(`UserRepositoryInterface contract: ${name}`, () => {
    let repository: UserRepositoryInterface;

    beforeEach(async () => {
      repository = await createRepository();
    });

    it("create() stores a user that findById() returns with the same data, including the hash", async () => {
      const user = makeUser();
      const created = await repository.create(user);
      const found = await repository.findById(user.userId);

      expect(created.userId).toBe(user.userId);
      expect(found?.toJSON()).toEqual(user.toJSON());
      expect(found?.passwordHash).toBe(user.passwordHash);
    });

    it("findById() and findByEmail() return null when nothing matches", async () => {
      expect(await repository.findById("missing")).toBeNull();
      expect(await repository.findByEmail("nobody@example.com")).toBeNull();
    });

    it("findByEmail() ignores case and surrounding spaces", async () => {
      const user = makeUser({ email: "Mixed.Case@Example.com" });
      await repository.create(user);

      expect((await repository.findByEmail("  MIXED.case@example.COM "))?.userId).toBe(user.userId);
    });

    it("create() rejects a duplicate email with DuplicateEmailException", async () => {
      await repository.create(makeUser({ email: "same@example.com" }));
      const error = await catchAsyncError(() => repository.create(makeUser({ email: "SAME@example.com" })));
      expect(error).toBeInstanceOf(DuplicateEmailException);
    });

    it("update() changes the given fields only and returns the updated user", async () => {
      const user = await repository.create(makeUser({ fullName: "Old Name" }));
      const updated = await repository.update(user.userId, { fullName: "New Name" });

      expect(updated.fullName).toBe("New Name");
      expect(updated.email).toBe(user.email);
      expect((await repository.findById(user.userId))?.fullName).toBe("New Name");
    });

    it("update() rejects an email owned by another user, but allows keeping your own", async () => {
      await repository.create(makeUser({ email: "taken@example.com" }));
      const other = await repository.create(makeUser({ email: "other@example.com" }));

      const error = await catchAsyncError(() => repository.update(other.userId, { email: "taken@example.com" }));
      expect(error).toBeInstanceOf(DuplicateEmailException);
      await expect(repository.update(other.userId, { email: "other@example.com" })).resolves.toBeDefined();
    });

    it("update() and updateStatus() throw UserNotFoundException for an unknown user", async () => {
      expect(await catchAsyncError(() => repository.update("missing", { fullName: "X Y" }))).toBeInstanceOf(UserNotFoundException);
      expect(await catchAsyncError(() => repository.updateStatus("missing", "Inactive"))).toBeInstanceOf(UserNotFoundException);
    });

    it("updateStatus() changes only the status, for every status including Pending", async () => {
      const user = await repository.create(makeUser());
      for (const status of ["Pending", "Suspended", "Inactive", "Active"] as const) {
        const updated = await repository.updateStatus(user.userId, status);

        expect(updated.status).toBe(status);
        expect(updated.email).toBe(user.email);
        expect((await repository.findById(user.userId))?.status).toBe(status);
      }
    });

    it("delete() removes the user and throws UserNotFoundException for an unknown user", async () => {
      const user = await repository.create(makeUser());
      await repository.delete(user.userId);

      expect(await repository.findById(user.userId)).toBeNull();
      expect(await catchAsyncError(() => repository.delete(user.userId))).toBeInstanceOf(UserNotFoundException);
    });

    it("findAll() returns every stored user", async () => {
      expect(await repository.findAll()).toEqual([]);
      const first = await repository.create(makeUser());
      const second = await repository.create(makeUser());

      const ids = (await repository.findAll()).map((user) => user.userId).sort();
      expect(ids).toEqual([first.userId, second.userId].sort());
    });

    it("returns new instances: changing one does not change stored data until update()", async () => {
      const user = await repository.create(makeUser({ fullName: "Stored Name" }));
      const loaded = await repository.findById(user.userId);
      loaded?.updateProfile({ fullName: "Changed In Memory" });

      expect((await repository.findById(user.userId))?.fullName).toBe("Stored Name");
    });
  });
}
