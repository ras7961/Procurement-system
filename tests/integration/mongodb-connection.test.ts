import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseConfigurationException, DatabaseConnectionException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";

const silent = { write: () => undefined };

function createConnection(env: Record<string, string>) {
  const configuration = new EnvironmentConfiguration({ NODE_ENV: "test", ...env });
  return new MongoDBConnection(configuration, new LoggingAndDeploymentConfiguration(configuration, silent));
}

describe("MongoDBConnection without a database", () => {
  it("throws DatabaseConfigurationException when configuration is invalid", async () => {
    await expect(createConnection({}).connect()).rejects.toBeInstanceOf(DatabaseConfigurationException);
  });

  it("reports not_configured when configuration is invalid", async () => {
    expect(await createConnection({}).checkConnection()).toEqual({ status: "not_configured" });
  });

  it("fails clearly, quickly and without leaking credentials when the server is unreachable", async () => {
    const connection = createConnection({
      MONGODB_URI: "mongodb://admin:LeakCheck123@127.0.0.1:1",
      MONGODB_DB_NAME: "x",
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: "300",
    });

    const failure = await connection.connect().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DatabaseConnectionException);
    expect((failure as DatabaseConnectionException).toSafeResponse().message).toBe("Unable to connect to the database.");
    expect(JSON.stringify((failure as DatabaseConnectionException).toSafeResponse())).not.toContain("LeakCheck123");
    expect(await connection.checkConnection()).toEqual({ status: "down" });
  });

  it("closeConnection is safe when never connected", async () => {
    await expect(createConnection({}).closeConnection()).resolves.toBeUndefined();
  });
});

/**
 * Runs against a real MongoDB when one is available:
 *  - set MONGODB_TEST_URI to use your own server, or
 *  - otherwise an in-memory MongoDB is started (needs to download a mongod binary on first run).
 * If neither works, these tests are SKIPPED, not passed.
 */
describe("MongoDBConnection against a real MongoDB", () => {
  let uri: string | null = null;
  let server: MongoMemoryServer | null = null;
  let source = "none";

  beforeAll(async () => {
    if (process.env.MONGODB_TEST_URI) {
      uri = process.env.MONGODB_TEST_URI;
      source = "MONGODB_TEST_URI";
      return;
    }
    try {
      server = await MongoMemoryServer.create();
      uri = server.getUri();
      source = "mongodb-memory-server";
    } catch (error) {
      console.warn(`[integration] No MongoDB available, real-database tests will be skipped: ${(error as Error).message.slice(0, 200)}`);
    }
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("connects, pings and reuses a single connection", async (context) => {
    if (!uri) return context.skip();
    const connection = createConnection({ MONGODB_URI: uri, MONGODB_DB_NAME: "procurement_integration" });
    try {
      await Promise.all([connection.connect(), connection.connect()]);
      const first = await connection.getDatabase();
      const second = await connection.getDatabase();
      expect(first.databaseName).toBe("procurement_integration");
      expect(second.client).toBe(first.client);

      const status = await connection.checkConnection();
      expect(status.status).toBe("up");
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      console.info(`[integration] verified against ${source}`);
    } finally {
      await connection.closeConnection();
    }
  });

  it("can write and read a document through getDatabase()", async (context) => {
    if (!uri) return context.skip();
    const connection = createConnection({ MONGODB_URI: uri, MONGODB_DB_NAME: "procurement_integration" });
    try {
      const database = await connection.getDatabase();
      await database.collection("stage0_smoke").insertOne({ ok: true });
      expect(await database.collection("stage0_smoke").countDocuments({ ok: true })).toBe(1);
      await database.collection("stage0_smoke").drop();
    } finally {
      await connection.closeConnection();
    }
  });

  it("can reconnect after closeConnection()", async (context) => {
    if (!uri) return context.skip();
    const connection = createConnection({ MONGODB_URI: uri, MONGODB_DB_NAME: "procurement_integration" });
    await connection.connect();
    await connection.closeConnection();
    try {
      expect((await connection.checkConnection()).status).toBe("up");
    } finally {
      await connection.closeConnection();
    }
  });
});
