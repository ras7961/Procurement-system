import { afterAll, describe, expect, it } from "vitest";
import { DuplicateBidException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { BID_SUPPLIER_INDEX, BID_TENDER_INDEX, BID_TENDER_SUPPLIER_INDEX, MongoBidRepository } from "@/repositories/MongoBidRepository";
import { makeBid } from "../support/fixtures";
import { runBidRepositoryContract } from "../support/bidRepositoryContract";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";

const target = await resolveMongoTestTarget();
console.info(`[integration] Mongo bid repository tests target: ${target ? target.source : "none (SKIPPED)"}`);

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
const freshName = () => `bids_${(counter += 1)}`;

afterAll(async () => {
  if (!target) return;
  if (connection) {
    await (await getConnection().getDatabase()).dropDatabase();
    await connection.closeConnection();
  }
  await target.stop();
});

describe.skipIf(!target)("MongoBidRepository against a real MongoDB", () => {
  runBidRepositoryContract("MongoBidRepository", () => new MongoBidRepository(getConnection(), { collectionName: freshName() }));

  it("creates its indexes repeatably, the tender+supplier one unique", async () => {
    const name = freshName();
    const repository = new MongoBidRepository(getConnection(), { collectionName: name });
    await repository.ensureIndexes();
    await repository.ensureIndexes();
    const indexes = await (await getConnection().getDatabase()).collection(name).indexes();
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([BID_TENDER_SUPPLIER_INDEX, BID_SUPPLIER_INDEX, BID_TENDER_INDEX]));
    expect(indexes.find((index) => index.name === BID_TENDER_SUPPLIER_INDEX)?.unique).toBe(true);
  });

  it("the database itself refuses a duplicate even from two repository instances racing", async () => {
    const name = freshName();
    const a = new MongoBidRepository(getConnection(), { collectionName: name });
    const b = new MongoBidRepository(getConnection(), { collectionName: name });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create(makeBid({ tenderId: "t-race", supplierId: "s-race" }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(DuplicateBidException);
    expect(await a.findByTenderId("t-race")).toHaveLength(1);
  });
});
