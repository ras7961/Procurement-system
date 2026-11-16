import { describe, expect, it } from "vitest";
import {
  DatabaseOperationException,
  DuplicateRegistrationException,
  SupplierNotFoundException,
  SupplierRepositoryException,
  SupplierVerificationException,
} from "@/entities/exceptions";
import {
  MongoSupplierRepository,
  SUPPLIER_REGISTRATION_INDEX,
  SUPPLIER_STATUS_INDEX,
  SUPPLIER_USER_INDEX,
} from "@/repositories/MongoSupplierRepository";
import { toSupplier, toSupplierDocument } from "@/repositories/supplierDocumentMapper";
import { catchAsyncError, makeSupplier } from "../support/fixtures";
import { fakeConnection, FakeMongoCollection } from "../support/fakeMongoCollection";
import { InMemorySupplierRepository } from "../support/InMemorySupplierRepository";
import { runSupplierRepositoryContract } from "../support/supplierRepositoryContract";

/**
 * The in-memory double and MongoSupplierRepository's own code (run against a minimal fake collection) must both satisfy
 * the same contract. The fake proves the repository's logic, not MongoDB: the real-database version of these tests is
 * tests/integration/mongo-supplier-repository.test.ts and is skipped when no MongoDB is available.
 */
runSupplierRepositoryContract("InMemorySupplierRepository", () => new InMemorySupplierRepository());
runSupplierRepositoryContract("MongoSupplierRepository (fake collection)", () => new MongoSupplierRepository(fakeConnection(new FakeMongoCollection())));

function setup() {
  const collection = new FakeMongoCollection();
  return { collection, repository: new MongoSupplierRepository(fakeConnection(collection)) };
}

describe("MongoSupplierRepository (fake collection): specifics", () => {
  it("creates its three indexes (two unique) once, even when used many times", async () => {
    const { collection, repository } = setup();
    await repository.ensureIndexes();
    await repository.create(makeSupplier());
    await repository.findAll();

    expect(collection.indexes.map((index) => index.name)).toEqual([SUPPLIER_REGISTRATION_INDEX, SUPPLIER_USER_INDEX, SUPPLIER_STATUS_INDEX]);
  });

  it("stores the supplierId as _id, a BSON date, the normalized registration key and nothing about the account", async () => {
    const { collection, repository } = setup();
    const supplier = await repository.create(makeSupplier({ registrationNumber: " Et-9 " }));

    const raw = collection.documents.get(supplier.supplierId)!;
    expect(raw._id).toBe(supplier.supplierId);
    expect(raw.registrationDate).toBeInstanceOf(Date);
    expect(raw.registrationNumber).toBe("Et-9");
    expect(raw.registrationNumberKey).toBe("et-9");
    expect(raw).not.toHaveProperty("supplierId");
    expect(Object.keys(raw).join(",")).not.toMatch(/password|role|status$/i);
  });

  it("never exposes the registration key through a returned supplier", async () => {
    const { repository } = setup();
    const supplier = await repository.create(makeSupplier());
    expect(JSON.stringify((await repository.findById(supplier.supplierId))?.toJSON())).not.toContain("registrationNumberKey");
  });

  it("reports a corrupt stored document as a safe SupplierRepositoryException", async () => {
    const { collection, repository } = setup();
    collection.documents.set("corrupt", { _id: "corrupt", companyName: "Secret Company", verificationStatus: "Archived" });

    const error = await catchAsyncError(() => repository.findById("corrupt"));
    expect(error).toBeInstanceOf(SupplierRepositoryException);
    expect(JSON.stringify((error as SupplierRepositoryException).toSafeResponse())).not.toContain("Secret Company");
  });

  it("reads a document stored with an ObjectId-like _id and string dates", () => {
    const supplier = makeSupplier();
    const document = { ...toSupplierDocument(supplier), registrationDate: supplier.registrationDate.toISOString() };
    expect(toSupplier(document).supplierId).toBe(supplier.supplierId);
  });

  it("a driver failure becomes a safe DatabaseOperationException without the driver message", async () => {
    const { collection, repository } = setup();
    collection.failWith = new Error("connection string mongodb://user:secret@host failed");

    const error = await catchAsyncError(() => repository.findById("x"));
    expect(error).toBeInstanceOf(DatabaseOperationException);
    expect(JSON.stringify((error as DatabaseOperationException).toSafeResponse())).not.toContain("secret");
  });

  it("a unique-index race on the registration number (E11000 with a keyPattern) becomes DuplicateRegistrationException", async () => {
    const { collection, repository } = setup();
    collection.failWith = Object.assign(new Error("E11000 duplicate key error"), { code: 11000, keyPattern: { registrationNumberKey: 1 } });
    expect(await catchAsyncError(() => repository.create(makeSupplier()))).toBeInstanceOf(DuplicateRegistrationException);
  });

  it("a duplicate on _id (E11000 without a unique-index keyPattern) becomes SupplierRepositoryException", async () => {
    const { collection, repository } = setup();
    collection.failWith = Object.assign(new Error("E11000 duplicate key error"), { code: 11000, keyPattern: { _id: 1 } });
    expect(await catchAsyncError(() => repository.create(makeSupplier()))).toBeInstanceOf(SupplierRepositoryException);
  });

  it("a verification decision made between the read and the write is not overwritten", async () => {
    const { collection, repository } = setup();
    const supplier = await repository.create(makeSupplier());
    // Another reviewer rejects the supplier after this request has read it as Pending.
    collection.beforeNextWrite = () => {
      collection.documents.set(supplier.supplierId, { ...collection.documents.get(supplier.supplierId)!, verificationStatus: "Rejected" });
    };

    const error = await catchAsyncError(() => repository.updateVerificationStatus(supplier.supplierId, "Verified"));
    expect(error).toBeInstanceOf(SupplierVerificationException);
    expect(collection.documents.get(supplier.supplierId)?.verificationStatus).toBe("Rejected");
  });

  it("an edit that resets verification loses to a review that happened first", async () => {
    const { collection, repository } = setup();
    const supplier = await repository.create(makeSupplier());
    collection.beforeNextWrite = () => {
      collection.documents.set(supplier.supplierId, { ...collection.documents.get(supplier.supplierId)!, verificationStatus: "Verified" });
    };

    const error = await catchAsyncError(() => repository.update(supplier.supplierId, { address: "New address" }));
    expect(error).toBeInstanceOf(SupplierVerificationException);
  });

  it("an update or review of a supplier deleted in between reports SupplierNotFoundException", async () => {
    const { collection, repository } = setup();
    const supplier = await repository.create(makeSupplier());
    collection.beforeNextWrite = () => void collection.documents.delete(supplier.supplierId);

    expect(await catchAsyncError(() => repository.updateVerificationStatus(supplier.supplierId, "Verified"))).toBeInstanceOf(SupplierNotFoundException);
  });
});
