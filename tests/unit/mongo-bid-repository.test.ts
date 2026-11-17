import { describe, expect, it } from "vitest";
import {
  BidNotFoundException,
  BidRepositoryException,
  BidSubmissionException,
  DatabaseOperationException,
  DuplicateBidException,
} from "@/entities/exceptions";
import { toBid, toBidDocument } from "@/repositories/bidDocumentMapper";
import { BID_SUPPLIER_INDEX, BID_TENDER_INDEX, BID_TENDER_SUPPLIER_INDEX, MongoBidRepository } from "@/repositories/MongoBidRepository";
import { catchAsyncError, makeBid } from "../support/fixtures";
import { fakeConnection, FakeMongoCollection } from "../support/fakeMongoCollection";
import { InMemoryBidRepository } from "../support/InMemoryBidRepository";
import { runBidRepositoryContract } from "../support/bidRepositoryContract";

/**
 * The in-memory double and MongoBidRepository's own code (run against a minimal fake collection that enforces unique
 * indexes) must both satisfy the same contract. The fake proves the repository's logic, not MongoDB: the real-database
 * version is tests/integration/mongo-bid-repository.test.ts and is skipped when no MongoDB is available.
 */
runBidRepositoryContract("InMemoryBidRepository", () => new InMemoryBidRepository());
runBidRepositoryContract("MongoBidRepository (fake collection)", () => new MongoBidRepository(fakeConnection(new FakeMongoCollection())));

function setup() {
  const collection = new FakeMongoCollection();
  return { collection, repository: new MongoBidRepository(fakeConnection(collection)) };
}

describe("MongoBidRepository (fake collection)", () => {
  it("creates the indexes on first use: a UNIQUE one on (tenderId, supplierId) plus two for listing", async () => {
    const { collection, repository } = setup();
    await repository.findById("x");
    const byName = new Map(collection.indexes.map((index) => [index.name, index]));
    expect(byName.get(BID_TENDER_SUPPLIER_INDEX)).toMatchObject({ spec: { tenderId: 1, supplierId: 1 }, unique: true });
    expect(byName.get(BID_SUPPLIER_INDEX)?.unique).toBeUndefined();
    expect(byName.get(BID_TENDER_INDEX)?.unique).toBeUndefined();
    await repository.findById("y");
    expect(collection.indexes).toHaveLength(3); // created once, not per call
  });

  it("stores the domain bidId as _id and document references as plain ids", async () => {
    const { collection, repository } = setup();
    const bid = await repository.create(makeBid({ supportingDocuments: ["d1", "d2"] }));
    expect(collection.documents.get(bid.bidId)).toMatchObject({ _id: bid.bidId, supportingDocuments: ["d1", "d2"], status: "Submitted", financialProposal: 240000 });
  });

  it("round-trips through the mapper, and reads string dates", () => {
    const bid = makeBid();
    expect(toBid(toBidDocument(bid)).toJSON()).toEqual(bid.toJSON());
    expect(toBid({ ...toBidDocument(bid), submissionDate: bid.submissionDate.toISOString() }).bidId).toBe(bid.bidId);
  });

  it("a corrupt stored document becomes a safe BidRepositoryException that does not echo its content", async () => {
    const { collection, repository } = setup();
    collection.documents.set("bad", { _id: "bad", tenderId: "t", supplierId: "s", technicalProposal: "SECRET-OFFER", financialProposal: -1, supportingDocuments: [], submissionDate: new Date(), status: "Submitted", complianceStatus: "Compliant" });
    const error = await catchAsyncError(() => repository.findById("bad"));
    expect(error).toBeInstanceOf(BidRepositoryException);
    expect(JSON.stringify((error as BidRepositoryException).toSafeResponse())).not.toContain("SECRET-OFFER");
  });

  it("a driver failure becomes a safe DatabaseOperationException without the driver message", async () => {
    const { collection, repository } = setup();
    collection.failWith = new Error("connection string mongodb://user:secret@host failed");
    const error = await catchAsyncError(() => repository.findById("x"));
    expect(error).toBeInstanceOf(DatabaseOperationException);
    expect(JSON.stringify((error as DatabaseOperationException).toSafeResponse())).not.toContain("secret");
  });

  it("a unique-index race (E11000 on the tender/supplier keyPattern) becomes DuplicateBidException", async () => {
    const { collection, repository } = setup();
    collection.failWith = Object.assign(new Error("E11000 duplicate key error"), { code: 11000, keyPattern: { tenderId: 1, supplierId: 1 } });
    expect(await catchAsyncError(() => repository.create(makeBid()))).toBeInstanceOf(DuplicateBidException);
  });

  it("a duplicate on _id (or an E11000 with no keyPattern) becomes BidRepositoryException", async () => {
    const { collection, repository } = setup();
    collection.failWith = Object.assign(new Error("E11000 duplicate key error"), { code: 11000, keyPattern: { _id: 1 } });
    expect(await catchAsyncError(() => repository.create(makeBid()))).toBeInstanceOf(BidRepositoryException);
    collection.failWith = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    expect(await catchAsyncError(() => repository.create(makeBid()))).toBeInstanceOf(BidRepositoryException);
  });

  it("a withdrawal made between the read and the write is not overwritten by an update", async () => {
    const { collection, repository } = setup();
    const bid = await repository.create(makeBid());
    collection.beforeNextWrite = () => {
      collection.documents.set(bid.bidId, { ...collection.documents.get(bid.bidId)!, status: "Withdrawn" });
    };
    const error = await catchAsyncError(() => repository.update(bid.bidId, { financialProposal: 1 }, { expectedStatus: "Submitted" }));
    expect(error).toBeInstanceOf(BidSubmissionException);
    expect(collection.documents.get(bid.bidId)?.financialProposal).toBe(240000);
  });

  it("an update or withdrawal of a bid deleted in between reports BidNotFoundException", async () => {
    const { collection, repository } = setup();
    const bid = await repository.create(makeBid());
    collection.beforeNextWrite = () => void collection.documents.delete(bid.bidId);
    expect(await catchAsyncError(() => repository.updateStatus(bid.bidId, "Withdrawn"))).toBeInstanceOf(BidNotFoundException);
  });
});
