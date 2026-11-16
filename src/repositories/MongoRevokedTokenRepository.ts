import type { Collection } from "mongodb";
import { AppError, DatabaseOperationException } from "@/entities/exceptions";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type { RevokedTokenRepositoryInterface } from "@/interfaces/repositories/RevokedTokenRepositoryInterface";
import { describeDriverError, isDuplicateKeyOn } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";

export const REVOKED_TOKENS_COLLECTION = "revoked_tokens";
export const REVOKED_TOKEN_TTL_INDEX = "expiresAt_ttl";

/** A revocation record. `_id` is the token's `jti`; the raw token is never stored. */
export interface RevokedTokenDocument {
  _id: string;
  expiresAt: Date;
  revokedAt: Date;
}

/**
 * repositories.MongoRevokedTokenRepository, implementing RevokedTokenRepositoryInterface.
 *
 * - Collection `revoked_tokens`, shared MongoDBConnection, `_id` = token id (jti). Using the id as
 *   `_id` makes duplicates impossible and revocation idempotent.
 * - TTL index `expiresAt_ttl` (expireAfterSeconds: 0): MongoDB deletes a record shortly after its
 *   `expiresAt` (its background task runs about once a minute). That is safe because a token past
 *   its expiry is rejected by the token service regardless of this collection.
 * - Errors: AppErrors (for example connection errors) pass through; anything else becomes
 *   DatabaseOperationException with the driver error kept only as `cause`.
 */
export class MongoRevokedTokenRepository implements RevokedTokenRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  readonly #now: () => Date;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions & { now?: () => Date } = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? REVOKED_TOKENS_COLLECTION;
    this.#now = options.now ?? (() => new Date());
  }

  /** Creates the TTL index if it is missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async revoke(tokenId: string, expiresAt: Date): Promise<void> {
    if (typeof tokenId !== "string" || tokenId === "" || !(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new DatabaseOperationException({ details: { reason: "invalid revocation record" } });
    }
    await this.#run(async (tokens) => {
      try {
        await tokens.updateOne({ _id: tokenId }, { $setOnInsert: { expiresAt, revokedAt: this.#now() } }, { upsert: true });
      } catch (error) {
        // Two requests revoking the same token at once: one loses the upsert race. The token is revoked either way.
        if (!isDuplicateKeyOn(error, "_id", "_id_")) throw error;
      }
    });
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    if (typeof tokenId !== "string" || tokenId === "") {
      throw new DatabaseOperationException({ details: { reason: "invalid token id" } });
    }
    return this.#run(async (tokens) => (await tokens.findOne({ _id: tokenId }, { projection: { _id: 1 } })) !== null);
  }

  async #run<T>(operation: (tokens: Collection<RevokedTokenDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const tokens = database.collection<RevokedTokenDocument>(this.#collectionName);
      await this.#prepareIndexes(tokens);
      return await operation(tokens);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
    }
  }

  #prepareIndexes(tokens: Collection<RevokedTokenDocument>): Promise<void> {
    this.#indexes ??= tokens
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: REVOKED_TOKEN_TTL_INDEX })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#indexes = null; // allow a retry on the next call
        throw error;
      });
    return this.#indexes;
  }
}
