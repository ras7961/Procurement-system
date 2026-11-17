import type { Collection, Filter } from "mongodb";
import { normalizeBidQuery, type Bid, type BidStatus } from "@/entities/Bid";
import {
  AppError,
  BidNotFoundException,
  BidRepositoryException,
  BidSubmissionException,
  DatabaseOperationException,
  DuplicateBidException,
} from "@/entities/exceptions";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type {
  BidFilters,
  BidRepositoryInterface,
  BidUpdateData,
  BidWriteCondition,
} from "@/interfaces/repositories/BidRepositoryInterface";
import { applyBidStatusChange, applyBidUpdate } from "@/interfaces/repositories/bidRepositoryRules";
import { toBid, toBidDocument, type BidDocument } from "./bidDocumentMapper";
import { describeDriverError } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";

export const BIDS_COLLECTION = "bids";
export const BID_TENDER_SUPPLIER_INDEX = "tenderId_supplierId_unique";
export const BID_SUPPLIER_INDEX = "supplierId_submissionDate";
export const BID_TENDER_INDEX = "tenderId_status_submissionDate";

const DUPLICATE_KEY_CODE = 11000;

/**
 * repositories.MongoBidRepository, implementing BidRepositoryInterface (ODD).
 *
 * Same conventions as the supplier and tender repositories: shared MongoDBConnection, domain id == `_id`, mapping in
 * bidDocumentMapper, safe errors (driver errors become BidRepositoryException / DatabaseOperationException, the raw error
 * is kept only as `cause`), idempotent indexes created on first use.
 *
 * One bid per supplier per tender: a UNIQUE index on (tenderId, supplierId) is the real guard. create() also looks first,
 * so the normal case gives a clear DuplicateBidException, and a race that slips through is stopped by the index and
 * translated to the same exception. Nothing is stored when two requests race: exactly one insert succeeds.
 *
 * Atomicity: update() and updateStatus() are conditional on the status the bid had when it was read (and, when the caller
 * names one, on `expectedStatus`), so a withdrawal and an update, or two withdrawals, cannot both succeed.
 */
export class MongoBidRepository implements BidRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? BIDS_COLLECTION;
  }

  /** Creates the indexes if they are missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async create(bid: Bid): Promise<Bid> {
    return this.#run(async (bids) => {
      const document = toBidDocument(bid);
      if (await bids.findOne({ tenderId: document.tenderId, supplierId: document.supplierId })) throw new DuplicateBidException();
      await bids.insertOne(document);
      return toBid(document);
    });
  }

  async findById(bidId: string): Promise<Bid | null> {
    return this.#run(async (bids) => {
      const document = await bids.findOne({ _id: bidId });
      return document ? toBid(document) : null;
    });
  }

  async findByTenderId(tenderId: string, filters: BidFilters = {}): Promise<Bid[]> {
    return this.#list({ tenderId }, { ...filters, tenderId: undefined });
  }

  async findBySupplierId(supplierId: string, filters: BidFilters = {}): Promise<Bid[]> {
    return this.#list({ supplierId }, filters);
  }

  async existsBySupplierAndTender(supplierId: string, tenderId: string): Promise<boolean> {
    return this.#run(async (bids) => (await bids.findOne({ supplierId, tenderId })) !== null);
  }

  async update(bidId: string, bidData: BidUpdateData, condition: BidWriteCondition = {}): Promise<Bid> {
    return this.#run(async (bids) => {
      const current = toBid(await this.#require(bids, bidId));
      const next = applyBidUpdate(current, bidData, condition);
      if (next === current) return current;

      const updated = await bids.findOneAndUpdate(
        { _id: bidId, status: current.status },
        {
          $set: {
            technicalProposal: next.technicalProposal,
            financialProposal: next.financialProposal,
            supportingDocuments: next.supportingDocuments,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(bids, bidId);
      return toBid(updated);
    });
  }

  async updateStatus(bidId: string, status: BidStatus, condition: BidWriteCondition = {}): Promise<Bid> {
    return this.#run(async (bids) => {
      const current = toBid(await this.#require(bids, bidId));
      const next = applyBidStatusChange(current, status, condition);

      const updated = await bids.findOneAndUpdate(
        { _id: bidId, status: current.status },
        { $set: { status: next.status } },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(bids, bidId);
      return toBid(updated);
    });
  }

  async #list(base: Filter<BidDocument>, filters: BidFilters): Promise<Bid[]> {
    const query = normalizeBidQuery(filters);
    return this.#run(async (bids) => {
      const filter: Filter<BidDocument> = { ...base };
      if (query.statuses) filter.status = { $in: query.statuses };
      if (query.tenderId) filter.tenderId = query.tenderId;

      const documents = await bids.find(filter).sort({ submissionDate: -1, _id: 1 }).skip(query.skip).limit(query.limit).toArray();
      return documents.map(toBid);
    });
  }

  async #require(bids: Collection<BidDocument>, bidId: string): Promise<BidDocument> {
    const document = await bids.findOne({ _id: bidId });
    if (!document) throw new BidNotFoundException();
    return document;
  }

  /** A conditional write matched nothing: the bid is gone, or another request changed its status in between. */
  async #explainLostWrite(bids: Collection<BidDocument>, bidId: string): Promise<AppError> {
    const latest = await bids.findOne({ _id: bidId });
    if (!latest) return new BidNotFoundException();
    return new BidSubmissionException(`the bid was changed by another request and is now ${toBid(latest).status}`);
  }

  async #run<T>(operation: (bids: Collection<BidDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const bids = database.collection<BidDocument>(this.#collectionName);
      await this.#prepareIndexes(bids);
      return await operation(bids);
    } catch (error) {
      throw translate(error);
    }
  }

  #prepareIndexes(bids: Collection<BidDocument>): Promise<void> {
    this.#indexes ??= Promise.all([
      bids.createIndex({ tenderId: 1, supplierId: 1 }, { name: BID_TENDER_SUPPLIER_INDEX, unique: true }),
      bids.createIndex({ supplierId: 1, submissionDate: -1 }, { name: BID_SUPPLIER_INDEX }),
      bids.createIndex({ tenderId: 1, status: 1, submissionDate: -1 }, { name: BID_TENDER_INDEX }),
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
    // A clash on _id means the bidId exists already (a bug in the caller); a clash on the (tenderId, supplierId) index is a duplicate bid.
    // Without keyPattern the clash cannot be attributed to the unique index, so treat it as the id.
    const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    const onId = keyPattern ? "_id" in keyPattern : true;
    if (!onId) return new DuplicateBidException({ cause: error, details: describeDriverError(error) });
    return new BidRepositoryException({ cause: error, details: { reason: "duplicate bidId", ...describeDriverError(error) } });
  }
  return new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
}
