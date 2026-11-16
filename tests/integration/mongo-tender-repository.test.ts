import { ObjectId, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { InvalidTenderStatusException, TenderRepositoryException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { MongoTenderRepository, TENDER_BROKER_INDEX, TENDER_STATUS_DEADLINE_INDEX } from "@/repositories/MongoTenderRepository";
import { toTenderDocument } from "@/repositories/tenderDocumentMapper";
import { catchAsyncError, makeTender, TENDER_NOW } from "../support/fixtures";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";
import { runTenderRepositoryContract } from "../support/tenderRepositoryContract";

const target = await resolveMongoTestTarget();
console.info(`[integration] Mongo tender repository tests target: ${target ? target.source : "none (SKIPPED)"}`);

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
  return `tenders_${counter}`;
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

describe.skipIf(!target)("MongoTenderRepository against a real MongoDB", () => {
  runTenderRepositoryContract("MongoTenderRepository", () => new MongoTenderRepository(getConnection(), { collectionName: freshName() }));

  async function setup() {
    const name = freshName();
    const repository = new MongoTenderRepository(getConnection(), { collectionName: name });
    const db: Db = await getConnection().getDatabase();
    return { repository, collection: db.collection(name) };
  }

  it("creates its indexes repeatably", async () => {
    const { repository, collection } = await setup();
    await repository.ensureIndexes();
    await repository.ensureIndexes();
    await new MongoTenderRepository(getConnection(), { collectionName: collection.collectionName }).ensureIndexes();

    const names = (await collection.indexes()).map((index) => index.name);
    expect(names).toEqual(expect.arrayContaining([TENDER_STATUS_DEADLINE_INDEX, TENDER_BROKER_INDEX]));
  });

  it("the database itself rejects a second document with the same _id", async () => {
    const { repository, collection } = await setup();
    const tender = await repository.create(makeTender());
    await expect(collection.insertOne({ _id: tender.tenderId as unknown as ObjectId })).rejects.toMatchObject({ code: 11000 });
  });

  it("stores the tenderId as _id, BSON dates, a numeric budget, arrays, and null for the publication date of a Draft", async () => {
    const { repository, collection } = await setup();
    const tender = await repository.create(makeTender({ estimatedBudget: 1234.5 }));

    const raw = await collection.findOne({ _id: tender.tenderId as unknown as ObjectId });
    expect(raw?._id).toBe(tender.tenderId);
    expect(raw?.submissionDeadline).toBeInstanceOf(Date);
    expect(raw?.createdAt).toBeInstanceOf(Date);
    expect(raw?.publicationDate).toBeNull();
    expect(raw?.estimatedBudget).toBe(1234.5);
    expect(Array.isArray(raw?.requirements)).toBe(true);
    expect(raw).not.toHaveProperty("tenderId");
  });

  it("loads a document whose _id is an ObjectId and returns the hex string as the domain id", async () => {
    const { repository, collection } = await setup();
    const oid = new ObjectId();
    await collection.insertOne({ ...toTenderDocument(makeTender({ tenderId: oid.toHexString() })), _id: oid } as never);

    expect((await repository.findAll()).map((tender) => tender.tenderId)).toContain(oid.toHexString());
  });

  it("reports a corrupt stored document as a safe repository error", async () => {
    const { repository, collection } = await setup();
    await collection.insertOne({ _id: "corrupt" as unknown as ObjectId, title: "Secret title", status: "Archived" });

    const error = await catchAsyncError(() => repository.findById("corrupt"));
    expect(error).toBeInstanceOf(TenderRepositoryException);
    expect(JSON.stringify((error as TenderRepositoryException).toSafeResponse())).not.toContain("Secret title");
  });

  it("two requests changing the status at the same moment: exactly one wins and the stored status is the winner's", async () => {
    const { repository } = await setup();
    const tender = await repository.create(makeTender());

    const results = await Promise.allSettled([
      repository.updateStatus(tender.tenderId, "Published", { publicationDate: TENDER_NOW, expectedStatus: "Draft" }),
      repository.updateStatus(tender.tenderId, "Cancelled", { expectedStatus: "Draft" }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidTenderStatusException);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    expect((await repository.findById(tender.tenderId))?.status).toBe(winner);
  });

  it("an edit and a cancel at the same moment never leave a changed Cancelled tender behind", async () => {
    const { repository } = await setup();
    const tender = await repository.create(makeTender());

    await Promise.allSettled([repository.update(tender.tenderId, { title: "Edited" }), repository.updateStatus(tender.tenderId, "Cancelled")]);

    const stored = await repository.findById(tender.tenderId);
    expect(stored?.status).toBe("Cancelled");
    // Either order is valid; what must not happen is a lost cancellation.
    expect(["Edited", tender.title]).toContain(stored?.title);
  });
});
