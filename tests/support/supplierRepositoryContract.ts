import { beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateRegistrationException,
  InvalidSupplierDataException,
  SupplierNotFoundException,
  SupplierRepositoryException,
  SupplierVerificationException,
} from "@/entities/exceptions";
import type { SupplierRepositoryInterface } from "@/interfaces/repositories/SupplierRepositoryInterface";
import { catchAsyncError, makeSupplier, TENDER_NOW } from "./fixtures";

const minute = (n: number) => new Date(TENDER_NOW.getTime() + n * 60 * 1000);

/** Behaviour every SupplierRepositoryInterface implementation must have. */
export function runSupplierRepositoryContract(name: string, createRepository: () => Promise<SupplierRepositoryInterface> | SupplierRepositoryInterface) {
  describe(`SupplierRepositoryInterface contract: ${name}`, () => {
    let repository: SupplierRepositoryInterface;

    beforeEach(async () => {
      repository = await createRepository();
    });

    describe("create and the finders", () => {
      it("stores a supplier that findById() returns with every field", async () => {
        const supplier = makeSupplier();
        await repository.create(supplier);
        expect((await repository.findById(supplier.supplierId))?.toJSON()).toEqual(supplier.toJSON());
      });

      it("every finder returns null when nothing matches", async () => {
        expect(await repository.findById("missing")).toBeNull();
        expect(await repository.findByUserId("missing")).toBeNull();
        expect(await repository.findByRegistrationNumber("missing")).toBeNull();
        expect(await repository.findByEmail("missing@example.com")).toBeNull();
      });

      it("finds by userId, by registration number (ignoring case and spaces) and by email (ignoring case)", async () => {
        const supplier = await repository.create(makeSupplier({ registrationNumber: "Et-Reg-77", email: "Sales@Firm.Example" }));
        expect((await repository.findByUserId(supplier.userId))?.supplierId).toBe(supplier.supplierId);
        expect((await repository.findByRegistrationNumber("  et-reg-77 "))?.supplierId).toBe(supplier.supplierId);
        expect((await repository.findByEmail("sales@firm.example"))?.supplierId).toBe(supplier.supplierId);
      });

      it("findByEmail returns the earliest registered supplier when a contact email is shared", async () => {
        const later = await repository.create(makeSupplier({ email: "shared@firm.example", registrationDate: minute(5) }));
        const earlier = await repository.create(makeSupplier({ email: "shared@firm.example", registrationDate: minute(1) }));
        expect((await repository.findByEmail("shared@firm.example"))?.supplierId).toBe(earlier.supplierId);
        expect(later.supplierId).not.toBe(earlier.supplierId);
      });

      it("create() rejects a registration number that differs only by case with DuplicateRegistrationException", async () => {
        await repository.create(makeSupplier({ registrationNumber: "ABC-1" }));
        expect(await catchAsyncError(() => repository.create(makeSupplier({ registrationNumber: " abc-1 " })))).toBeInstanceOf(DuplicateRegistrationException);
      });

      it("create() rejects a second profile for the same user with DuplicateRegistrationException", async () => {
        const first = await repository.create(makeSupplier());
        expect(await catchAsyncError(() => repository.create(makeSupplier({ userId: first.userId })))).toBeInstanceOf(DuplicateRegistrationException);
      });

      it("create() rejects an existing supplierId with SupplierRepositoryException", async () => {
        const supplier = makeSupplier();
        await repository.create(supplier);
        const clash = makeSupplier({ supplierId: supplier.supplierId });
        expect(await catchAsyncError(() => repository.create(clash))).toBeInstanceOf(SupplierRepositoryException);
      });

      it("returns new instances: changing one does not change stored data", async () => {
        const stored = await repository.create(makeSupplier());
        stored.updateProfile({ address: "Changed locally" });
        expect((await repository.findById(stored.supplierId))?.address).toBe("Bole Road, Addis Ababa");
      });
    });

    describe("update", () => {
      it("changes only the given fields and keeps supplierId, userId and registrationDate", async () => {
        const supplier = await repository.create(makeSupplier());
        const updated = await repository.update(supplier.supplierId, { address: "New address", phoneNumber: "+251 11 999 9999" });
        expect(updated.toJSON()).toEqual({ ...supplier.toJSON(), address: "New address", phoneNumber: "+251 11 999 9999" });
        expect((await repository.findById(supplier.supplierId))?.toJSON()).toEqual(updated.toJSON());
      });

      it("stores a change of registration number so the new number is found and the old one is free", async () => {
        const supplier = await repository.create(makeSupplier({ registrationNumber: "OLD-1" }));
        await repository.update(supplier.supplierId, { registrationNumber: "NEW-1" });
        expect(await repository.findByRegistrationNumber("old-1")).toBeNull();
        expect((await repository.findByRegistrationNumber("new-1"))?.supplierId).toBe(supplier.supplierId);
        await repository.create(makeSupplier({ registrationNumber: "OLD-1" })); // free again
      });

      it("rejects a registration number owned by another supplier, but allows re-casing your own", async () => {
        await repository.create(makeSupplier({ registrationNumber: "TAKEN-1" }));
        const mine = await repository.create(makeSupplier({ registrationNumber: "MINE-1" }));
        expect(await catchAsyncError(() => repository.update(mine.supplierId, { registrationNumber: "taken-1" }))).toBeInstanceOf(DuplicateRegistrationException);
        expect((await repository.update(mine.supplierId, { registrationNumber: "mine-1" })).registrationNumber).toBe("mine-1");
      });

      it("can store the reset to Pending decided by the entity", async () => {
        const supplier = await repository.create(makeSupplier());
        await repository.updateVerificationStatus(supplier.supplierId, "Verified");
        const updated = await repository.update(supplier.supplierId, { companyName: "Renamed PLC", verificationStatus: "Pending" });
        expect(updated.verificationStatus).toBe("Pending");
        expect(updated.companyName).toBe("Renamed PLC");
      });

      it("an update that changes nothing returns the stored supplier", async () => {
        const supplier = await repository.create(makeSupplier());
        expect((await repository.update(supplier.supplierId, {})).toJSON()).toEqual(supplier.toJSON());
      });

      it("rejects invalid values and fields that cannot change with InvalidSupplierDataException", async () => {
        const supplier = await repository.create(makeSupplier());
        for (const data of [{ email: "bad" }, { companyName: "" }, { userId: "x" }, { supplierId: "x" }, { registrationDate: new Date() }, { verificationStatus: "Archived" }]) {
          expect(await catchAsyncError(() => repository.update(supplier.supplierId, data as never))).toBeInstanceOf(InvalidSupplierDataException);
        }
        expect((await repository.findById(supplier.supplierId))?.toJSON()).toEqual(supplier.toJSON());
      });

      it("throws SupplierNotFoundException for an unknown supplierId", async () => {
        expect(await catchAsyncError(() => repository.update("missing", { address: "x" }))).toBeInstanceOf(SupplierNotFoundException);
      });
    });

    describe("updateVerificationStatus", () => {
      it("sets Verified or Rejected and stores it", async () => {
        const supplier = await repository.create(makeSupplier());
        expect((await repository.updateVerificationStatus(supplier.supplierId, "Verified")).verificationStatus).toBe("Verified");
        expect((await repository.updateVerificationStatus(supplier.supplierId, "Rejected")).verificationStatus).toBe("Rejected");
        expect((await repository.findById(supplier.supplierId))?.verificationStatus).toBe("Rejected");
      });

      it("refuses the status the supplier already has and refuses Pending", async () => {
        const supplier = await repository.create(makeSupplier());
        await repository.updateVerificationStatus(supplier.supplierId, "Verified");
        expect(await catchAsyncError(() => repository.updateVerificationStatus(supplier.supplierId, "Verified"))).toBeInstanceOf(SupplierVerificationException);
        expect(await catchAsyncError(() => repository.updateVerificationStatus(supplier.supplierId, "Pending"))).toBeInstanceOf(InvalidSupplierDataException);
      });

      it("with expectedStatus, fails when the supplier is no longer in that status", async () => {
        const supplier = await repository.create(makeSupplier());
        await repository.updateVerificationStatus(supplier.supplierId, "Rejected");
        const error = await catchAsyncError(() => repository.updateVerificationStatus(supplier.supplierId, "Verified", { expectedStatus: "Pending" }));
        expect(error).toBeInstanceOf(SupplierVerificationException);
        expect((await repository.findById(supplier.supplierId))?.verificationStatus).toBe("Rejected");
      });

      it("throws SupplierNotFoundException for an unknown supplierId", async () => {
        expect(await catchAsyncError(() => repository.updateVerificationStatus("missing", "Verified"))).toBeInstanceOf(SupplierNotFoundException);
      });
    });

    describe("findAll", () => {
      it("returns suppliers newest registration first", async () => {
        const a = await repository.create(makeSupplier({ registrationDate: minute(1) }));
        const b = await repository.create(makeSupplier({ registrationDate: minute(3) }));
        const c = await repository.create(makeSupplier({ registrationDate: minute(2) }));
        expect((await repository.findAll()).map((s) => s.supplierId)).toEqual([b.supplierId, c.supplierId, a.supplierId]);
      });

      it("filters by one or several verification statuses", async () => {
        const pending = await repository.create(makeSupplier());
        const verified = await repository.create(makeSupplier());
        const rejected = await repository.create(makeSupplier());
        await repository.updateVerificationStatus(verified.supplierId, "Verified");
        await repository.updateVerificationStatus(rejected.supplierId, "Rejected");

        expect((await repository.findAll({ verificationStatus: "Verified" })).map((s) => s.supplierId)).toEqual([verified.supplierId]);
        const two = (await repository.findAll({ verificationStatus: ["Pending", "Rejected"] })).map((s) => s.supplierId);
        expect(two.sort()).toEqual([pending.supplierId, rejected.supplierId].sort());
      });

      it("pages with limit and skip", async () => {
        for (let i = 1; i <= 5; i += 1) await repository.create(makeSupplier({ registrationDate: minute(i) }));
        const all = (await repository.findAll()).map((s) => s.supplierId);
        expect((await repository.findAll({ limit: 2 })).map((s) => s.supplierId)).toEqual(all.slice(0, 2));
        expect((await repository.findAll({ limit: 2, skip: 2 })).map((s) => s.supplierId)).toEqual(all.slice(2, 4));
        expect(await repository.findAll({ skip: 10 })).toEqual([]);
      });

      it("returns an empty list when there are no suppliers", async () => {
        expect(await repository.findAll()).toEqual([]);
      });

      it("rejects bad filters with InvalidSupplierDataException", async () => {
        for (const bad of [{ verificationStatus: "Nope" }, { limit: 0 }, { limit: 501 }, { skip: -1 }]) {
          expect(await catchAsyncError(() => repository.findAll(bad as never))).toBeInstanceOf(InvalidSupplierDataException);
        }
      });
    });
  });
}
