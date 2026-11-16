import { afterAll, describe, expect, it, vi } from "vitest";
import { DatabaseConnectionException, DatabaseOperationException, InvalidCredentialsException } from "@/entities/exceptions";
import { Role } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import { User } from "@/entities/User";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { createContainer, type Container } from "@/infrastructure/container";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { MongoRevokedTokenRepository, REVOKED_TOKEN_TTL_INDEX } from "@/repositories/MongoRevokedTokenRepository";
import { generateId } from "@/shared/utilities/uuid";
import { catchAsyncError } from "../support/fixtures";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";

const silent = { write: () => undefined };
const target = await resolveMongoTestTarget();
console.info(`[integration] Token revocation tests target: ${target ? target.source : "none (SKIPPED)"}`);

const JWT_SECRET = `${generateId()}${generateId()}`; // random, test-only
const PASSWORD = "correct horse battery";

let connection: MongoDBConnection | null = null;
let container: Container | null = null;
let counter = 0;

function getConnection(): MongoDBConnection {
  if (!target) throw new Error("no target");
  if (!connection) {
    const configuration = new EnvironmentConfiguration({ NODE_ENV: "test", MONGODB_URI: target.uri, MONGODB_DB_NAME: target.databaseName });
    connection = new MongoDBConnection(configuration, new LoggingAndDeploymentConfiguration(configuration, silent));
  }
  return connection;
}

function getContainer(): Container {
  if (!target) throw new Error("no target");
  container ??= createContainer({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    MONGODB_URI: target.uri,
    MONGODB_DB_NAME: target.databaseName,
    JWT_SECRET,
  });
  return container;
}

const freshRepository = (options: { now?: () => Date } = {}) =>
  new MongoRevokedTokenRepository(getConnection(), { collectionName: `revoked_${(counter += 1)}`, ...options });

afterAll(async () => {
  if (!target) return;
  // Only the throw-away database created for this run is dropped.
  for (const connectionToClose of [connection, container?.mongoDB]) {
    if (connectionToClose) {
      await (await connectionToClose.getDatabase()).dropDatabase();
      await connectionToClose.closeConnection();
    }
  }
  await target.stop();
});

describe.skipIf(!target)("MongoRevokedTokenRepository against a real MongoDB", () => {
  const future = () => new Date(Date.now() + 60_000);

  it("reports unknown ids as not revoked and revoked ids as revoked", async () => {
    const repository = freshRepository();
    expect(await repository.isRevoked("jti-1")).toBe(false);

    await repository.revoke("jti-1", future());
    expect(await repository.isRevoked("jti-1")).toBe(true);
    expect(await repository.isRevoked("jti-2")).toBe(false);
  });

  it("is idempotent, including many simultaneous revocations of the same id", async () => {
    const repository = freshRepository();
    await repository.revoke("jti-1", future());
    await repository.revoke("jti-1", future());
    await Promise.all(Array.from({ length: 10 }, () => repository.revoke("jti-race", future())));

    const collection = (await getConnection().getDatabase()).collection(`revoked_${counter}`);
    expect(await collection.countDocuments({ _id: "jti-1" as never })).toBe(1);
    expect(await collection.countDocuments({ _id: "jti-race" as never })).toBe(1);
    expect(await repository.isRevoked("jti-race")).toBe(true);
  });

  it("keeps the first revocation record when revoked again", async () => {
    const repository = freshRepository();
    const first = new Date(Date.now() + 60_000);
    await repository.revoke("jti-1", first);
    await repository.revoke("jti-1", new Date(Date.now() + 999_000));

    const stored = await (await getConnection().getDatabase()).collection(`revoked_${counter}`).findOne({ _id: "jti-1" as never });
    expect(stored?.expiresAt).toEqual(first);
  });

  it("stores the token id as _id with BSON dates and nothing else", async () => {
    const repository = freshRepository();
    await repository.revoke("jti-1", future());

    const stored = await (await getConnection().getDatabase()).collection(`revoked_${counter}`).findOne({ _id: "jti-1" as never });
    expect(Object.keys(stored ?? {}).sort()).toEqual(["_id", "expiresAt", "revokedAt"]);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
  });

  it("creates a TTL index on expiresAt, repeatably", async () => {
    const repository = freshRepository();
    await repository.ensureIndexes();
    await repository.ensureIndexes();
    await new MongoRevokedTokenRepository(getConnection(), { collectionName: `revoked_${counter}` }).ensureIndexes();

    const index = (await (await getConnection().getDatabase()).collection(`revoked_${counter}`).indexes()).find((entry) => entry.name === REVOKED_TOKEN_TTL_INDEX);
    expect(index?.key).toEqual({ expiresAt: 1 });
    expect(index?.expireAfterSeconds).toBe(0);
  });

  it.skipIf(target?.source !== "mongodb-memory-server")("MongoDB deletes records after their expiry (TTL cleanup observed)", async () => {
    const repository = freshRepository();
    await repository.revoke("jti-old", new Date(Date.now() - 1_000));
    await repository.revoke("jti-live", new Date(Date.now() + 600_000));

    // The in-memory test server checks TTL indexes every second.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await repository.isRevoked("jti-old"))) await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await repository.isRevoked("jti-old")).toBe(false);
    expect(await repository.isRevoked("jti-live")).toBe(true);
  }, 40_000);

  it("rejects invalid arguments instead of writing garbage", async () => {
    const repository = freshRepository();
    expect(await catchAsyncError(() => repository.revoke("", future()))).toBeInstanceOf(DatabaseOperationException);
    expect(await catchAsyncError(() => repository.revoke("jti", new Date("nope")))).toBeInstanceOf(DatabaseOperationException);
    expect(await catchAsyncError(() => repository.isRevoked(""))).toBeInstanceOf(DatabaseOperationException);
  });
});

describe("MongoRevokedTokenRepository error handling (no database needed)", () => {
  const secret = "S3cretCredential";
  const stub = (error: unknown) => ({ getDatabase: async () => { throw error; } }) as unknown as MongoDBConnection;

  it("maps raw driver errors to a safe error without credentials, for both operations", async () => {
    const raw = Object.assign(new Error(`failed at mongodb://admin:${secret}@host`), { name: "MongoServerError", code: 8000 });
    const repository = new MongoRevokedTokenRepository(stub(raw));

    for (const action of [() => repository.isRevoked("jti"), () => repository.revoke("jti", new Date(Date.now() + 1000))]) {
      const error = await catchAsyncError(action);
      expect(error).toBeInstanceOf(DatabaseOperationException);
      expect(JSON.stringify((error as DatabaseOperationException).toSafeResponse())).not.toContain(secret);
    }
  });

  it("passes connection errors through, so a revocation check cannot silently succeed", async () => {
    const connectionError = new DatabaseConnectionException();
    expect(await catchAsyncError(() => new MongoRevokedTokenRepository(stub(connectionError)).isRevoked("jti"))).toBe(connectionError);
  });

  it("treats a duplicate-key race on the token id as success", async () => {
    const duplicate = Object.assign(new Error("E11000"), { code: 11000, keyPattern: { _id: 1 } });
    const connectionStub = {
      getDatabase: async () => ({ collection: () => ({ createIndex: async () => "ok", updateOne: async () => { throw duplicate; } }) }),
    } as unknown as MongoDBConnection;

    await expect(new MongoRevokedTokenRepository(connectionStub).revoke("jti", new Date(Date.now() + 1000))).resolves.toBeUndefined();
  });
});

describe.skipIf(!target)("login and logout through the composition root (real JWT service, real MongoDB)", () => {
  async function seedAccount() {
    const { roleRepository, userRepository, passwordService } = getContainer();
    const role =
      (await roleRepository.findByName("Procurement Broker")) ??
      (await roleRepository.create(
        Role.create({ roleId: generateId(), roleName: "Procurement Broker", description: "Manages tenders.", permissions: getPermissionsForRole("Procurement Broker") }),
      ));
    const email = `${generateId()}@example.com`;
    await userRepository.create(
      User.register({ userId: generateId(), fullName: "Test Broker", email, passwordHash: await passwordService.hash(PASSWORD), role }),
    );
    return { email, role };
  }

  it("login issues a real token that verifies; logout revokes it; it cannot be verified afterwards", async () => {
    const { login, logout, tokenService } = getContainer();
    const { email, role } = await seedAccount();

    const session = await login.execute({ email, password: PASSWORD });
    expect(await tokenService.verify(session.token)).toEqual({ userId: session.user.userId, roleId: role.roleId });
    expect(JSON.stringify(session.user)).not.toContain("argon2id");

    expect(await logout.execute({ token: session.token })).toEqual({ clearCredentials: true });
    expect(await tokenService.verify(session.token)).toBeNull();

    // Logging out again is harmless; the token stays rejected.
    expect(await logout.execute({ token: session.token })).toEqual({ clearCredentials: true });
    expect(await tokenService.verify(session.token)).toBeNull();
  });

  it("revoking one session does not affect another session of the same user", async () => {
    const { login, logout, tokenService } = getContainer();
    const { email } = await seedAccount();
    const first = await login.execute({ email, password: PASSWORD });
    const second = await login.execute({ email, password: PASSWORD });

    await logout.execute({ token: first.token });

    expect(await tokenService.verify(first.token)).toBeNull();
    expect(await tokenService.verify(second.token)).not.toBeNull();
  });

  it("the revocation survives a new container (persistent, not in memory)", async () => {
    const { login, logout } = getContainer();
    const { email } = await seedAccount();
    const session = await login.execute({ email, password: PASSWORD });
    await logout.execute({ token: session.token });

    const restarted = createContainer({ NODE_ENV: "test", MONGODB_URI: target!.uri, MONGODB_DB_NAME: target!.databaseName, JWT_SECRET });
    try {
      expect(await restarted.tokenService.verify(session.token)).toBeNull();
    } finally {
      await restarted.mongoDB.closeConnection();
    }
  });

  it("login still fails generically for a wrong password and issues no token", async () => {
    const { login } = getContainer();
    const { email } = await seedAccount();

    expect(await catchAsyncError(() => login.execute({ email, password: "wrong password" }))).toBeInstanceOf(InvalidCredentialsException);
  });

  it("the token service and both repositories use the container's single MongoDB connection", async () => {
    const container = getContainer();
    const getDatabase = vi.spyOn(container.mongoDB, "getDatabase");
    await container.revokedTokenRepository.isRevoked("any");
    await container.userRepository.findAll();
    await container.roleRepository.findAll();

    // Every repository went through the container's one MongoDBConnection object.
    expect(getDatabase).toHaveBeenCalledTimes(3);
    const before = await container.mongoDB.getDatabase();
    const collections = (await before.listCollections().toArray()).map((entry) => entry.name);
    expect(collections).toEqual(expect.arrayContaining(["users", "roles", "revoked_tokens"]));
  });
});
