import type { Collection, Filter } from "mongodb";
import { normalizeEvaluationQuery, type Evaluation, type EvaluationQueryInput, type EvaluationStatus } from "@/entities/Evaluation";
import { AppError, DatabaseOperationException, EvaluationNotFoundException, EvaluationRepositoryException } from "@/entities/exceptions";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type { EvaluationRepositoryInterface, EvaluationWriteCondition } from "@/interfaces/repositories/EvaluationRepositoryInterface";
import { applyEvaluationStatusChange, assertWritable } from "@/interfaces/repositories/evaluationRepositoryRules";
import { toEvaluation, toEvaluationDocument, type EvaluationDocument } from "./evaluationDocumentMapper";
import { describeDriverError } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";

export const EVALUATIONS_COLLECTION = "evaluations";
export const EVALUATION_BID_INDEX = "bidId_evaluationDate";
export const EVALUATION_TENDER_INDEX = "tenderId_evaluationStatus_evaluationDate";
export const EVALUATION_EVALUATOR_INDEX = "evaluatorId_evaluationDate";

/**
 * repositories.MongoEvaluationRepository, implementing EvaluationRepositoryInterface (ODD). Same conventions as MongoBidRepository:
 * `_id` is the domain id, mapping in evaluationDocumentMapper, safe errors, idempotent indexes on first use. Writes are conditional
 * on the status read (and `expectedStatus` when given), so a completed evaluation is never changed and two competing writes cannot both win.
 */
export class MongoEvaluationRepository implements EvaluationRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? EVALUATIONS_COLLECTION;
  }

  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  create(evaluation: Evaluation): Promise<Evaluation> {
    return this.#run(async (c) => {
      const document = toEvaluationDocument(evaluation);
      await c.insertOne(document);
      return toEvaluation(document);
    });
  }

  findById(evaluationId: string): Promise<Evaluation | null> {
    return this.#run(async (c) => {
      const document = await c.findOne({ _id: evaluationId });
      return document ? toEvaluation(document) : null;
    });
  }

  findByBidId(bidId: string, query?: EvaluationQueryInput) { return this.#list({ bidId }, query); }
  findByTenderId(tenderId: string, query?: EvaluationQueryInput) { return this.#list({ tenderId }, query); }
  findByEvaluatorId(evaluatorId: string, query?: EvaluationQueryInput) { return this.#list({ evaluatorId }, query); }
  findCompletedByTenderId(tenderId: string, query?: EvaluationQueryInput) { return this.#list({ tenderId, evaluationStatus: "Completed" }, query); }

  update(evaluation: Evaluation, condition: EvaluationWriteCondition = {}): Promise<Evaluation> {
    return this.#run(async (c) => {
      const stored = toEvaluation(await this.#require(c, evaluation.evaluationId));
      assertWritable(stored, condition);
      const { _id, ...changes } = toEvaluationDocument(evaluation);
      void _id;
      return this.#conditionalWrite(c, stored, changes);
    });
  }

  updateStatus(evaluationId: string, status: EvaluationStatus, condition: EvaluationWriteCondition = {}): Promise<Evaluation> {
    return this.#run(async (c) => {
      const stored = toEvaluation(await this.#require(c, evaluationId));
      const next = applyEvaluationStatusChange(stored, status, condition);
      const { _id, ...changes } = toEvaluationDocument(next);
      void _id;
      return this.#conditionalWrite(c, stored, changes);
    });
  }

  async #conditionalWrite(c: Collection<EvaluationDocument>, stored: Evaluation, changes: Omit<EvaluationDocument, "_id">): Promise<Evaluation> {
    const updated = await c.findOneAndUpdate({ _id: stored.evaluationId, evaluationStatus: stored.evaluationStatus }, { $set: changes }, { returnDocument: "after" });
    if (!updated) {
      const latest = await c.findOne({ _id: stored.evaluationId });
      if (!latest) throw new EvaluationNotFoundException();
      throw new EvaluationRepositoryException({ details: { reason: "the evaluation was changed by another request" } });
    }
    return toEvaluation(updated);
  }

  async #list(base: Filter<EvaluationDocument>, input?: EvaluationQueryInput): Promise<Evaluation[]> {
    const { limit, skip } = normalizeEvaluationQuery(input);
    return this.#run(async (c) => (await c.find(base).sort({ evaluationDate: -1, _id: 1 }).skip(skip).limit(limit).toArray()).map(toEvaluation));
  }

  async #require(c: Collection<EvaluationDocument>, id: string): Promise<EvaluationDocument> {
    const document = await c.findOne({ _id: id });
    if (!document) throw new EvaluationNotFoundException();
    return document;
  }

  async #run<T>(operation: (c: Collection<EvaluationDocument>) => Promise<T>): Promise<T> {
    try {
      const collection = (await this.#connection.getDatabase()).collection<EvaluationDocument>(this.#collectionName);
      this.#indexes ??= Promise.all([
        collection.createIndex({ bidId: 1, evaluationDate: -1 }, { name: EVALUATION_BID_INDEX }),
        collection.createIndex({ tenderId: 1, evaluationStatus: 1, evaluationDate: -1 }, { name: EVALUATION_TENDER_INDEX }),
        collection.createIndex({ evaluatorId: 1, evaluationDate: -1 }, { name: EVALUATION_EVALUATOR_INDEX }),
      ])
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#indexes = null;
          throw error;
        });
      await this.#indexes;
      return await operation(collection);
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if ((error as { code?: unknown } | null)?.code === 11000) return new EvaluationRepositoryException({ cause: error, details: { reason: "duplicate evaluationId", ...describeDriverError(error) } });
  return new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
}
