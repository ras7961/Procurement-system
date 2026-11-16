import { randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Where the MongoDB integration tests run.
 *  - "MONGODB_TEST_URI": the server named by that variable (only a throw-away database inside it is used).
 *  - "mongodb-memory-server": a temporary in-memory server (MONGOMS_SYSTEM_BINARY may point to a local mongod).
 *    It runs with a 1-second TTL monitor so TTL index cleanup can be observed; a MONGODB_TEST_URI server keeps
 *    its own setting (MongoDB checks TTL indexes about once a minute).
 * When neither is available the result is null and the caller must SKIP, never pass.
 */
export interface MongoTestTarget {
  readonly source: "MONGODB_TEST_URI" | "mongodb-memory-server";
  readonly uri: string;
  /** A unique database name for this run, so nothing else is ever touched. */
  readonly databaseName: string;
  stop(): Promise<void>;
}

export async function resolveMongoTestTarget(): Promise<MongoTestTarget | null> {
  const databaseName = `procurement_test_${randomBytes(6).toString("hex")}`;
  const configured = process.env.MONGODB_TEST_URI?.trim();
  if (configured) {
    return { source: "MONGODB_TEST_URI", uri: configured, databaseName, stop: async () => undefined };
  }
  try {
    const server = await MongoMemoryServer.create({ instance: { args: ["--setParameter", "ttlMonitorSleepSecs=1"] } });
    return { source: "mongodb-memory-server", uri: server.getUri(), databaseName, stop: async () => void (await server.stop()) };
  } catch (error) {
    console.warn(`[integration] No MongoDB available, real-database tests are SKIPPED: ${(error as Error).message.slice(0, 160)}`);
    return null;
  }
}
