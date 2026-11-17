import { describe, expect, it } from "vitest";
import { EvaluationRepositoryException } from "@/entities/exceptions";
import { toEvaluation, toEvaluationDocument } from "@/repositories/evaluationDocumentMapper";
import { EVALUATION_BID_INDEX, EVALUATION_EVALUATOR_INDEX, EVALUATION_TENDER_INDEX, MongoEvaluationRepository } from "@/repositories/MongoEvaluationRepository";
import { catchAsyncError } from "../support/fixtures";
import { fakeConnection, FakeMongoCollection } from "../support/fakeMongoCollection";
import { InMemoryEvaluationRepository } from "../support/InMemoryEvaluationRepository";
import { makeEvaluation, runEvaluationRepositoryContract } from "../support/evaluationRepositoryContract";

runEvaluationRepositoryContract("InMemoryEvaluationRepository", () => new InMemoryEvaluationRepository());
runEvaluationRepositoryContract("MongoEvaluationRepository (fake collection)", () => new MongoEvaluationRepository(fakeConnection(new FakeMongoCollection())));

describe("MongoEvaluationRepository mapping", () => {
  it("round-trips through the stored document with the domain id as _id", () => {
    const e = makeEvaluation();
    const doc = toEvaluationDocument(e);
    expect(doc._id).toBe(e.evaluationId);
    expect(toEvaluation(doc).toJSON()).toEqual(e.toJSON());
  });

  it("a corrupt stored document becomes a safe EvaluationRepositoryException", async () => {
    const doc = { ...toEvaluationDocument(makeEvaluation()), technicalScore: -5 };
    const error = await catchAsyncError(async () => toEvaluation(doc));
    expect(error).toBeInstanceOf(EvaluationRepositoryException);
    expect(String(error.message)).not.toContain("-5");
  });

  it("creates its indexes on first use", async () => {
    const collection = new FakeMongoCollection();
    await new MongoEvaluationRepository(fakeConnection(collection)).ensureIndexes();
    const names = collection.indexes.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining([EVALUATION_BID_INDEX, EVALUATION_TENDER_INDEX, EVALUATION_EVALUATOR_INDEX]));
  });
});
