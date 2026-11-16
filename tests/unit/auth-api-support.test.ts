import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationController } from "@/controllers/AuthenticationController";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken, SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import {
  AccountInactiveException,
  AuthenticationRequiredException,
  DatabaseUnavailableException,
  InvalidConfigurationException,
} from "@/entities/exceptions";
import { Role } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import { User, type UserStatus } from "@/entities/User";
import { DEFAULT_APP_ORIGIN, EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { createContainer } from "@/infrastructure/container";
import { generateId } from "@/shared/utilities/uuid";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";
import { FakePasswordService, FakeTokenService } from "../support/authFakes";
import { catchAsyncError } from "../support/fixtures";
import { createInMemoryWorld } from "../support/inMemoryAuthApiWorld";

const ORIGIN = "https://procurement.example.org";
const requestWithCookie = (cookie?: string) => new Request(`${ORIGIN}/api/auth/me`, { headers: cookie ? { cookie } : {} });

describe("session cookie helpers", () => {
  const settings = { name: SESSION_COOKIE_NAME, secure: true };

  it("derives Max-Age from the token's own expiry, rounded down, never negative", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(buildSessionCookie(settings, "tok", new Date("2030-01-01T00:15:00.900Z"), now)).toContain("Max-Age=900;");
    expect(buildSessionCookie(settings, "tok", new Date("2029-12-31T00:00:00.000Z"), now)).toContain("Max-Age=0;");
  });

  it("sets HttpOnly, SameSite=Lax, Path=/ and Secure only when asked", () => {
    const now = new Date();
    const secure = buildSessionCookie(settings, "tok", new Date(now.getTime() + 60_000), now);
    const plain = buildSessionCookie({ ...settings, secure: false }, "tok", new Date(now.getTime() + 60_000), now);

    expect(secure.split("; ")).toEqual(expect.arrayContaining(["procurement_session=tok", "Path=/", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(plain).not.toContain("Secure");
    expect(plain).toContain("HttpOnly");
  });

  it("clears with the same Path, HttpOnly, SameSite and Secure attributes so the browser matches the cookie", () => {
    const cleared = buildClearedSessionCookie(settings);
    expect(cleared.split("; ")).toEqual(
      expect.arrayContaining(["procurement_session=", "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax", "Secure"]),
    );
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("reads only the session cookie and tolerates odd Cookie headers", () => {
    expect(readSessionToken(requestWithCookie("procurement_session=abc.def.ghi"), SESSION_COOKIE_NAME)).toBe("abc.def.ghi");
    expect(readSessionToken(requestWithCookie("a=1;  procurement_session=tok ; b=2"), SESSION_COOKIE_NAME)).toBe("tok");
    expect(readSessionToken(requestWithCookie("x_procurement_session=evil; procurement_session=real"), SESSION_COOKIE_NAME)).toBe("real");
    expect(readSessionToken(requestWithCookie("procurement_session="), SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readSessionToken(requestWithCookie("noequals; ;;"), SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readSessionToken(requestWithCookie(), SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readSessionToken(requestWithCookie(`procurement_session=${"x".repeat(9000)}`), SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe("AuthenticateSessionUseCase", () => {
  async function setup(status: UserStatus = "Active") {
    const users = new InMemoryUserRepository();
    const roles = new InMemoryRoleRepository();
    const tokens = new FakeTokenService();
    const supplierRole = await roles.create(
      Role.create({ roleId: generateId(), roleName: "Supplier", description: "Supplier.", permissions: getPermissionsForRole("Supplier") }),
    );
    const committeeRole = await roles.create(
      Role.create({
        roleId: generateId(),
        roleName: "Evaluation Committee",
        description: "Committee.",
        permissions: getPermissionsForRole("Evaluation Committee"),
      }),
    );
    const user = await users.create(
      User.restore({
        userId: generateId(),
        fullName: "Test Person",
        email: "test.person@example.com",
        passwordHash: await new FakePasswordService().hash("correct horse battery"),
        roleId: supplierRole.roleId,
        status,
        createdAt: new Date(),
      }),
    );
    const useCase = new AuthenticateSessionUseCase(tokens, new GetCurrentUserUseCase(users, roles));
    return { users, tokens, user, supplierRole, committeeRole, useCase };
  }

  it("returns the safe current user for a valid token", async () => {
    const { useCase, tokens, user, supplierRole } = await setup();
    const { token } = await tokens.issue({ userId: user.userId, roleId: supplierRole.roleId });

    const result = await useCase.execute({ token });

    expect(result).toMatchObject({ userId: user.userId, email: user.email, roleName: "Supplier", status: "Active" });
    expect(Object.keys(result)).not.toContain("passwordHash");
  });

  it.each([undefined, "", "unknown-token"])("throws AuthenticationRequiredException for token %j", async (token) => {
    const { useCase } = await setup();
    expect(await catchAsyncError(() => useCase.execute({ token }))).toBeInstanceOf(AuthenticationRequiredException);
  });

  it("throws AuthenticationRequiredException for a revoked token", async () => {
    const { useCase, tokens, user, supplierRole } = await setup();
    const { token } = await tokens.issue({ userId: user.userId, roleId: supplierRole.roleId });
    await tokens.revoke(token);
    expect(await catchAsyncError(() => useCase.execute({ token }))).toBeInstanceOf(AuthenticationRequiredException);
  });

  it("ignores the role in the token and reads the user's current role", async () => {
    const { useCase, tokens, users, user, committeeRole } = await setup();
    const { token } = await tokens.issue({ userId: user.userId, roleId: "role-id-claimed-by-the-token" });
    await users.update(user.userId, { roleId: committeeRole.roleId });

    expect((await useCase.execute({ token })).roleName).toBe("Evaluation Committee");
  });

  it("treats a token for a deleted account as no session", async () => {
    const { useCase, tokens, users, user, supplierRole } = await setup();
    const { token } = await tokens.issue({ userId: user.userId, roleId: supplierRole.roleId });
    await users.delete(user.userId);
    expect(await catchAsyncError(() => useCase.execute({ token }))).toBeInstanceOf(AuthenticationRequiredException);
  });

  it.each<UserStatus>(["Suspended", "Inactive", "Pending"])("passes on AccountInactiveException for a %s account", async (status) => {
    const { useCase, tokens, user, supplierRole } = await setup(status);
    const { token } = await tokens.issue({ userId: user.userId, roleId: supplierRole.roleId });
    expect(await catchAsyncError(() => useCase.execute({ token }))).toBeInstanceOf(AccountInactiveException);
  });
});

describe("AuthenticationController details", () => {
  const jsonPost = (path: string, body: unknown) =>
    new Request(`${ORIGIN}/api/auth/${path}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  afterEach(() => vi.restoreAllMocks());

  it("omits the Secure attribute when secure cookies are off (development over plain HTTP)", async () => {
    const { world, controller } = createInMemoryWorld({ secure: false });
    const role = await world.roles.create(
      Role.create({ roleId: generateId(), roleName: "Supplier", description: "Supplier.", permissions: getPermissionsForRole("Supplier") }),
    );
    const hash = await world.passwords.hash("correct horse battery");
    await world.users.create(
      User.restore({ userId: generateId(), fullName: "Dev Person", email: "dev@example.com", passwordHash: hash, roleId: role.roleId, status: "Active", createdAt: new Date() }),
    );

    const response = await controller.login(jsonPost("login", { email: "dev@example.com", password: "correct horse battery" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    await world.dispose();
  });

  it("sets Max-Age from the issued token's expiry, using the controller's clock", async () => {
    const users = new InMemoryUserRepository();
    const roles = new InMemoryRoleRepository();
    const passwords = new FakePasswordService();
    const tokens = new FakeTokenService(); // issues tokens that expire at 2030-01-01T00:00:00Z
    const role = await roles.create(
      Role.create({ roleId: generateId(), roleName: "Supplier", description: "Supplier.", permissions: getPermissionsForRole("Supplier") }),
    );
    await users.create(
      User.restore({
        userId: generateId(),
        fullName: "Clock Person",
        email: "clock@example.com",
        passwordHash: await passwords.hash("correct horse battery"),
        roleId: role.roleId,
        status: "Active",
        createdAt: new Date(),
      }),
    );
    const cookie = { name: SESSION_COOKIE_NAME, secure: true };
    const controller = new AuthenticationController(
      new RegisterSupplierUseCase(users, roles, passwords),
      new LoginUseCase(users, roles, passwords, tokens),
      new LogoutUseCase(tokens),
      new SessionAuthenticator(new AuthenticateSessionUseCase(tokens, new GetCurrentUserUseCase(users, roles)), cookie),
      { cookie, allowedOrigin: () => ORIGIN, now: () => new Date("2029-12-31T23:00:00.000Z") },
    );

    const response = await controller.login(jsonPost("login", { email: "clock@example.com", password: "correct horse battery" }));

    expect(response.headers.get("set-cookie")).toContain("procurement_session=test-token-1;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=3600;");
  });

  it("answers 500, not 404, when the Supplier role is missing from the database, and logs it", async () => {
    const { world, controller, loggedErrors } = createInMemoryWorld(); // no roles seeded
    const response = await controller.register(jsonPost("register", { fullName: "No Role", email: "norole@example.com", password: "correct horse battery" }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toEqual({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
    expect(loggedErrors).toHaveLength(1);
    await world.dispose();
  });

  it("maps a database outage to a generic 503", async () => {
    const { world, controller } = createInMemoryWorld();
    world.faults?.breakUserStore();
    (world.users as unknown as { failWith: Error }).failWith = new DatabaseUnavailableException({ cause: new Error("mongodb://u:hunter2@h") });

    const response = await controller.login(jsonPost("login", { email: "a@example.com", password: "correct horse battery" }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text).error).toEqual({ code: "SERVICE_UNAVAILABLE", message: "The service is temporarily unavailable." });
    expect(text).not.toMatch(/hunter2|mongodb/);
    await world.dispose();
  });

  it("never writes a submitted password to the log when a request fails", async () => {
    const { world, controller, loggedErrors } = createInMemoryWorld();
    world.faults?.breakUserStore();

    await controller.login(jsonPost("login", { email: "a@example.com", password: "my-very-private-password" }));

    expect(loggedErrors).toHaveLength(1);
    expect(JSON.stringify(loggedErrors, Object.getOwnPropertyNames(Object(loggedErrors[0])))).not.toContain("my-very-private-password");
    await world.dispose();
  });
});

describe("APP_ORIGIN configuration", () => {
  const base = { MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DB_NAME: "procurement_test" };
  const strongSecret = "Zk3p9Qw8Lm2Xv7Ra5Ty1Hn6Bc4Df0GsJu-_q8W2e9R4t6";

  it("defaults to http://localhost:3000 outside production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(new EnvironmentConfiguration({ ...base, NODE_ENV }).getAppOrigin()).toBe(DEFAULT_APP_ORIGIN);
    }
  });

  it("returns a configured origin, and treats an empty value (copied .env.example) as unset", () => {
    expect(new EnvironmentConfiguration({ ...base, APP_ORIGIN: "https://procurement.example.org" }).getAppOrigin()).toBe(ORIGIN);
    expect(new EnvironmentConfiguration({ ...base, APP_ORIGIN: "http://localhost:4000" }).getAppOrigin()).toBe("http://localhost:4000");
    expect(new EnvironmentConfiguration({ ...base, APP_ORIGIN: "" }).getAppOrigin()).toBe(DEFAULT_APP_ORIGIN);
  });

  const ORIGIN_HINT = [
    "APP_ORIGIN: must be an origin such as https://procurement.example.org (no path, no trailing slash)",
  ];

  it.each([
    "procurement.example.org",
    "https://procurement.example.org/",
    "https://procurement.example.org/app",
    "https://procurement.example.org?x=1",
    "ftp://procurement.example.org",
    "javascript:alert(1)",
    "HTTPS://PROCUREMENT.EXAMPLE.ORG",
    "*",
  ])("rejects %j as an origin, naming the setting but not the value", (value) => {
    const configuration = new EnvironmentConfiguration({ ...base, APP_ORIGIN: value });
    const status = configuration.validateConfiguration();

    expect(status.valid).toBe(false);
    // The issue text is fixed, so it cannot contain the submitted value.
    expect(status.issues).toEqual(ORIGIN_HINT);
    expect(() => configuration.getAppOrigin()).toThrow(InvalidConfigurationException);
  });

  it("is required in production", () => {
    const production = { ...base, NODE_ENV: "production", JWT_SECRET: strongSecret };
    const missing = new EnvironmentConfiguration(production);
    expect(missing.validateConfiguration().issues.join(" ")).toContain("APP_ORIGIN: is required in production");
    expect(() => missing.getAppOrigin()).toThrow(InvalidConfigurationException);

    expect(new EnvironmentConfiguration({ ...production, APP_ORIGIN: ORIGIN }).validateConfiguration().valid).toBe(true);
  });
});

describe("composition root (Stage 1E wiring)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wires the authentication controller, the session authenticator and the new use case", () => {
    const container = createContainer({ NODE_ENV: "test" });
    expect(container.authenticationController).toBeInstanceOf(AuthenticationController);
    expect(container.sessionAuthenticator).toBeInstanceOf(SessionAuthenticator);
    expect(container.authenticateSession).toBeInstanceOf(AuthenticateSessionUseCase);
  });

  it("starts in production without APP_ORIGIN, and then refuses state-changing requests instead of trusting any origin", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = createContainer({ NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:1", MONGODB_DB_NAME: "x", LOG_LEVEL: "error" });

    const response = await container.authenticationController.login(
      new Request("https://anything.example/api/auth/login", {
        method: "POST",
        headers: { Origin: "https://anything.example", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
      }),
    );

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
    await container.mongoDB.closeConnection();
  });
});
