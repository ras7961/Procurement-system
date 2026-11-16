import { createContainer } from "@/infrastructure/container";
import { generateId } from "@/shared/utilities/uuid";
import { defineAuthApiScenarios } from "../support/authApiScenarios";
import { installContainer, uninstallContainer } from "../support/authApiTestKit";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";

/**
 * The same API scenarios as tests/unit/auth-api.test.ts, but through the real composition root:
 * MongoDB repositories, Argon2id hashing, JWT with persistent revocation in MongoDB.
 *
 * It runs against MONGODB_TEST_URI or a temporary in-memory MongoDB, and only ever touches a
 * database created for this run (the name is random and the whole database is dropped at the end).
 * When no MongoDB is available the suite is SKIPPED and the console says so; it is never reported as passed.
 *
 * The container is built in production mode so that the Secure cookie attribute is exercised too.
 * The settings are passed in directly, so nothing is read from, or written to, the real environment.
 */
const target = await resolveMongoTestTarget();
console.info(`[integration] Authentication API tests target: ${target ? target.source : "none (SKIPPED)"}`);

const APP_ORIGIN = "https://procurement.example.org";

defineAuthApiScenarios(
  "Authentication API (real MongoDB, Argon2id and JWT)",
  async () => {
    if (!target) throw new Error("no MongoDB target");
    const jwt = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api" };
    const container = createContainer({
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      MONGODB_URI: target.uri,
      MONGODB_DB_NAME: target.databaseName,
      JWT_SECRET: jwt.secret,
      JWT_ISSUER: jwt.issuer,
      JWT_AUDIENCE: jwt.audience,
      APP_ORIGIN,
    });
    installContainer(container);

    return {
      origin: APP_ORIGIN,
      jwt,
      secureCookies: true,
      users: container.userRepository,
      roles: container.roleRepository,
      passwords: container.passwordService,
      dispose: async () => {
        uninstallContainer();
        // Only the throw-away database created for this run is dropped.
        await (await container.mongoDB.getDatabase()).dropDatabase();
        await container.mongoDB.closeConnection();
        await target.stop();
      },
    };
  },
  { skip: !target },
);
