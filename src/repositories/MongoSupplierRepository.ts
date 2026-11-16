import type { Collection, Filter } from "mongodb";
import {
  AppError,
  DatabaseOperationException,
  DuplicateRegistrationException,
  SupplierNotFoundException,
  SupplierRepositoryException,
  SupplierVerificationException,
} from "@/entities/exceptions";
import { normalizeSupplierQuery, registrationNumberKey, type Supplier, type VerificationStatus } from "@/entities/Supplier";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type {
  SupplierFilters,
  SupplierRepositoryInterface,
  SupplierUpdateData,
  SupplierVerificationChange,
} from "@/interfaces/repositories/SupplierRepositoryInterface";
import { applySupplierUpdate, applyVerificationChange } from "@/interfaces/repositories/supplierRepositoryRules";
import { describeDriverError } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";
import { toSupplier, toSupplierDocument, type SupplierDocument } from "./supplierDocumentMapper";

export const SUPPLIERS_COLLECTION = "suppliers";
export const SUPPLIER_REGISTRATION_INDEX = "registrationNumberKey_unique";
export const SUPPLIER_USER_INDEX = "userId_unique";
export const SUPPLIER_STATUS_INDEX = "verificationStatus_registrationDate";

const DUPLICATE_KEY_CODE = 11000;

/**
 * repositories.MongoSupplierRepository, implementing SupplierRepositoryInterface (ODD).
 *
 * Same conventions as the tender repository: shared MongoDBConnection, domain id == `_id`, mapping in
 * supplierDocumentMapper, safe errors (driver errors become SupplierRepositoryException / DatabaseOperationException,
 * the raw error is kept only as `cause`), idempotent indexes created on first use.
 *
 * Uniqueness: unique indexes on the normalized registration number and on userId are the real guard. create() and
 * update() also look first, so the normal case gives a clear DuplicateRegistrationException, and a race that slips through
 * is stopped by the index and translated to the same exception.
 *
 * Atomicity: each write is conditional on the verification status the supplier had when it was read, so a reviewer's
 * decision cannot be silently overwritten by a concurrent edit that resets it, or the reverse.
 */
export class MongoSupplierRepository implements SupplierRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? SUPPLIERS_COLLECTION;
  }

  /** Creates the indexes if they are missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async create(supplier: Supplier): Promise<Supplier> {
    return this.#run(async (suppliers) => {
      const document = toSupplierDocument(supplier);
      if (await suppliers.findOne({ registrationNumberKey: document.registrationNumberKey })) throw new DuplicateRegistrationException();
      if (await suppliers.findOne({ userId: document.userId })) throw new DuplicateRegistrationException();
      await suppliers.insertOne(document);
      return toSupplier(document);
    });
  }

  async findById(supplierId: string): Promise<Supplier | null> {
    return this.#run(async (suppliers) => {
      const document = await suppliers.findOne({ _id: supplierId });
      return document ? toSupplier(document) : null;
    });
  }

  async findByUserId(userId: string): Promise<Supplier | null> {
    return this.#run(async (suppliers) => {
      const document = await suppliers.findOne({ userId });
      return document ? toSupplier(document) : null;
    });
  }

  async findByRegistrationNumber(registrationNumber: string): Promise<Supplier | null> {
    return this.#run(async (suppliers) => {
      const document = await suppliers.findOne({ registrationNumberKey: registrationNumberKey(registrationNumber) });
      return document ? toSupplier(document) : null;
    });
  }

  async findByEmail(email: string): Promise<Supplier | null> {
    const wanted = email.trim().toLowerCase();
    return this.#run(async (suppliers) => {
      // Not indexed and not unique: contact emails are looked up rarely, so compare case-insensitively after reading.
      const documents = await suppliers.find({}).sort({ registrationDate: 1, _id: 1 }).toArray();
      const found = documents.find((document) => typeof document.email === "string" && document.email.toLowerCase() === wanted);
      return found ? toSupplier(found) : null;
    });
  }

  async findAll(filters: SupplierFilters = {}): Promise<Supplier[]> {
    const query = normalizeSupplierQuery(filters);
    return this.#run(async (suppliers) => {
      const filter: Filter<SupplierDocument> = {};
      if (query.statuses) filter.verificationStatus = { $in: query.statuses };

      const documents = await suppliers.find(filter).sort({ registrationDate: -1, _id: 1 }).skip(query.skip).limit(query.limit).toArray();
      return documents.map(toSupplier);
    });
  }

  async update(supplierId: string, supplierData: SupplierUpdateData): Promise<Supplier> {
    return this.#run(async (suppliers) => {
      const current = toSupplier(await this.#require(suppliers, supplierId));
      const next = applySupplierUpdate(current, supplierData);
      if (next === current) return current;

      const nextKey = registrationNumberKey(next.registrationNumber);
      if (nextKey !== registrationNumberKey(current.registrationNumber)) {
        const owner = await suppliers.findOne({ registrationNumberKey: nextKey });
        if (owner && owner._id !== supplierId) throw new DuplicateRegistrationException();
      }

      const updated = await suppliers.findOneAndUpdate(
        { _id: supplierId, verificationStatus: current.verificationStatus },
        {
          $set: {
            companyName: next.companyName,
            registrationNumber: next.registrationNumber,
            registrationNumberKey: nextKey,
            email: next.email,
            phoneNumber: next.phoneNumber,
            address: next.address,
            verificationStatus: next.verificationStatus,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(suppliers, supplierId, "update supplier");
      return toSupplier(updated);
    });
  }

  async updateVerificationStatus(
    supplierId: string,
    status: VerificationStatus,
    change: SupplierVerificationChange = {},
  ): Promise<Supplier> {
    return this.#run(async (suppliers) => {
      const current = toSupplier(await this.#require(suppliers, supplierId));
      const next = applyVerificationChange(current, status, change);

      const updated = await suppliers.findOneAndUpdate(
        { _id: supplierId, verificationStatus: current.verificationStatus },
        { $set: { verificationStatus: next.verificationStatus } },
        { returnDocument: "after" },
      );
      if (!updated) throw await this.#explainLostWrite(suppliers, supplierId, `set status to ${status}`);
      return toSupplier(updated);
    });
  }

  async #require(suppliers: Collection<SupplierDocument>, supplierId: string): Promise<SupplierDocument> {
    const document = await suppliers.findOne({ _id: supplierId });
    if (!document) throw new SupplierNotFoundException();
    return document;
  }

  /** A conditional write matched nothing: the supplier is gone, or another request changed its verification status in between. */
  async #explainLostWrite(suppliers: Collection<SupplierDocument>, supplierId: string, operation: string): Promise<AppError> {
    const latest = await suppliers.findOne({ _id: supplierId });
    if (!latest) return new SupplierNotFoundException();
    return new SupplierVerificationException(toSupplier(latest).verificationStatus, operation);
  }

  async #run<T>(operation: (suppliers: Collection<SupplierDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const suppliers = database.collection<SupplierDocument>(this.#collectionName);
      await this.#prepareIndexes(suppliers);
      return await operation(suppliers);
    } catch (error) {
      throw translate(error);
    }
  }

  #prepareIndexes(suppliers: Collection<SupplierDocument>): Promise<void> {
    this.#indexes ??= Promise.all([
      suppliers.createIndex({ registrationNumberKey: 1 }, { name: SUPPLIER_REGISTRATION_INDEX, unique: true }),
      suppliers.createIndex({ userId: 1 }, { name: SUPPLIER_USER_INDEX, unique: true }),
      suppliers.createIndex({ verificationStatus: 1, registrationDate: -1 }, { name: SUPPLIER_STATUS_INDEX }),
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
    // A clash on _id means the supplierId exists already (a bug in the caller); any other unique index means a duplicate registration.
    // The driver reports the violated index in keyPattern; without it the clash cannot be a unique-index race, so treat it as the id.
    const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    const onId = keyPattern ? "_id" in keyPattern : true;
    if (!onId) return new DuplicateRegistrationException({ cause: error, details: describeDriverError(error) });
    return new SupplierRepositoryException({ cause: error, details: { reason: "duplicate supplierId", ...describeDriverError(error) } });
  }
  return new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
}
