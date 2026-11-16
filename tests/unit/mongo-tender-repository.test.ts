import { describe, expect, it } from "vitest";
import {
  DatabaseOperationException,
  InvalidTenderStatusException,
  TenderNotFoundException,
  TenderRepositoryException,
} from "@/entities/exceptions";
import { MongoTenderRepository, TENDER_BROKER_INDEX, TENDER_STATUS_DEADLINE_INDEX } from "@/repositories/MongoTenderRepository";
import { toTender, toTenderDocument } from "@/repositories/tenderDocumentMapper";
import { catchAsyncError, makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { fakeConnection, FakeMongoCollection } from "../support/fakeMongoCollection";
import { runTenderRepositoryContract } from "../support/tenderRepositoryContract";

/**
 * These tests run MongoTenderRepository's own code against a minimal fake collection (tests/support/fakeMongoCollection.ts).
 * They check the repository's logic, not MongoDB. The real-database versions are in tests/integration/mongo-repositories.test.ts
 * and are skipped when no MongoDB is available.
 */

runTenderRepositoryContract("MongoTenderRepository (fake collection)", () => new MongoTenderRepository(fakeConnection(new FakeMongoCollection())));

function setup() {
  const collection = new FakeMongoCollection();
  return { collection, repository: new MongoTenderRepository(fakeConnection(collection)) };
}

describe("MongoTenderRepository (fake collection): specifics", () => {
  it("creates its two indexes once, even when used many times", async () => {
    const { collection, repository } = setup();
    await repository.ensureIndexes();
    await repository.create(makeTender());
    await repository.findAll();

    expect(collection.indexes.map((index) => index.name)).toEqual([TENDER_STATUS_DEADLINE_INDEX, TENDER_BROKER_INDEX]);
  });

  it("stores the tenderId as _id, dates as Date, the lists as arrays and no publication date for a Draft", async () => {
    const { collection, repository } = setup();
    const tender = await repository.create(makeTender());

    const raw = collection.documents.get(tender.tenderId)!;
    expect(raw._id).toBe(tender.tenderId);
    expect(raw.submissionDeadline).toBeInstanceOf(Date);
    expect(raw.createdAt).toBeInstanceOf(Date);
    expect(raw.publicationDate).toBeNull();
    expect(raw.requirements).toEqual(tender.requirements);
    expect(raw).not.toHaveProperty("tenderId");
  });

  it("reads back a document that has no publicationDate field at all", async () => {
    const { collection, repository } = setup();
    const tender = makeTender();
    const document = { ...toTenderDocument(tender) } as Record<string, unknown>;
    delete document.publicationDate;
    collection.documents.set(tender.tenderId, document as never);

    expect((await repository.findById(tender.tenderId))?.publicationDate).toBeNull();
  });

  it("reports a corrupt stored document as a safe TenderRepositoryException", async () => {
    const { collection, repository } = setup();
    collection.documents.set("corrupt", { _id: "corrupt", title: "Secret title", status: "Archived" } as never);

    const error = await catchAsyncError(() => repository.findById("corrupt"));
    expect(error).toBeInstanceOf(TenderRepositoryException);
    expect(JSON.stringify((error as TenderRepositoryException).toSafeResponse())).not.toContain("Secret title");
  });

  it("a stored tender that is inconsistent (Published without a date) is also a storage problem", () => {
    const document = { ...toTenderDocument(makeTender()), status: "Published" as const };
    expect(() => toTender(document)).toThrow(TenderRepositoryException);
  });

  it("turns a driver failure into DatabaseOperationException without leaking its message", async () => {
    const { collection, repository } = setup();
    const stored = await repository.create(makeTender());
    collection.failWith = Object.assign(new Error("connect to mongodb://admin:hunter2@db.internal failed"), { code: 6 });

    for (const action of [
      () => repository.findById(stored.tenderId),
      () => repository.findAll(),
      () => repository.findOpenTenders(),
      () => repository.update(stored.tenderId, { title: "x" }),
      () => repository.updateStatus(stored.tenderId, "Cancelled"),
      () => repository.delete(stored.tenderId),
      () => repository.create(makeTender()),
    ]) {
      const error = await catchAsyncError(action);
      expect(error).toBeInstanceOf(DatabaseOperationException);
      expect(JSON.stringify((error as DatabaseOperationException).toSafeResponse())).not.toContain("hunter2");
    }
  });

  it("a driver failure while creating indexes is reported, and the next call tries again", async () => {
    const { collection, repository } = setup();
    collection.failWith = new Error("index build failed");
    expect(await catchAsyncError(() => repository.findAll())).toBeInstanceOf(DatabaseOperationException);

    collection.failWith = null;
    expect(await repository.findAll()).toEqual([]);
    expect(collection.indexes).toHaveLength(2);
  });

  describe("concurrent changes: a write that loses a race never overwrites", () => {
    /** Changes the stored tender after the repository has read it and before it writes. */
    function changeBeforeWrite(collection: FakeMongoCollection, tenderId: string, change: Record<string, unknown> | "remove") {
      collection.beforeNextWrite = () => {
        if (change === "remove") collection.documents.delete(tenderId);
        else collection.documents.set(tenderId, { ...collection.documents.get(tenderId)!, ...change });
      };
    }

    it("update() of a tender that was cancelled in between reports the new status and writes nothing", async () => {
      const { collection, repository } = setup();
      const tender = await repository.create(makeTender());
      changeBeforeWrite(collection, tender.tenderId, { status: "Cancelled" });

      const error = await catchAsyncError(() => repository.update(tender.tenderId, { title: "Too late" }));
      expect(error).toBeInstanceOf(InvalidTenderStatusException);
      expect(collection.documents.get(tender.tenderId)?.title).toBe(tender.title);
      expect(collection.documents.get(tender.tenderId)?.status).toBe("Cancelled");
    });

    it("two status changes at once: the loser gets InvalidTenderStatusException and the winner's result stays", async () => {
      const { collection, repository } = setup();
      const tender = await repository.create(makeTender());
      changeBeforeWrite(collection, tender.tenderId, { status: "Cancelled" });

      const error = await catchAsyncError(() => repository.updateStatus(tender.tenderId, "Published", { publicationDate: TENDER_NOW }));
      expect(error).toBeInstanceOf(InvalidTenderStatusException);
      expect(collection.documents.get(tender.tenderId)?.status).toBe("Cancelled");
      expect(collection.documents.get(tender.tenderId)?.publicationDate).toBeNull();
    });

    it("a tender deleted in between is reported as not found, for update, updateStatus and delete", async () => {
      for (const action of [
        (repository: MongoTenderRepository, id: string) => repository.update(id, { title: "x" }),
        (repository: MongoTenderRepository, id: string) => repository.updateStatus(id, "Cancelled"),
        (repository: MongoTenderRepository, id: string) => repository.delete(id),
      ]) {
        const { collection, repository } = setup();
        const tender = await repository.create(makeTender());
        changeBeforeWrite(collection, tender.tenderId, "remove");
        expect(await catchAsyncError(() => action(repository, tender.tenderId))).toBeInstanceOf(TenderNotFoundException);
      }
    });

    it("delete() never removes a tender that was published in between", async () => {
      const { collection, repository } = setup();
      const tender = await repository.create(makeTender());
      changeBeforeWrite(collection, tender.tenderId, { status: "Published", publicationDate: TENDER_NOW });

      expect(await catchAsyncError(() => repository.delete(tender.tenderId))).toBeInstanceOf(InvalidTenderStatusException);
      expect(collection.documents.has(tender.tenderId)).toBe(true);
    });
  });

  it("mapper round trip keeps every field", () => {
    const tender = makeTender();
    const document = toTenderDocument(tender);
    expect(toTender(document).toJSON()).toEqual(tender.toJSON());
    expect(document.submissionDeadline).toEqual(TENDER_DEADLINE);
  });
});
