import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountInactiveException,
  AuthenticationRequiredException,
  DatabaseOperationException,
  RoleNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import { ROLE_NAMES, type RoleName } from "@/entities/Role";
import { PERMISSIONS, ROLE_PERMISSION_MATRIX, type Permission } from "@/entities/RolePermissionMatrix";
import type { UserStatus } from "@/entities/User";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { errorResponse } from "@/controllers/apiResponse";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { FakeTokenService } from "../support/authFakes";
import { catchAsyncError, makeUser } from "../support/fixtures";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";

class FlakyRoleRepository extends InMemoryRoleRepository {
  failWith: Error | null = null;
  override async findById(roleId: string) {
    if (this.failWith) throw this.failWith;
    return super.findById(roleId);
  }
}
class FlakyUserRepository extends InMemoryUserRepository {
  failWith: Error | null = null;
  override async findById(userId: string) {
    if (this.failWith) throw this.failWith;
    return super.findById(userId);
  }
}

const storageDown = () => new DatabaseOperationException({ cause: new Error("mongodb://admin:hunter2@db.internal refused") });

/** Roles are created by the real seeder, so these tests use the approved matrix. */
async function buildWorld() {
  const roles = new FlakyRoleRepository();
  const users = new FlakyUserRepository();
  const tokens = new FakeTokenService();
  await new SeedRolesUseCase(roles).execute();

  const authorize = new AuthorizeUseCase(users, roles);
  const sessions = new SessionAuthenticator(
    new AuthenticateSessionUseCase(tokens, new GetCurrentUserUseCase(users, roles)),
    { name: SESSION_COOKIE_NAME, secure: false },
  );
  const guard = new AuthorizationGuard(sessions, authorize);

  async function addUser(roleName: RoleName, status: UserStatus = "Active") {
    const role = (await roles.findByName(roleName))!;
    const user = await users.create(makeUser({ role, status: status === "Pending" ? "Pending" : "Active" }));
    if (status === "Inactive") await users.updateStatus(user.userId, "Inactive");
    if (status === "Suspended") await users.updateStatus(user.userId, "Suspended");
    // The token carries the roleId the user had at login; authorization must never rely on it.
    const { token } = await tokens.issue({ userId: user.userId, roleId: role.roleId });
    return { user, token };
  }
  const requestWith = (token?: string) =>
    new Request("http://localhost/api/x", { headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {} });

  return { roles, users, tokens, authorize, guard, addUser, requestWith };
}

describe("AuthorizeUseCase: the approved matrix, per role", () => {
  it("grants exactly the permissions each seeded role holds and denies every other one", async () => {
    const world = await buildWorld();
    for (const roleName of ROLE_NAMES) {
      const { user } = await world.addUser(roleName);
      for (const permission of PERMISSIONS) {
        const allowed = ROLE_PERMISSION_MATRIX[permission][roleName] !== "no";
        const outcome = world.authorize.execute({ userId: user.userId, permission });
        if (allowed) {
          const granted = await outcome;
          expect(granted.user.roleName).toBe(roleName);
          expect(granted.requiresScopeCheck).toBe(ROLE_PERMISSION_MATRIX[permission][roleName] === "restricted");
        } else {
          await expect(outcome).rejects.toBeInstanceOf(UnauthorizedAccessException);
        }
      }
    }
  });

  it("only an Administrator manages users and roles", async () => {
    const world = await buildWorld();
    const admin = await world.addUser("Administrator");
    for (const permission of ["user:manage", "role:manage"] as const) {
      await expect(world.authorize.execute({ userId: admin.user.userId, permission })).resolves.toBeDefined();
      for (const other of ["Procurement Broker", "Supplier", "Evaluation Committee"] as const) {
        const { user } = await world.addUser(other);
        await expect(world.authorize.execute({ userId: user.userId, permission })).rejects.toBeInstanceOf(UnauthorizedAccessException);
      }
    }
  });

  it("a Broker (and an Administrator) cannot manage evaluation scores; only the Committee can, and only for assigned tenders", async () => {
    const world = await buildWorld();
    for (const name of ["Procurement Broker", "Administrator", "Supplier"] as const) {
      const { user } = await world.addUser(name);
      await expect(world.authorize.execute({ userId: user.userId, permission: "evaluation:manage" })).rejects.toBeInstanceOf(
        UnauthorizedAccessException,
      );
    }
    const committee = await world.addUser("Evaluation Committee");
    const granted = await world.authorize.execute({ userId: committee.user.userId, permission: "evaluation:manage" });
    // General RBAC only says "the role holds it"; the assignment check belongs to the Evaluation module.
    expect(granted.requiresScopeCheck).toBe(true);
  });

  it("a Supplier holds only own-profile supplier permissions and cannot read other suppliers", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Supplier");
    for (const permission of ["supplier:read_own", "supplier:update_own"] as const) {
      expect((await world.authorize.execute({ userId: user.userId, permission })).requiresScopeCheck).toBe(true);
    }
    for (const permission of ["supplier:read", "supplier:manage", "user:manage", "evaluation:manage", "bid:read"] as const) {
      await expect(world.authorize.execute({ userId: user.userId, permission })).rejects.toBeInstanceOf(UnauthorizedAccessException);
    }
    // Suppliers submit bids, and nobody else does.
    await expect(world.authorize.execute({ userId: user.userId, permission: "bid:submit" })).resolves.toBeDefined();
    const broker = await world.addUser("Procurement Broker");
    await expect(world.authorize.execute({ userId: broker.user.userId, permission: "bid:submit" })).rejects.toBeInstanceOf(
      UnauthorizedAccessException,
    );
  });

  it("an Evaluation Committee member cannot manage tenders, suppliers, contracts or users", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Evaluation Committee");
    for (const permission of ["tender:create", "tender:publish", "supplier:manage", "contract:manage", "user:manage"] as const) {
      await expect(world.authorize.execute({ userId: user.userId, permission })).rejects.toBeInstanceOf(UnauthorizedAccessException);
    }
  });
});

describe("AuthorizeUseCase: who may be authorized", () => {
  let world: Awaited<ReturnType<typeof buildWorld>>;
  beforeEach(async () => {
    world = await buildWorld();
  });

  it("rejects an unknown user (authentication required)", async () => {
    const error = await catchAsyncError(() => world.authorize.execute({ userId: "nobody", permission: "tender:read" }));
    expect(error).toBeInstanceOf(AuthenticationRequiredException);
  });

  it("rejects a user who was deleted after the session started", async () => {
    const { user } = await world.addUser("Administrator");
    await world.users.delete(user.userId);
    await expect(world.authorize.execute({ userId: user.userId, permission: "user:manage" })).rejects.toBeInstanceOf(
      AuthenticationRequiredException,
    );
  });

  it.each(["Pending", "Inactive", "Suspended"] as const)("rejects a %s account, whatever its role", async (status) => {
    const { user } = await world.addUser("Administrator", status);
    const error = await catchAsyncError(() => world.authorize.execute({ userId: user.userId, permission: "user:manage" }));
    expect(error).toBeInstanceOf(AccountInactiveException);
  });

  it("takes effect immediately when an account is suspended after authorization worked", async () => {
    const { user } = await world.addUser("Procurement Broker");
    await expect(world.authorize.execute({ userId: user.userId, permission: "tender:create" })).resolves.toBeDefined();
    await world.users.updateStatus(user.userId, "Suspended");
    await expect(world.authorize.execute({ userId: user.userId, permission: "tender:create" })).rejects.toBeInstanceOf(
      AccountInactiveException,
    );
  });

  it("rejects bad input: empty user id, unknown permission, non-string values", async () => {
    const { user } = await world.addUser("Administrator");
    await expect(world.authorize.execute({ userId: "", permission: "user:manage" })).rejects.toBeInstanceOf(AuthenticationRequiredException);
    for (const permission of ["award:approve", "ai:award", "", "USER:MANAGE", undefined, null, 42]) {
      await expect(
        world.authorize.execute({ userId: user.userId, permission: permission as unknown as Permission }),
      ).rejects.toBeInstanceOf(UnauthorizedAccessException);
    }
    await expect(world.authorize.execute(undefined as never)).rejects.toBeInstanceOf(AuthenticationRequiredException);
  });
});

describe("AuthorizeUseCase: the stored role is the source of truth", () => {
  it("honours a permission removed from the stored role", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Procurement Broker");
    const role = (await world.roles.findByName("Procurement Broker"))!;
    role.removePermission("tender:publish");
    await world.roles.update(role.roleId, { permissions: role.getPermissions() });

    await expect(world.authorize.execute({ userId: user.userId, permission: "tender:publish" })).rejects.toBeInstanceOf(
      UnauthorizedAccessException,
    );
    await expect(world.authorize.execute({ userId: user.userId, permission: "tender:create" })).resolves.toBeDefined();
  });

  it("honours a permission added to the stored role", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Procurement Broker");
    const role = (await world.roles.findByName("Procurement Broker"))!;
    role.assignPermission("report:read");
    await world.roles.update(role.roleId, { permissions: role.getPermissions() });

    await expect(world.authorize.execute({ userId: user.userId, permission: "report:read" })).resolves.toBeDefined();
  });

  it("fails closed when the user's role record is missing", async () => {
    const world = await buildWorld();
    const orphanRole = (await world.roles.findByName("Administrator"))!;
    const user = await world.users.create(makeUser({ role: orphanRole }));
    // The user refers to a role id that no longer exists.
    await world.users.update(user.userId, { roleId: "role-that-was-deleted" });

    const error = await catchAsyncError(() => world.authorize.execute({ userId: user.userId, permission: "user:manage" }));
    expect(error).toBeInstanceOf(RoleNotFoundException);
  });

  it("fails closed when the permission data cannot be read: the storage error is thrown, access is never granted", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Administrator");

    world.roles.failWith = storageDown();
    const roleError = await catchAsyncError(() => world.authorize.execute({ userId: user.userId, permission: "user:manage" }));
    expect(roleError).toBeInstanceOf(DatabaseOperationException);

    world.roles.failWith = null;
    world.users.failWith = storageDown();
    const userError = await catchAsyncError(() => world.authorize.execute({ userId: user.userId, permission: "user:manage" }));
    expect(userError).toBeInstanceOf(DatabaseOperationException);

    world.users.failWith = null;
    await expect(world.authorize.execute({ userId: user.userId, permission: "user:manage" })).resolves.toBeDefined();
  });

  it("an unexpected non-application error also denies", async () => {
    const world = await buildWorld();
    const { user } = await world.addUser("Administrator");
    world.roles.failWith = new TypeError("boom");
    await expect(world.authorize.execute({ userId: user.userId, permission: "user:manage" })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("AuthorizationGuard: authentication, then authorization", () => {
  it("returns the authorized user for a valid session whose role holds the permission", async () => {
    const world = await buildWorld();
    const { token } = await world.addUser("Procurement Broker");
    const granted = await world.guard.require(world.requestWith(token), "tender:create");

    expect(granted.user.roleName).toBe("Procurement Broker");
    expect(granted.permission).toBe("tender:create");
    expect(granted.requiresScopeCheck).toBe(false);
    expect(JSON.stringify(granted)).not.toContain("passwordHash");
  });

  it("refuses a request without a session before any permission is looked at (401)", async () => {
    const world = await buildWorld();
    for (const token of [undefined, "forged-token"]) {
      await expect(world.guard.require(world.requestWith(token), "tender:read")).rejects.toBeInstanceOf(AuthenticationRequiredException);
    }
  });

  it("refuses a revoked token (401)", async () => {
    const world = await buildWorld();
    const { token } = await world.addUser("Administrator");
    await world.tokens.revoke(token);
    await expect(world.guard.require(world.requestWith(token), "user:manage")).rejects.toBeInstanceOf(AuthenticationRequiredException);
  });

  it("refuses an authenticated user who lacks the permission (403)", async () => {
    const world = await buildWorld();
    const { token } = await world.addUser("Supplier");
    await expect(world.guard.require(world.requestWith(token), "user:manage")).rejects.toBeInstanceOf(UnauthorizedAccessException);
  });

  it("never trusts the role in the token: a token minted with the Administrator role id gives a Supplier no administrator access", async () => {
    const world = await buildWorld();
    const admin = (await world.roles.findByName("Administrator"))!;
    const { user } = await world.addUser("Supplier");
    const forged = await world.tokens.issue({ userId: user.userId, roleId: admin.roleId });

    await expect(world.guard.require(world.requestWith(forged.token), "user:manage")).rejects.toBeInstanceOf(UnauthorizedAccessException);
  });

  it("uses the role the user has NOW: a demoted administrator loses access with the same token", async () => {
    const world = await buildWorld();
    const { user, token } = await world.addUser("Administrator");
    await expect(world.guard.require(world.requestWith(token), "user:manage")).resolves.toBeDefined();

    const supplier = (await world.roles.findByName("Supplier"))!;
    await world.users.update(user.userId, { roleId: supplier.roleId });

    await expect(world.guard.require(world.requestWith(token), "user:manage")).rejects.toBeInstanceOf(UnauthorizedAccessException);
  });

  it.each(["Pending", "Inactive", "Suspended"] as const)("refuses a %s account with a valid token (403 ACCOUNT_INACTIVE)", async (status) => {
    const world = await buildWorld();
    const { token } = await world.addUser("Administrator", status);
    await expect(world.guard.require(world.requestWith(token), "user:manage")).rejects.toBeInstanceOf(AccountInactiveException);
  });

  it("refuses a deleted account with a valid token (401)", async () => {
    const world = await buildWorld();
    const { user, token } = await world.addUser("Administrator");
    await world.users.delete(user.userId);
    await expect(world.guard.require(world.requestWith(token), "user:manage")).rejects.toBeInstanceOf(AuthenticationRequiredException);
  });
});

describe("a protected handler built on the guard: consistent API errors", () => {
  /** The shape every future controller method has: guard first, then the use case, one catch. */
  async function protectedHandler(world: Awaited<ReturnType<typeof buildWorld>>, request: Request, logged: unknown[]) {
    try {
      const { user } = await world.guard.require(request, "user:manage");
      return Response.json({ success: true, data: { userId: user.userId }, message: "ok" });
    } catch (error) {
      return errorResponse(error, { logError: (_message, cause) => void logged.push(cause) }, "protected-test");
    }
  }

  it("answers 200 to an Administrator", async () => {
    const world = await buildWorld();
    const { token } = await world.addUser("Administrator");
    const response = await protectedHandler(world, world.requestWith(token), []);
    expect(response.status).toBe(200);
  });

  it.each([
    ["no session", async (w: Awaited<ReturnType<typeof buildWorld>>) => w.requestWith(), 401, "AUTHENTICATION_REQUIRED"],
    ["a Supplier", async (w: Awaited<ReturnType<typeof buildWorld>>) => w.requestWith((await w.addUser("Supplier")).token), 403, "UNAUTHORIZED_ACCESS"],
    ["a Broker", async (w: Awaited<ReturnType<typeof buildWorld>>) => w.requestWith((await w.addUser("Procurement Broker")).token), 403, "UNAUTHORIZED_ACCESS"],
    ["a suspended administrator", async (w: Awaited<ReturnType<typeof buildWorld>>) => w.requestWith((await w.addUser("Administrator", "Suspended")).token), 403, "ACCOUNT_INACTIVE"],
  ])("answers %s with the standard error body", async (_label, makeRequest, status, code) => {
    const world = await buildWorld();
    const logged: unknown[] = [];
    const response = await protectedHandler(world, await makeRequest(world), logged);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ success: false, error: { code, message: expect.any(String) } });
    expect(logged).toEqual([]);
  });

  it("answers 500 and leaks nothing when the permission data is unavailable", async () => {
    const world = await buildWorld();
    const { token } = await world.addUser("Administrator");
    world.roles.failWith = storageDown();
    const logged: unknown[] = [];
    const response = await protectedHandler(world, world.requestWith(token), logged);
    const text = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("mongodb");
    expect(JSON.parse(text).success).toBe(false);
    expect(logged).toHaveLength(1);
  });

  it("answers 500 when the user's role record is missing, and still denies", async () => {
    const world = await buildWorld();
    const admin = (await world.roles.findByName("Administrator"))!;
    const user = await world.users.create(makeUser({ role: admin }));
    const { token } = await world.tokens.issue({ userId: user.userId, roleId: admin.roleId });
    await world.users.update(user.userId, { roleId: "gone" });

    const response = await protectedHandler(world, world.requestWith(token), []);
    expect(response.status).toBe(500);
  });
});
