/**
 * Seeds the four approved roles. Run with:  npm run seed:roles
 * Safe to repeat. Creates no users. Reads MONGODB_URI and MONGODB_DB_NAME from the environment,
 * or from .env.local / .env in the project folder when they are not already set.
 */
import { existsSync } from "node:fs";
import { createContainer } from "@/infrastructure/container";
import { MongoRoleRepository } from "@/repositories/MongoRoleRepository";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { runRoleSeeding } from "./seedRolesRunner";

for (const file of [".env.local", ".env"]) {
  // Variables that are already set always win.
  if (existsSync(file)) process.loadEnvFile(file);
}

const container = createContainer();
const roles = new MongoRoleRepository(container.mongoDB);

const exitCode = await runRoleSeeding({
  prepareStorage: () => roles.ensureIndexes(),
  seedRoles: new SeedRolesUseCase(roles),
  closeStorage: () => container.mongoDB.closeConnection(),
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
});
process.exit(exitCode);
