import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountInactiveException,
  DuplicateEmailException,
  InvalidCredentialsException,
  InvalidRoleException,
  InvalidUserDataException,
  PasswordHashingException,
  RoleNotFoundException,
  UnauthorizedAccessException,
  UserNotFoundException,
  UserRepositoryException,
} from "@/entities/exceptions";
import { Role, ROLE_NAMES, type RoleName } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import { User, type UserStatus } from "@/entities/User";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { Argon2PasswordService } from "@/services/Argon2PasswordService";
import { generateId } from "@/shared/utilities/uuid";
import { CreateUserAccountUseCase } from "@/usecases/authentication/CreateUserAccountUseCase";
import { DUMMY_PASSWORD_HASH } from "@/usecases/authentication/dummyPasswordHash";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";
import { FakePasswordService, FakeTokenService } from "../support/authFakes";
import { catchAsyncError } from "../support/fixtures";

const GOOD_PASSWORD = "correct horse battery";

/** The four roles, loaded with the approved permission matrix as the later role-seeding step will do. */
async function seedRoles(roles: InMemoryRoleRepository): Promise<Record<RoleName, Role>> {
  const result = {} as Record<RoleName, Role>;
  for (const roleName of ROLE_NAMES) {
    result[roleName] = await roles.create(
      Role.create({
        roleId: generateId(),
        roleName,
        description: `The ${roleName} role.`,
        permissions: getPermissionsForRole(roleName),
      }),
    );
  }
  return result;
}

interface World {
  users: InMemoryUserRepository;
  roles: InMemoryRoleRepository;
  passwords: FakePasswordService;
  tokens: FakeTokenService;
  roleSet: Record<RoleName, Role>;
}

async function createWorld(): Promise<World> {
  const users = new InMemoryUserRepository();
  const roles = new InMemoryRoleRepository();
  return { users, roles, passwords: new FakePasswordService(), tokens: new FakeTokenService(), roleSet: await seedRoles(roles) };
}

/** Stores a user directly, with the given status, whose password is GOOD_PASSWORD. */
async function storeUser(world: World, roleName: RoleName, status: UserStatus, email = `${generateId()}@example.com`): Promise<User> {
  const passwordHash = await world.passwords.hash(GOOD_PASSWORD);
  const user = User.restore({
    userId: generateId(),
    fullName: "Stored Person",
    email,
    passwordHash,
    roleId: world.roleSet[roleName].roleId,
    status,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  return world.users.create(user);
}

describe("RegisterSupplierUseCase (public supplier registration)", () => {
  let world: World;
  let register: RegisterSupplierUseCase;

  beforeEach(async () => {
    world = await createWorld();
    register = new RegisterSupplierUseCase(world.users, world.roles, world.passwords);
  });

  it("creates a Pending Supplier account with a UUID and a hashed password", async () => {
    const result = await register.execute({ fullName: "Sara Tesfaye", email: "Sara@Example.com", password: GOOD_PASSWORD });

    expect(result.status).toBe("Pending");
    expect(result.roleName).toBe("Supplier");
    expect(result.roleId).toBe(world.roleSet.Supplier.roleId);
    expect(result.email).toBe("sara@example.com");
    expect(result.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const stored = await world.users.findById(result.userId);
    expect(stored?.status).toBe("Pending");
    expect(stored?.passwordHash).not.toContain(GOOD_PASSWORD);
    expect(stored?.passwordHash).toBe(await world.passwords.hash(GOOD_PASSWORD));
  });

  it("never returns the password or the hash", async () => {
    const result = await register.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: GOOD_PASSWORD });
    const text = JSON.stringify(result);

    expect(text).not.toContain(GOOD_PASSWORD);
    expect(text).not.toContain("argon2id");
    expect(Object.keys(result)).not.toContain("passwordHash");
  });

  it("does not activate the account: a Pending supplier cannot log in", async () => {
    await register.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: GOOD_PASSWORD });
    const login = new LoginUseCase(world.users, world.roles, world.passwords, world.tokens);

    await expect(login.execute({ email: "sara@example.com", password: GOOD_PASSWORD })).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(world.tokens.issued.size).toBe(0);
  });

  it("rejects a duplicate email, whatever its case", async () => {
    await register.execute({ fullName: "First Person", email: "same@example.com", password: GOOD_PASSWORD });
    const error = await catchAsyncError(() => register.execute({ fullName: "Second Person", email: "SAME@example.com", password: GOOD_PASSWORD }));

    expect(error).toBeInstanceOf(DuplicateEmailException);
    expect((await world.users.findAll()).length).toBe(1);
  });

  it("fails with RoleNotFoundException when the Supplier role does not exist", async () => {
    const emptyRoles = new InMemoryRoleRepository();
    const useCase = new RegisterSupplierUseCase(world.users, emptyRoles, world.passwords);

    const error = await catchAsyncError(() => useCase.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: GOOD_PASSWORD }));
    expect(error).toBeInstanceOf(RoleNotFoundException);
    expect(await world.users.findAll()).toEqual([]);
  });

  it("cannot be used to choose a privileged role or status, even if extra fields are sent", async () => {
    const sneaky = {
      fullName: "Mallory Mallory",
      email: "mallory@example.com",
      password: GOOD_PASSWORD,
      roleName: "Administrator",
      roleId: world.roleSet.Administrator.roleId,
      role: "Administrator",
      status: "Active",
      userId: "chosen-id",
    };
    const result = await register.execute(sneaky);

    expect(result.roleName).toBe("Supplier");
    expect(result.status).toBe("Pending");
    expect(result.userId).not.toBe("chosen-id");
    expect((await world.users.findById(result.userId))?.roleId).toBe(world.roleSet.Supplier.roleId);
  });

  it("validates input and reports every problem without echoing values", async () => {
    const error = (await catchAsyncError(() => register.execute({ fullName: "  ", email: "not-an-email", password: "short" }))) as InvalidUserDataException;

    expect(error).toBeInstanceOf(InvalidUserDataException);
    expect(error.issues.join(" ")).toMatch(/fullName/);
    expect(error.issues.join(" ")).toMatch(/email/);
    expect(error.issues.join(" ")).toMatch(/password must be at least 8/);
    expect(JSON.stringify(error.toSafeResponse())).not.toContain("not-an-email");
    expect(await world.users.findAll()).toEqual([]);
  });

  it("rejects missing and oversized passwords", async () => {
    const missing = await catchAsyncError(() => register.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: undefined as unknown as string }));
    const huge = await catchAsyncError(() => register.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: "a".repeat(129) }));

    expect(missing).toBeInstanceOf(InvalidUserDataException);
    expect(huge).toBeInstanceOf(InvalidUserDataException);
  });

  it("does not hash anything when the input is invalid", async () => {
    await catchAsyncError(() => register.execute({ fullName: "", email: "bad", password: "x" }));
    expect(world.passwords.verifyCalls).toEqual([]);
    expect(await world.users.findAll()).toEqual([]);
  });

  it("passes on a password service failure and stores nothing", async () => {
    world.passwords.breakLibrary();
    const error = await catchAsyncError(() => register.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: GOOD_PASSWORD }));

    expect(error).toBeInstanceOf(PasswordHashingException);
    expect(await world.users.findAll()).toEqual([]);
  });

  it("passes on a repository failure", async () => {
    const failing: UserRepositoryInterface = Object.assign(Object.create(world.users) as UserRepositoryInterface, {
      create: async () => {
        throw new UserRepositoryException();
      },
    });
    const useCase = new RegisterSupplierUseCase(failing, world.roles, world.passwords);

    const error = await catchAsyncError(() => useCase.execute({ fullName: "Sara Tesfaye", email: "sara@example.com", password: GOOD_PASSWORD }));
    expect(error).toBeInstanceOf(UserRepositoryException);
  });
});

describe("CreateUserAccountUseCase (administrator-created accounts)", () => {
  let world: World;
  let create: CreateUserAccountUseCase;
  let admin: User;

  beforeEach(async () => {
    world = await createWorld();
    create = new CreateUserAccountUseCase(world.users, world.roles, world.passwords);
    admin = await storeUser(world, "Administrator", "Active");
  });

  const newAccount = (roleName: string, email = "new.person@example.com") => ({
    actingUserId: admin.userId,
    fullName: "New Person",
    email,
    password: GOOD_PASSWORD,
    roleName,
  });

  it.each(["Procurement Broker", "Supplier", "Evaluation Committee"] as const)("creates an Active %s account", async (roleName) => {
    const result = await create.execute(newAccount(roleName, `${generateId()}@example.com`));

    expect(result.roleName).toBe(roleName);
    expect(result.status).toBe("Active");
    expect(JSON.stringify(result)).not.toContain("argon2id");
    expect((await world.users.findById(result.userId))?.roleId).toBe(world.roleSet[roleName].roleId);
  });

  it("an account it creates can log in", async () => {
    await create.execute(newAccount("Procurement Broker", "broker@example.com"));
    const login = new LoginUseCase(world.users, world.roles, world.passwords, world.tokens);

    const result = await login.execute({ email: "broker@example.com", password: GOOD_PASSWORD });
    expect(result.user.roleName).toBe("Procurement Broker");
  });

  it("rejects an unknown role name and a non-string role", async () => {
    expect(await catchAsyncError(() => create.execute(newAccount("Superuser")))).toBeInstanceOf(InvalidRoleException);
    expect(await catchAsyncError(() => create.execute(newAccount(undefined as unknown as string)))).toBeInstanceOf(InvalidRoleException);
    expect(await catchAsyncError(() => create.execute(newAccount("supplier")))).toBeInstanceOf(InvalidRoleException);
  });

  it("does not create Administrator accounts through this operation", async () => {
    expect(await catchAsyncError(() => create.execute(newAccount("Administrator")))).toBeInstanceOf(InvalidRoleException);
    expect((await world.users.findAll()).length).toBe(1);
  });

  it("fails with RoleNotFoundException when the role is valid but not stored", async () => {
    const roles = new InMemoryRoleRepository();
    await roles.create(world.roleSet.Administrator);
    const useCase = new CreateUserAccountUseCase(world.users, roles, world.passwords);

    expect(await catchAsyncError(() => useCase.execute(newAccount("Supplier")))).toBeInstanceOf(RoleNotFoundException);
  });

  it("rejects a duplicate email", async () => {
    await create.execute(newAccount("Supplier", "dup@example.com"));
    expect(await catchAsyncError(() => create.execute(newAccount("Procurement Broker", "DUP@example.com")))).toBeInstanceOf(DuplicateEmailException);
  });

  it.each(["Procurement Broker", "Supplier", "Evaluation Committee"] as const)("refuses an acting %s", async (roleName) => {
    const actor = await storeUser(world, roleName, "Active");
    const error = await catchAsyncError(() => create.execute({ ...newAccount("Supplier"), actingUserId: actor.userId }));

    expect(error).toBeInstanceOf(UnauthorizedAccessException);
    expect((await world.users.findAll()).length).toBe(2);
  });

  it.each(["Pending", "Inactive", "Suspended"] as const)("refuses an acting administrator whose account is %s", async (status) => {
    const actor = await storeUser(world, "Administrator", status);
    expect(await catchAsyncError(() => create.execute({ ...newAccount("Supplier"), actingUserId: actor.userId }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("refuses a missing, unknown or malformed acting user", async () => {
    for (const actingUserId of [undefined, "", "no-such-user", 42]) {
      const error = await catchAsyncError(() => create.execute({ ...newAccount("Supplier"), actingUserId: actingUserId as string }));
      expect(error).toBeInstanceOf(UnauthorizedAccessException);
    }
  });

  it("authorizes through the role's user:manage permission, not through the role name", async () => {
    const roles = new InMemoryRoleRepository();
    const bareAdmin = await roles.create(Role.create({ roleId: generateId(), roleName: "Administrator", description: "No permissions." }));
    await roles.create(world.roleSet.Supplier);
    const actor = await world.users.create(
      User.register({ userId: generateId(), fullName: "Bare Admin", email: "bare@example.com", passwordHash: await world.passwords.hash(GOOD_PASSWORD), role: bareAdmin }),
    );
    const useCase = new CreateUserAccountUseCase(world.users, roles, world.passwords);

    expect(await catchAsyncError(() => useCase.execute({ ...newAccount("Supplier"), actingUserId: actor.userId }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("validates the new account's data", async () => {
    const error = await catchAsyncError(() => create.execute({ ...newAccount("Supplier"), email: "bad", password: "short" }));
    expect(error).toBeInstanceOf(InvalidUserDataException);
  });

  it("passes on password service and repository failures", async () => {
    world.passwords.breakLibrary();
    expect(await catchAsyncError(() => create.execute(newAccount("Supplier")))).toBeInstanceOf(PasswordHashingException);

    const failingUsers = Object.assign(Object.create(world.users) as UserRepositoryInterface, {
      findByEmail: async () => {
        throw new UserRepositoryException();
      },
    });
    const failing = new CreateUserAccountUseCase(failingUsers, world.roles, new FakePasswordService());
    expect(await catchAsyncError(() => failing.execute(newAccount("Supplier")))).toBeInstanceOf(UserRepositoryException);
  });
});

describe("LoginUseCase", () => {
  let world: World;
  let login: LoginUseCase;

  beforeEach(async () => {
    world = await createWorld();
    login = new LoginUseCase(world.users, world.roles, world.passwords, world.tokens);
  });

  it("logs in an Active user and returns the user, a token and its expiry", async () => {
    const user = await storeUser(world, "Procurement Broker", "Active", "broker@example.com");
    const result = await login.execute({ email: "  BROKER@example.com ", password: GOOD_PASSWORD });

    expect(result.user).toMatchObject({ userId: user.userId, email: "broker@example.com", roleName: "Procurement Broker", status: "Active" });
    expect(result.token).toBe("test-token-1");
    expect(result.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(world.tokens.issued.get(result.token)).toEqual({ userId: user.userId, roleId: user.roleId });
  });

  it("never returns the password hash", async () => {
    await storeUser(world, "Supplier", "Active", "s@example.com");
    const result = await login.execute({ email: "s@example.com", password: GOOD_PASSWORD });

    expect(JSON.stringify(result)).not.toContain("argon2id");
    expect(Object.keys(result.user)).not.toContain("passwordHash");
  });

  it("rejects an incorrect password and issues no token", async () => {
    await storeUser(world, "Supplier", "Active", "s@example.com");
    const error = await catchAsyncError(() => login.execute({ email: "s@example.com", password: "wrong password" }));

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(world.tokens.issued.size).toBe(0);
  });

  it("verifies against the dummy Argon2id hash when the email is unknown, then fails generically", async () => {
    const error = await catchAsyncError(() => login.execute({ email: "nobody@example.com", password: GOOD_PASSWORD }));

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(world.passwords.verifyCalls).toEqual([{ password: GOOD_PASSWORD, hash: DUMMY_PASSWORD_HASH }]);
    expect(world.tokens.issued.size).toBe(0);
  });

  it("verifies exactly once, for a known email as for an unknown one", async () => {
    const user = await storeUser(world, "Supplier", "Active", "s@example.com");
    await catchAsyncError(() => login.execute({ email: "s@example.com", password: "wrong password" }));

    expect(world.passwords.verifyCalls).toEqual([{ password: "wrong password", hash: user.passwordHash }]);
  });

  it.each(["Pending", "Inactive", "Suspended"] as const)("rejects a %s account with the same generic error, even with the right password", async (status) => {
    await storeUser(world, "Supplier", status, "s@example.com");
    const known = await catchAsyncError(() => login.execute({ email: "s@example.com", password: GOOD_PASSWORD }));
    const unknown = await catchAsyncError(() => login.execute({ email: "nobody@example.com", password: GOOD_PASSWORD }));
    const wrong = await catchAsyncError(() => login.execute({ email: "s@example.com", password: "wrong password" }));

    for (const error of [known, unknown, wrong]) {
      expect(error).toBeInstanceOf(InvalidCredentialsException);
      expect(error).not.toBeInstanceOf(AccountInactiveException);
    }
    expect((known as InvalidCredentialsException).toSafeResponse()).toEqual((unknown as InvalidCredentialsException).toSafeResponse());
    expect((known as InvalidCredentialsException).toSafeResponse()).toEqual((wrong as InvalidCredentialsException).toSafeResponse());
    expect(JSON.stringify(known)).not.toContain(status);
    expect(known.cause).toBeUndefined();
    expect(world.tokens.issued.size).toBe(0);
  });

  it("checks the password before the status, so a wrong password on a suspended account looks the same", async () => {
    await storeUser(world, "Supplier", "Suspended", "s@example.com");
    await catchAsyncError(() => login.execute({ email: "s@example.com", password: "wrong password" }));
    await catchAsyncError(() => login.execute({ email: "s@example.com", password: GOOD_PASSWORD }));

    expect(world.passwords.verifyCalls).toHaveLength(2);
  });

  it("treats malformed input as the same generic failure, without hashing", async () => {
    for (const input of [
      { email: "", password: GOOD_PASSWORD },
      { email: "a@example.com", password: "" },
      { email: undefined, password: undefined },
      { email: 5, password: {} },
      { email: "a@example.com", password: "x".repeat(129) },
    ]) {
      expect(await catchAsyncError(() => login.execute(input as never))).toBeInstanceOf(InvalidCredentialsException);
    }
    expect(world.passwords.verifyCalls).toEqual([]);
  });

  it("does not turn infrastructure failures into a login failure", async () => {
    await storeUser(world, "Supplier", "Active", "s@example.com");

    world.passwords.breakLibrary();
    expect(await catchAsyncError(() => login.execute({ email: "s@example.com", password: GOOD_PASSWORD }))).toBeInstanceOf(PasswordHashingException);

    const failingUsers = Object.assign(Object.create(world.users) as UserRepositoryInterface, {
      findByEmail: async () => {
        throw new UserRepositoryException();
      },
    });
    const failing = new LoginUseCase(failingUsers, world.roles, new FakePasswordService(), world.tokens);
    expect(await catchAsyncError(() => failing.execute({ email: "s@example.com", password: GOOD_PASSWORD }))).toBeInstanceOf(UserRepositoryException);

    const tokens = new FakeTokenService();
    tokens.failWith = new Error("token backend down");
    const noTokens = new LoginUseCase(world.users, world.roles, new FakePasswordService(), tokens);
    await expect(noTokens.execute({ email: "s@example.com", password: GOOD_PASSWORD })).rejects.toThrow("token backend down");
  });

  it("fails with RoleNotFoundException when the user's role is missing", async () => {
    await storeUser(world, "Supplier", "Active", "s@example.com");
    const useCase = new LoginUseCase(world.users, new InMemoryRoleRepository(), world.passwords, world.tokens);

    expect(await catchAsyncError(() => useCase.execute({ email: "s@example.com", password: GOOD_PASSWORD }))).toBeInstanceOf(RoleNotFoundException);
    expect(world.tokens.issued.size).toBe(0);
  });
});

describe("LogoutUseCase", () => {
  it("revokes the presented token and tells the adapter to clear the client's credentials", async () => {
    const tokens = new FakeTokenService();
    const issued = await tokens.issue({ userId: "u1", roleId: "r1" });
    const result = await new LogoutUseCase(tokens).execute({ token: issued.token });

    expect(result).toEqual({ clearCredentials: true });
    expect(tokens.revoked).toEqual([issued.token]);
    expect(await tokens.verify(issued.token)).toBeNull();
  });

  it("succeeds without a token, and twice in a row", async () => {
    const tokens = new FakeTokenService();
    const logout = new LogoutUseCase(tokens);

    expect(await logout.execute({})).toEqual({ clearCredentials: true });
    expect(await logout.execute()).toEqual({ clearCredentials: true });
    expect(await logout.execute({ token: "" })).toEqual({ clearCredentials: true });
    expect(tokens.revoked).toEqual([]);

    await logout.execute({ token: "gone" });
    await logout.execute({ token: "gone" });
    expect(tokens.revoked).toEqual(["gone", "gone"]);
  });

  it("passes on a token service failure", async () => {
    const tokens = new FakeTokenService();
    tokens.failWith = new Error("token backend down");

    await expect(new LogoutUseCase(tokens).execute({ token: "t" })).rejects.toThrow("token backend down");
  });
});

describe("GetCurrentUserUseCase", () => {
  let world: World;
  let getCurrentUser: GetCurrentUserUseCase;

  beforeEach(async () => {
    world = await createWorld();
    getCurrentUser = new GetCurrentUserUseCase(world.users, world.roles);
  });

  it("returns the account information without passwordHash", async () => {
    const user = await storeUser(world, "Evaluation Committee", "Active", "member@example.com");
    const result = await getCurrentUser.execute({ userId: user.userId });

    expect(result).toEqual({
      userId: user.userId,
      fullName: "Stored Person",
      email: "member@example.com",
      roleId: world.roleSet["Evaluation Committee"].roleId,
      roleName: "Evaluation Committee",
      status: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.keys(result)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain("argon2id");
  });

  it("throws UserNotFoundException for an unknown or malformed id", async () => {
    for (const userId of ["no-such-user", "", undefined as unknown as string]) {
      expect(await catchAsyncError(() => getCurrentUser.execute({ userId }))).toBeInstanceOf(UserNotFoundException);
    }
  });

  it.each(["Pending", "Inactive", "Suspended"] as const)("gives no data for an account that became %s", async (status) => {
    const user = await storeUser(world, "Supplier", status);
    expect(await catchAsyncError(() => getCurrentUser.execute({ userId: user.userId }))).toBeInstanceOf(AccountInactiveException);
  });

  it("fails with RoleNotFoundException when the role is missing, and passes on repository failures", async () => {
    const user = await storeUser(world, "Supplier", "Active");
    const noRoles = new GetCurrentUserUseCase(world.users, new InMemoryRoleRepository());
    expect(await catchAsyncError(() => noRoles.execute({ userId: user.userId }))).toBeInstanceOf(RoleNotFoundException);

    const failingUsers = Object.assign(Object.create(world.users) as UserRepositoryInterface, {
      findById: async () => {
        throw new UserRepositoryException();
      },
    });
    const failing = new GetCurrentUserUseCase(failingUsers, world.roles);
    expect(await catchAsyncError(() => failing.execute({ userId: user.userId }))).toBeInstanceOf(UserRepositoryException);
  });
});

describe("dummy password hash", () => {
  it("is a valid Argon2id hash made with the same parameters as the real password service", async () => {
    const real = await new Argon2PasswordService().hash("any password");
    const parameters = (hash: string) => hash.split("$").slice(0, 4).join("$");

    expect(DUMMY_PASSWORD_HASH.startsWith("$argon2id$")).toBe(true);
    expect(parameters(DUMMY_PASSWORD_HASH)).toBe(parameters(real));
  });

  it("is accepted by the real verifier as a well-formed hash and rejects guesses", async () => {
    const service = new Argon2PasswordService();
    expect(await service.verify("not the password", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await service.verify(GOOD_PASSWORD, DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("no award authority", () => {
  it("no role created or used by the authentication use cases holds an award permission", async () => {
    const world = await createWorld();
    for (const role of Object.values(world.roleSet)) {
      expect(role.getPermissions().filter((permission) => /award|approve/i.test(permission))).toEqual([]);
    }
  });
});

describe("generateId", () => {
  it("returns distinct UUID v4 values", () => {
    const ids = new Set(Array.from({ length: 50 }, generateId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
