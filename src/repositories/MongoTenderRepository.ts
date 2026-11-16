import type { Collection, Filter } from "mongodb";
import {
  AppError,
  DatabaseOperationException,
  InvalidTenderStatusException,
  TenderNotFoundException,
  TenderRepositoryException,
} from "@/entities/exceptions";
import { DELETABLE_TENDER_STATUSES, normalizeTenderQuery, type Tender, type TenderStatus } from "@/entities/Tender";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type {
  OpenTenderCriteria,
  TenderFilters,
  TenderRepositoryInterface,
  TenderStatusChange,
  TenderUpdateData,
} from "@/interfaces/repositories/TenderRepositoryInterface";
import {
  applyTenderStatusChange,
  applyTenderUpdate,
  resolveReferenceDate,
} from "@/interfaces/repositories/tenderRepositoryRules";
import { describeDriverError } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";
import { toTender, toTenderDocument, type TenderDocument } from "./tenderDocumentMapper";

export const TENDERS_COLLECTION = "tenders";
export const TENDER_STATUS_DEADLINE_INDEX = "status_submissionDeadline";
export const TENDER_BROKER_INDEX = "brokerId_createdAt";

const DUPLICATE_KEY_CODE = 11000;

/**
 * repositories.MongoTenderRepository, implementing TenderRepositoryInterface (ODD).
 *
 * Same conventions as the user and role repositories: shared MongoDBConnection, domain id == `_id`, mapping in
 * tenderDocumentMapper, safe errors (driver errors become TenderRepositoryException / DatabaseOperationException,
 * the raw error is kept only as `cause`), idempotent indexes created on first use.
 *
 * What is validated and how: the rules of update() and updateStatus() live in tenderRepositoryRules.ts and are
 * shared with every other implementation. This class adds atomicity: each write is conditional on the status the
 * tender had when it was read, so a concurrent publish, cancel or edit cannot be silently overwritten
 * (the loser gets InvalidTenderStatusException, or TenderNotFoundException if the tender was deleted).
 */
export class MongoTenderRepository implements TenderRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? TENDERS_COLLECTION;
  }

  /** Creates the indexes if they are missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async create(tender: Tender): Promise<Tender> {
    return this.#run(async (tenders) => {
      const document = toTenderDocument(tender);
      await tenders.insertOne(document);
      return toTender(document);
    });
  }

  async findById(tenderId: string): Promise<Tender | null> {
    return this.#run(async (tenders) => {
      const document = await tenders.findOne({ _id: tenderId });
      return document ? toTender(document) : null;
    });
  }

  async findAll(filters: TenderFilters = {}): Promise<Tender[]> {
    const query = normalizeTenderQuery(filters);
    return this.#run(async (tenders) => {
      const filter: Filter<TenderDocument> = {};
      if (query.statuses) filter.status = { $in: query.statuses };
      if (query.brokerId) filter.brokerId = query.brokerId;
      if (query.category) filter.category = query.category;

      const documents = await tenders.find(filter).sort({ createdAt: -1, _id: 1 }).skip(query.skip).limit(query.limit).toArray();
      return documents.map(toTender);
    });
  }

  async findOpenTenders(criteria: OpenTenderCriteria = {}): Promise<Tender[]> {
    const query = normalizeTenderQuery({ category: criteria.category, limit: criteria.limit, skip: criteria.skip });
    const referenceDate = resolveReferenceDate(criteria);
    return this.#run(async (tenders) => {
      const filter: Filter<TenderDocument> = { status: "Published", submissionDeadline: { $gt: referenceDate } };
      if (query.category) filter.category = query.category;

      const documents = await tenders.find(filter).sort({ submissionDeadline: 1, _id: 1 }).skip(query.skip).limit(query.limit).toArray();
      return documents.map(toTender);
    });
  }

  async update(tenderId: string, tenderData: TenderUpdateData): Promise<Tender> {
    return this.#run(async (tenders) => {
      const current = toTender(await this.#require(tenders, tenderId));
      const next = applyTenderUpdate(current, tenderData);
      if (next === current) return current;

      const updated = await tenders.findOneAndUpdate(
        { _id: tenderId, status: current.status },
        {
          $set: {
            title: next.title,
            description: next.description,
            category: next.category,
            estimatedBudget: next.estimatedBudget,
            requirements: next.requirements,
            evaluationCriteria: next.evaluationCriteria,
            submissionDeadline: next.submissionDeadline,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(tenders, tenderId, "update tender");
      return toTender(updated);
    });
  }

  async updateStatus(tenderId: string, status: TenderStatus, change: TenderStatusChange = {}): Promise<Tender> {
    return this.#run(async (tenders) => {
      const current = toTender(await this.#require(tenders, tenderId));
      const next = applyTenderStatusChange(current, status, change);
      if (next === current) return current;

      const updated = await tenders.findOneAndUpdate(
        { _id: tenderId, status: current.status },
        { $set: { status: next.status, publicationDate: next.publicationDate } },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(tenders, tenderId, `change status to ${status}`);
      return toTender(updated);
    });
  }

  async delete(tenderId: string): Promise<void> {
    return this.#run(async (tenders) => {
      toTender(await this.#require(tenders, tenderId)).assertDeletable();

      const result = await tenders.deleteOne({ _id: tenderId, status: { $in: [...DELETABLE_TENDER_STATUSES] } });
      if (result.deletedCount === 0) throw await this.#explainLostWrite(tenders, tenderId, "delete");
    });
  }

  async #require(tenders: Collection<TenderDocument>, tenderId: string): Promise<TenderDocument> {
    const document = await tenders.findOne({ _id: tenderId });
    if (!document) throw new TenderNotFoundException();
    return document;
  }

  /** A conditional write matched nothing: the tender was deleted, or another request changed its status in between. */
  async #explainLostWrite(tenders: Collection<TenderDocument>, tenderId: string, operation: string): Promise<AppError> {
    const latest = await tenders.findOne({ _id: tenderId });
    if (!latest) return new TenderNotFoundException();
    return new InvalidTenderStatusException(toTender(latest).status, operation);
  }

  async #run<T>(operation: (tenders: Collection<TenderDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const tenders = database.collection<TenderDocument>(this.#collectionName);
      await this.#prepareIndexes(tenders);
      return await operation(tenders);
    } catch (error) {
      throw translate(error);
    }
  }

  #prepareIndexes(tenders: Collection<TenderDocument>): Promise<void> {
    this.#indexes ??= Promise.all([
      tenders.createIndex({ status: 1, submissionDeadline: 1 }, { name: TENDER_STATUS_DEADLINE_INDEX }),
      tenders.createIndex({ brokerId: 1, createdAt: -1 }, { name: TENDER_BROKER_INDEX }),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#indexes = null; // allow a retry on the next call
        throw error;
      });
    return this.#indexes;
  }
}

function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if ((error as { code?: unknown } | null)?.code === DUPLICATE_KEY_CODE) {
    return new TenderRepositoryException({ cause: error, details: { reason: "duplicate tenderId", ...describeDriverError(error) } });
  }
  return new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
}
