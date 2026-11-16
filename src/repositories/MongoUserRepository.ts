import type { Collection } from "mongodb";
import {
  AppError,
  DuplicateEmailException,
  UserNotFoundException,
  UserRepositoryException,
} from "@/entities/exceptions";
import type { User, UserStatus } from "@/entities/User";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type { UserRepositoryInterface, UserUpdateData } from "@/interfaces/repositories/UserRepositoryInterface";
import { describeDriverError, isDuplicateKeyOn } from "./mongoErrors";
import { toUser, toUserDocument, type UserDocument } from "./userDocumentMapper";

export const USERS_COLLECTION = "users";
/** Unique email index. Collation strength 2 makes it case-insensitive. */
export const USER_EMAIL_INDEX = "email_unique_ci";
const CASE_INSENSITIVE = { locale: "en", strength: 2 } as const;

export interface MongoRepositoryOptions {
  /** Defaults to the standard collection. Integration tests use a throwaway name. */
  collectionName?: string;
}

/**
 * ODD: repositories.MongoUserRepository, implementing UserRepositoryInterface.
 *
 * - Uses the shared MongoDBConnection; it never opens its own connection.
 * - Domain id == `_id`. Documents are mapped by userDocumentMapper, so MongoDB types stay here.
 * - Emails are stored lowercase (the User entity guarantees it) AND indexed with a
 *   case-insensitive collation, so uniqueness holds even for data written by other means.
 * - update() can only change fullName, email, passwordHash, roleId and status. userId and
 *   createdAt are never written after creation.
 * - Driver errors never reach callers: duplicate emails become DuplicateEmailException,
 *   everything else becomes UserRepositoryException (the original error is kept only as `cause`).
 *   Errors raised by MongoDBConnection (connection/configuration) pass through unchanged.
 * - Indexes are created on first use and are safe to repeat.
 */
export class MongoUserRepository implements UserRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? USERS_COLLECTION;
  }

  /** Creates the indexes if they are missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async create(user: User): Promise<User> {
    return this.#run(async (users) => {
      const document = toUserDocument(user);
      await users.insertOne(document);
      return toUser(document);
    });
  }

  async findById(userId: string): Promise<User | null> {
    return this.#run(async (users) => {
      const document = await users.findOne({ _id: userId });
      return document ? toUser(document) : null;
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.#run(async (users) => {
      const document = await users.findOne({ email: email.trim().toLowerCase() }, { collation: CASE_INSENSITIVE });
      return document ? toUser(document) : null;
    });
  }

  async update(userId: string, userData: UserUpdateData): Promise<User> {
    return this.#run(async (users) => {
      const current = await users.findOne({ _id: userId });
      if (!current) throw new UserNotFoundException();

      // Build the result through the entity first: it validates and normalizes every new value.
      const merged = toUser({
        ...current,
        fullName: userData.fullName ?? current.fullName,
        email: userData.email ?? current.email,
        passwordHash: userData.passwordHash ?? current.passwordHash,
        roleId: userData.roleId ?? current.roleId,
        status: userData.status ?? current.status,
      });

      // Only the fields the caller asked to change, and only mutable ones, are written.
      const changes: Partial<Pick<UserDocument, "fullName" | "email" | "passwordHash" | "roleId" | "status">> = {};
      if (userData.fullName !== undefined) changes.fullName = merged.fullName;
      if (userData.email !== undefined) changes.email = merged.email;
      if (userData.passwordHash !== undefined) changes.passwordHash = merged.passwordHash;
      if (userData.roleId !== undefined) changes.roleId = merged.roleId;
      if (userData.status !== undefined) changes.status = merged.status;
      if (Object.keys(changes).length === 0) return merged;

      const updated = await users.findOneAndUpdate({ _id: userId }, { $set: changes }, { returnDocument: "after" });
      if (!updated) throw new UserNotFoundException(); // deleted between the read and the write
      return toUser(updated);
    });
  }

  async delete(userId: string): Promise<void> {
    await this.#run(async (users) => {
      const result = await users.deleteOne({ _id: userId });
      if (result.deletedCount === 0) throw new UserNotFoundException();
    });
  }

  async findAll(): Promise<User[]> {
    return this.#run(async (users) => {
      const documents = await users.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
      return documents.map(toUser);
    });
  }

  async updateStatus(userId: string, status: UserStatus): Promise<User> {
    return this.update(userId, { status });
  }

  async #run<T>(operation: (users: Collection<UserDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const users = database.collection<UserDocument>(this.#collectionName);
      await this.#prepareIndexes(users);
      return await operation(users);
    } catch (error) {
      throw translate(error);
    }
  }

  #prepareIndexes(users: Collection<UserDocument>): Promise<void> {
    this.#indexes ??= users
      .createIndex({ email: 1 }, { unique: true, name: USER_EMAIL_INDEX, collation: CASE_INSENSITIVE })
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
  if (isDuplicateKeyOn(error, "email", USER_EMAIL_INDEX)) return new DuplicateEmailException({ cause: error });
  return new UserRepositoryException({ cause: error, details: describeDriverError(error) });
}
