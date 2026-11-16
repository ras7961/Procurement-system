import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";

type Doc = Record<string, unknown> & { _id: unknown };

/**
 * A tiny in-memory stand-in for a MongoDB collection. It supports ONLY what MongoTenderRepository uses:
 * createIndex, insertOne, findOne, find().sort().skip().limit().toArray(), findOneAndUpdate with $set, deleteOne,
 * and the filters equality, $in and $gt. It lets the repository's own code (mapping, conditional writes, error
 * translation) run without a server. It proves nothing about real MongoDB behaviour: the integration tests do that.
 */
export class FakeMongoCollection {
  readonly documents = new Map<unknown, Doc>();
  readonly indexes: Array<{ spec: Record<string, number>; name?: string }> = [];
  /** Runs once, just before the next findOneAndUpdate / deleteOne is evaluated: use it to change the data "between the read and the write". */
  beforeNextWrite: (() => void) | null = null;
  /** When set, every operation fails with this error (a stand-in for a driver failure). */
  failWith: Error | null = null;

  async createIndex(spec: Record<string, number>, options: { name?: string } = {}): Promise<string> {
    this.#maybeFail();
    this.indexes.push({ spec, name: options.name });
    return options.name ?? "index";
  }

  async insertOne(document: Doc): Promise<{ insertedId: unknown }> {
    this.#maybeFail();
    if (this.documents.has(document._id)) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    this.documents.set(document._id, structuredClone(document));
    return { insertedId: document._id };
  }

  async findOne(filter: Record<string, unknown>): Promise<Doc | null> {
    this.#maybeFail();
    const found = [...this.documents.values()].find((doc) => matches(doc, filter));
    return found ? structuredClone(found) : null;
  }

  find(filter: Record<string, unknown>) {
    this.#maybeFail();
    let rows = [...this.documents.values()].filter((doc) => matches(doc, filter)).map((doc) => structuredClone(doc));
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        rows = rows.sort((a, b) => {
          for (const [key, direction] of Object.entries(spec)) {
            const left = comparable(a[key]);
            const right = comparable(b[key]);
            if (left !== right) return (left < right ? -1 : 1) * direction;
          }
          return 0;
        });
        return cursor;
      },
      skip: (count: number) => {
        rows = rows.slice(count);
        return cursor;
      },
      limit: (count: number) => {
        rows = rows.slice(0, count);
        return cursor;
      },
      toArray: async () => rows,
    };
    return cursor;
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }): Promise<Doc | null> {
    this.#maybeFail();
    this.#runBeforeWrite();
    const found = [...this.documents.values()].find((doc) => matches(doc, filter));
    if (!found) return null;
    const next = { ...found, ...structuredClone(update.$set) };
    this.documents.set(found._id, next);
    return structuredClone(next);
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    this.#maybeFail();
    this.#runBeforeWrite();
    const found = [...this.documents.values()].find((doc) => matches(doc, filter));
    if (!found) return { deletedCount: 0 };
    this.documents.delete(found._id);
    return { deletedCount: 1 };
  }

  #runBeforeWrite(): void {
    const hook = this.beforeNextWrite;
    this.beforeNextWrite = null;
    hook?.();
  }

  #maybeFail(): void {
    if (this.failWith) throw this.failWith;
  }
}

function comparable(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  return value as number | string;
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === "object" && condition !== null) {
      const operators = condition as { $in?: unknown[]; $gt?: unknown };
      if (operators.$in) return operators.$in.includes(value);
      if (operators.$gt !== undefined) return comparable(value) > comparable(operators.$gt);
      throw new Error(`fake collection: unsupported filter on ${key}`);
    }
    return value === condition;
  });
}

/** A MongoDBConnection stand-in that hands the repository the fake collection. */
export function fakeConnection(collection: FakeMongoCollection): MongoDBConnection {
  return { getDatabase: async () => ({ collection: () => collection }) } as unknown as MongoDBConnection;
}
