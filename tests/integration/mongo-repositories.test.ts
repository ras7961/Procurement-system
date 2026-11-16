import { ObjectId, type Db } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  DatabaseConnectionException,
  DatabaseOperationException,
  DuplicateEmailException,
  DuplicateRoleException,
  UserRepositoryException,
} from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { MongoRoleRepository, ROLE_NAME_INDEX } from "@/repositories/MongoRoleRepository";
import { MongoUserRepository, USER_EMAIL_INDEX } from "@/repositories/MongoUserRepository";
import { toDomainDate, toDomainId, toUser } from "@/repositories/userDocumentMapper";
import { catchAsyncError, makeRole, makeUser, VALID_PASSWORD_HASH } from "../support/fixtures";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";
import { runRoleRepositoryContract } from "../support/roleRepositoryContract";
import { runUserRepositoryContract } from "../support/userRepositoryContract";

const silent = { write: () => undefined };
const target = await resolveMongoTestTarget();
console.info(`[integration] Mongo repository tests target: ${target ? target.source : "none (SKIPPED)"}`);

let connection: MongoDBConnection | null = null;
let collectionCounter = 0;

function getConnection(): MongoDBConnection {
  if (!target) throw new Error("no target");
  if (!connection) {
    const configuration = new EnvironmentConfiguration({
      NODE_ENV: "test",
      MONGODB_URI: target.uri,
      MONGODB_DB_NAME: target.databaseName,
    });
    connection = new MongoDBConnection(configuration, new LoggingAndDeploymentConfiguration(configuration, silent));
  }
  return connection;
}

/** A fresh, uniquely named collection for each test. */
function freshName(prefix: string): string {
  collectionCounter += 1;
  return `${prefix}_${collectionCounter}`;
}

afterAll(async () => {
  if (!target) return;
  // Only the throw-away database created for this run is dropped.
  if (connection) {
    await (await connection.getDatabase()).dropDatabase();
    await connection.closeConnection();
  }
  await target.stop();
});

describe.skipIf(!target)("Mongo repositories against a real MongoDB", () => {
  runUserRepositoryContract("MongoUserRepository", () => new MongoUserRepository(getConnection(), { collectionName: freshName("users") }));
  runRoleRepositoryContract("MongoRoleRepository", () => new MongoRoleRepository(getConnection(), { collectionName: freshName("roles") }));

  describe("MongoUserRepository specifics", () => {
    async function setup() {
      const name = freshName("users");
      const repository = new MongoUserRepository(getConnection(), { collectionName: name });
      const db: Db = await getConnection().getDatabase();
      return { repository, db, collection: db.collection(name) };
    }

    it("creates a unique case-insensitive email index and can be asked repeatedly", async () => {
      const { repository, collection } = await setup();
      await repository.ensureIndexes();
      await repository.ensureIndexes();
      await new MongoUserRepository(getConnection(), { collectionName: collection.collectionName }).ensureIndexes();

      const index = (await collection.indexes()).find((entry) => entry.name === USER_EMAIL_INDEX);
      expect(index?.unique).toBe(true);
      expect(index?.collation).toMatchObject({ locale: "en", strength: 2 });
    });

    it("the database itself rejects a differently cased duplicate email", async () => {
      const { repository, collection } = await setup();
      await repository.create(makeUser({ email: "dup@example.com" }));

      await expect(
        collection.insertOne({ _id: "raw-1" as unknown as ObjectId, email: "DUP@example.com" }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it("stores the domain id as _id, BSON dates, and the lowercase email", async () => {
      const { repository, collection } = await setup();
      const user = await repository.create(makeUser({ email: "Mixed@Example.com" }));

      const raw = await collection.findOne({ _id: user.userId as unknown as ObjectId });
      expect(raw?._id).toBe(user.userId);
      expect(raw?.createdAt).toBeInstanceOf(Date);
      expect(raw?.email).toBe("mixed@example.com");
      expect((await repository.findById(user.userId))?.createdAt).toBeInstanceOf(Date);
    });

    it("update() keeps userId and createdAt unchanged", async () => {
      const { repository, collection } = await setup();
      const user = await repository.create(makeUser());
      const before = await collection.findOne({ _id: user.userId as unknown as ObjectId });

      const updated = await repository.update(user.userId, { fullName: "Changed Name" });
      const after = await collection.findOne({ _id: user.userId as unknown as ObjectId });

      expect(updated.userId).toBe(user.userId);
      expect(after?._id).toBe(before?._id);
      expect(after?.createdAt).toEqual(before?.createdAt);
    });

    it("loads a document whose _id is an ObjectId and returns the hex string as the domain id", async () => {
      const { repository, collection } = await setup();
      const oid = new ObjectId();
      const user = makeUser({ userId: oid.toHexString() });
      await collection.insertOne({ ...(JSON.parse(JSON.stringify(user.toJSON())) as object), _id: oid, email: user.email, passwordHash: VALID_PASSWORD_HASH, createdAt: new Date() } as never);

      const all = await repository.findAll();
      expect(all.map((entry) => entry.userId)).toContain(oid.toHexString());
    });

    it("reports a corrupt stored document as a safe repository error", async () => {
      const { repository, collection } = await setup();
      await collection.insertOne({ _id: "corrupt" as unknown as ObjectId, email: "not-an-email" });

      const error = await catchAsyncError(() => repository.findById("corrupt"));
      expect(error).toBeInstanceOf(UserRepositoryException);
      expect(JSON.stringify((error as UserRepositoryException).toSafeResponse())).not.toContain("not-an-email");
    });
  });

  describe("MongoRoleRepository specifics", () => {
    it("creates a unique role-name index, repeatably, and rejects duplicates at the database", async () => {
      const name = freshName("roles");
      const repository = new MongoRoleRepository(getConnection(), { collectionName: name });
      await repository.ensureIndexes();
      await repository.ensureIndexes();
      const collection = (await getConnection().getDatabase()).collection(name);

      expect((await collection.indexes()).find((entry) => entry.name === ROLE_NAME_INDEX)?.unique).toBe(true);
      await repository.create(makeRole({ roleName: "Supplier" }));
      const error = await catchAsyncError(() => repository.create(makeRole({ roleName: "Supplier" })));
      expect(error).toBeInstanceOf(DuplicateRoleException);
    });

    it("stores permissions and keeps createdAt on update", async () => {
      const name = freshName("roles");
      const repository = new MongoRoleRepository(getConnection(), { collectionName: name });
      const role = await repository.create(makeRole({ roleName: "Administrator", permissions: ["user:manage"] }));
      const collection = (await getConnection().getDatabase()).collection(name);
      const before = await collection.findOne({ _id: role.roleId as unknown as ObjectId });

      await repository.update(role.roleId, { permissions: ["user:manage", "role:manage"] });
      const after = await collection.findOne({ _id: role.roleId as unknown as ObjectId });

      expect(after?.permissions).toEqual(["user:manage", "role:manage"]);
      expect(after?.createdAt).toEqual(before?.createdAt);
      expect(before?.createdAt).toBeInstanceOf(Date);
    });
  });
});

describe("error translation without a database", () => {
  const secret = "S3cretCredential";

  function stubConnection(error: unknown): MongoDBConnection {
    return { getDatabase: async () => { throw error; } } as unknown as MongoDBConnection;
  }

  it("maps a raw driver error to a safe repository error without credentials", async () => {
    const raw = Object.assign(new Error(`failed at mongodb://admin:${secret}@host`), { name: "MongoServerError", code: 8000 });
    const userError = await catchAsyncError(() => new MongoUserRepository(stubConnection(raw)).findAll());
    const roleError = await catchAsyncError(() => new MongoRoleRepository(stubConnection(raw)).findAll());

    expect(userError).toBeInstanceOf(UserRepositoryException);
    expect(roleError).toBeInstanceOf(DatabaseOperationException);
    for (const error of [userError, roleError]) {
      expect(JSON.stringify((error as UserRepositoryException).toSafeResponse())).not.toContain(secret);
      expect((error as UserRepositoryException).message).not.toContain(secret);
    }
  });

  it("lets connection errors pass through unchanged", async () => {
    const connectionError = new DatabaseConnectionException();
    const error = await catchAsyncError(() => new MongoUserRepository(stubConnection(connectionError)).findById("x"));
    expect(error).toBe(connectionError);
  });

  it("translates a duplicate-key error on the email index to DuplicateEmailException", async () => {
    const duplicate = Object.assign(new Error("E11000"), { code: 11000, keyPattern: { email: 1 } });
    const fake = {
      getDatabase: async () => ({
        collection: () => ({ createIndex: async () => "ok", insertOne: async () => { throw duplicate; } }),
      }),
    } as unknown as MongoDBConnection;
    expect(await catchAsyncError(() => new MongoUserRepository(fake).create(makeUser()))).toBeInstanceOf(DuplicateEmailException);
  });
});

describe("document mapper", () => {
  it("converts ObjectId to hex and any date-like value to a Date", () => {
    const oid = new ObjectId();
    expect(toDomainId(oid)).toBe(oid.toHexString());
    expect(toDomainId("abc")).toBe("abc");
    expect(toDomainDate(new Date(0))).toEqual(new Date(0));
  });

  it("wraps an invalid stored user as UserRepositoryException", () => {
    expect(() => toUser({ _id: "x", email: "bad" } as never)).toThrow(UserRepositoryException);
  });
});
