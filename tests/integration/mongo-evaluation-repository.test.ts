import { afterAll, describe } from "vitest";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { MongoEvaluationRepository } from "@/repositories/MongoEvaluationRepository";
import { runEvaluationRepositoryContract } from "../support/evaluationRepositoryContract";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";

const target = await resolveMongoTestTarget();
console.info(`[integration] Mongo evaluation repository tests target: ${target ? target.source : "none (SKIPPED)"}`);

let connection: MongoDBConnection | null = null;
let counter = 0;
function getConnection(): MongoDBConnection {
  if (!target) throw new Error("no target");
  if (!connection) {
    const configuration = new EnvironmentConfiguration({ NODE_ENV: "test", MONGODB_URI: target.uri, MONGODB_DB_NAME: target.databaseName });
    connection = new MongoDBConnection(configuration, new LoggingAndDeploymentConfiguration(configuration, { write: () => undefined }));
  }
  return connection;
}

afterAll(async () => {
  if (!target) return;
  if (connection) {
    await (await getConnection().getDatabase()).dropDatabase();
    await connection.closeConnection();
  }
  await target.stop();
});

describe.skipIf(!target)("MongoEvaluationRepository against a real MongoDB", () => {
  runEvaluationRepositoryContract("MongoEvaluationRepository", () => new MongoEvaluationRepository(getConnection(), { collectionName: `evaluations_${(counter += 1)}` }));
});
