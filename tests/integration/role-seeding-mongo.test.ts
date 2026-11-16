import { afterAll, describe, expect, it } from "vitest";
import { ROLE_NAMES } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { MongoRoleRepository } from "@/repositories/MongoRoleRepository";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { resolveMongoTestTarget } from "../support/mongoTestTarget";

const target = await resolveMongoTestTarget();
console.info(`[integration] Role seeding tests target: ${target ? target.source : "none (SKIPPED)"}`);

let connection: MongoDBConnection | null = null;

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
  // Only the throw-away database created for this run is dropped.
  if (connection) {
    await (await connection.getDatabase()).dropDatabase();
    await connection.closeConnection();
  }
  await target.stop();
});

describe.skipIf(!target)("role seeding against a real MongoDB", () => {
  it("creates the roles once, is idempotent, and preserves a customized role", async () => {
    const repository = new MongoRoleRepository(getConnection(), { collectionName: "roles_seed_test" });
    await repository.ensureIndexes();
    const seeder = new SeedRolesUseCase(repository);

    const first = await seeder.execute();
    expect(first.created).toEqual([...ROLE_NAMES]);

    const second = await seeder.execute();
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual([...ROLE_NAMES]);
    expect(await repository.findAll()).toHaveLength(4);

    const broker = (await repository.findByName("Procurement Broker"))!;
    await repository.update(broker.roleId, { permissions: ["tender:read"] });
    const third = await seeder.execute();
    expect(third.customized.map((role) => role.roleName)).toEqual(["Procurement Broker"]);
    expect((await repository.findByName("Procurement Broker"))!.getPermissions()).toEqual(["tender:read"]);
    expect((await repository.findByName("Supplier"))!.getPermissions()).toEqual(getPermissionsForRole("Supplier"));
  });

  it("two seeders running at the same time still leave exactly four roles", async () => {
    const repository = new MongoRoleRepository(getConnection(), { collectionName: "roles_seed_race" });
    await repository.ensureIndexes();
    const results = await Promise.all([new SeedRolesUseCase(repository).execute(), new SeedRolesUseCase(repository).execute()]);

    expect(await repository.findAll()).toHaveLength(4);
    for (const result of results) expect(result.conflicts).toEqual([]);
    expect(results.flatMap((result) => result.created).sort()).toEqual([...ROLE_NAMES].sort());
  });
});
