import { ObjectId, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { DuplicateRegistrationException, SupplierVerificationException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import {
  MongoSupplierRepository,
  SUPPLIER_REGISTRATION_INDEX,
  SUPPLIER_STATUS_INDEX,
  SUPPLIER_USER_INDEX,
} from "@/repositories/MongoSupplierRepository";
import { catchAsyncError, makeSupplier } from "../support/fixtures";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";
import { runSupplierRepositoryContract } from "../support/supplierRepositoryContract";

const target = await resolveMongoTestTarget();
console.info(`[integration] Mongo supplier repository tests target: ${target ? target.source : "none (SKIPPED)"}`);

let connection: MongoDBConnection | null = null;
let counter = 0;

function getConnection(): MongoDBConnection {
  if (!target) throw new Error("no target");
  if (!connection) {
    const configuration = new EnvironmentConfiguration({ NODE_ENV: "test", MONGODB_URI: target.uri, MONGODB_DB_NAME: target.databaseName });
    connection = new MongoDBConnection(configuration, new LoggingAndDeploymentConfiguration(configuration, { write: () => undefined }));
  }
  return connection;
}

/** A fresh, uniquely named collection for each test. */
function freshName(): string {
  counter += 1;
  return `suppliers_${counter}`;
}

afterAll(async () => {
  if (!target) return;
  // Only the throw-away database created for this run is dropped.
  if (connection) {
    await (await getConnection().getDatabase()).dropDatabase();
    await connection.closeConnection();
  }
  await target.stop();
});

describe.skipIf(!target)("MongoSupplierRepository against a real MongoDB", () => {
  runSupplierRepositoryContract("MongoSupplierRepository", () => new MongoSupplierRepository(getConnection(), { collectionName: freshName() }));

  async function setup() {
    const name = freshName();
    const repository = new MongoSupplierRepository(getConnection(), { collectionName: name });
    const db: Db = await getConnection().getDatabase();
    return { repository, collection: db.collection(name) };
  }

  it("creates its indexes repeatably, two of them unique", async () => {
    const { repository, collection } = await setup();
    await repository.ensureIndexes();
    await repository.ensureIndexes();

    const indexes = await collection.indexes();
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([SUPPLIER_REGISTRATION_INDEX, SUPPLIER_USER_INDEX, SUPPLIER_STATUS_INDEX]));
    expect(indexes.find((index) => index.name === SUPPLIER_REGISTRATION_INDEX)?.unique).toBe(true);
    expect(indexes.find((index) => index.name === SUPPLIER_USER_INDEX)?.unique).toBe(true);
  });

  it("the database itself rejects a second profile with the same registration key or userId", async () => {
    const { repository, collection } = await setup();
    const supplier = await repository.create(makeSupplier({ registrationNumber: "DB-1" }));

    await expect(collection.insertOne({ _id: "other-id" as unknown as ObjectId, registrationNumberKey: "db-1", userId: "someone-else" })).rejects.toMatchObject({ code: 11000 });
    await expect(collection.insertOne({ _id: "another-id" as unknown as ObjectId, registrationNumberKey: "different", userId: supplier.userId })).rejects.toMatchObject({ code: 11000 });
  });

  it("stores the supplierId as _id, a BSON date and the normalized registration key", async () => {
    const { repository, collection } = await setup();
    const supplier = await repository.create(makeSupplier({ registrationNumber: " Mixed-Case-1 " }));

    const raw = await collection.findOne({ _id: supplier.supplierId as unknown as ObjectId });
    expect(raw?._id).toBe(supplier.supplierId);
    expect(raw?.registrationDate).toBeInstanceOf(Date);
    expect(raw?.registrationNumberKey).toBe("mixed-case-1");
    expect(raw).not.toHaveProperty("supplierId");
  });

  it("two simultaneous registrations of the same number: exactly one wins, the other gets DuplicateRegistrationException", async () => {
    const { repository } = await setup();
    const results = await Promise.allSettled([
      repository.create(makeSupplier({ registrationNumber: "RACE-1" })),
      repository.create(makeSupplier({ registrationNumber: "race-1" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DuplicateRegistrationException);
  });

  it("two reviewers deciding at the same moment: exactly one wins and the stored status is the winner's", async () => {
    const { repository } = await setup();
    const supplier = await repository.create(makeSupplier());

    const results = await Promise.allSettled([
      repository.updateVerificationStatus(supplier.supplierId, "Verified", { expectedStatus: "Pending" }),
      repository.updateVerificationStatus(supplier.supplierId, "Rejected", { expectedStatus: "Pending" }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(SupplierVerificationException);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ verificationStatus: string }>).value.verificationStatus;
    expect((await repository.findById(supplier.supplierId))?.verificationStatus).toBe(winner);
  });

  it("reports a corrupt stored document as a safe error", async () => {
    const { repository, collection } = await setup();
    await collection.insertOne({ _id: "corrupt" as unknown as ObjectId, companyName: "Secret Company", verificationStatus: "Archived" });

    const error = await catchAsyncError(() => repository.findById("corrupt"));
    expect(JSON.stringify((error as unknown as { toSafeResponse(): unknown }).toSafeResponse())).not.toContain("Secret Company");
  });
});
