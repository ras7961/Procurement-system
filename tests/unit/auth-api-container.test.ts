import { vi } from "vitest";
import { createContainer } from "@/infrastructure/container";
import { generateId } from "@/shared/utilities/uuid";
import { defineAuthApiScenarios } from "../support/authApiScenarios";
import { installContainer, uninstallContainer } from "../support/authApiTestKit";

/**
 * The same API scenarios, through the REAL composition root (createContainer) in production mode:
 * real configuration (APP_ORIGIN, JWT settings, Secure cookie flag), real Argon2id hashing, real
 * JwtTokenService and real route handlers. Only the three MongoDB repository classes are swapped
 * for the in-memory test doubles, so this runs without a database. It proves container.ts wires
 * the authentication endpoints correctly; the real-database run is tests/integration/auth-api.test.ts.
 */
vi.mock("@/repositories/MongoUserRepository", async () => ({
  MongoUserRepository: (await import("../support/InMemoryUserRepository")).InMemoryUserRepository,
}));
vi.mock("@/repositories/MongoRoleRepository", async () => ({
  MongoRoleRepository: (await import("../support/InMemoryRoleRepository")).InMemoryRoleRepository,
}));
vi.mock("@/repositories/MongoRevokedTokenRepository", async () => ({
  MongoRevokedTokenRepository: (await import("../support/InMemoryRevokedTokenRepository")).InMemoryRevokedTokenRepository,
}));

const APP_ORIGIN = "https://procurement.example.org";

defineAuthApiScenarios("Authentication API (real composition root, production mode, real Argon2id)", async () => {
  const jwt = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api" };
  const container = createContainer({
    NODE_ENV: "production",
    LOG_LEVEL: "error",
    MONGODB_URI: "mongodb://127.0.0.1:1", // never contacted: the repositories are in memory
    MONGODB_DB_NAME: "never_used",
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
      await container.mongoDB.closeConnection();
    },
  };
});
