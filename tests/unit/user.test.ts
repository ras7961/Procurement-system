import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AccountInactiveException,
  InvalidRoleException,
  InvalidUserDataException,
  InvalidUserStatusTransitionException,
} from "@/entities/exceptions";
import { Role } from "@/entities/Role";
import {
  INITIAL_USER_STATUSES,
  PASSWORD_HASH_MIN_LENGTH,
  User,
  USER_STATUS_TRANSITIONS,
  USER_STATUSES,
  type UserStatus,
} from "@/entities/User";
import { catchError, makeRole, makeUser, VALID_PASSWORD_HASH } from "../support/fixtures";

const baseProps = () => ({
  userId: "user-1",
  fullName: "Abebe Kebede",
  email: "abebe@example.com",
  passwordHash: VALID_PASSWORD_HASH,
  role: makeRole(),
});

describe("User creation", () => {
  it("creates a valid user with the documented attributes", () => {
    const role = makeRole({ roleName: "Procurement Broker" });
    const before = Date.now();
    const user = User.register({ ...baseProps(), role });

    expect(user.userId).toBe("user-1");
    expect(user.fullName).toBe("Abebe Kebede");
    expect(user.email).toBe("abebe@example.com");
    expect(user.passwordHash).toBe(VALID_PASSWORD_HASH);
    expect(user.roleId).toBe(role.roleId);
    expect(user.status).toBe("Active");
    expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("normalizes the name and email (trim, collapse spaces, lowercase)", () => {
    const user = User.register({ ...baseProps(), fullName: "  Abebe    Kebede ", email: "  Abebe.Kebede@Example.COM " });
    expect(user.fullName).toBe("Abebe Kebede");
    expect(user.email).toBe("abebe.kebede@example.com");
  });

  it("knows the four statuses, and a new account may start only as Pending or Active", () => {
    expect([...USER_STATUSES]).toEqual(["Pending", "Active", "Inactive", "Suspended"]);
    expect([...INITIAL_USER_STATUSES]).toEqual(["Pending", "Active"]);

    const createdAt = new Date("2026-01-15T10:00:00Z");
    for (const status of INITIAL_USER_STATUSES) {
      const user = User.register({ ...baseProps(), status, createdAt });
      expect(user.status).toBe(status);
      expect(user.createdAt.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    }
    for (const status of ["Inactive", "Suspended"]) {
      const error = catchError(() => User.register({ ...baseProps(), status: status as never }));
      expect(error).toBeInstanceOf(InvalidUserDataException);
      expect((error as InvalidUserDataException).issues).toEqual(["status must be one of: Pending, Active"]);
    }
  });

  it("restore() accepts every stored status", () => {
    for (const status of USER_STATUSES) {
      const user = User.restore({
        userId: "u-1",
        fullName: "Abebe Kebede",
        email: "abebe@example.com",
        passwordHash: VALID_PASSWORD_HASH,
        roleId: "role-1",
        status,
        createdAt: new Date(),
      });
      expect(user.status).toBe(status);
    }
  });

  it("does not default to Pending: the creation workflow decides", () => {
    expect(User.register(baseProps()).status).toBe("Active");
  });

  it("gives each user the identifier it was created with", () => {
    expect(makeUser().userId).not.toBe(makeUser().userId);
  });
});

describe("User required attributes", () => {
  const invalidCases: Array<[string, Record<string, unknown>, string]> = [
    ["missing userId", { userId: "" }, "userId"],
    ["userId with spaces", { userId: "a b" }, "userId"],
    ["empty fullName", { fullName: "   " }, "fullName"],
    ["over-long fullName", { fullName: "x".repeat(101) }, "fullName"],
    ["non-string fullName", { fullName: 42 }, "fullName"],
    ["empty email", { email: "" }, "email"],
    ["email without @", { email: "abebe.example.com" }, "email"],
    ["email without domain dot", { email: "abebe@example" }, "email"],
    ["email with spaces", { email: "abe be@example.com" }, "email"],
    ["missing passwordHash", { passwordHash: "" }, "passwordHash"],
    ["unknown status", { status: "Banned" }, "status"],
    ["invalid createdAt", { createdAt: new Date("not a date") }, "createdAt"],
  ];

  it.each(invalidCases)("rejects %s with InvalidUserDataException", (_label, override, field) => {
    const error = catchError(() => User.register({ ...baseProps(), ...override } as never));
    expect(error).toBeInstanceOf(InvalidUserDataException);
    expect((error as InvalidUserDataException).issues.join(" ")).toContain(field);
    expect((error as InvalidUserDataException).httpStatus).toBe(400);
  });

  it("reports every problem at once", () => {
    const error = catchError(() =>
      User.register({ ...baseProps(), userId: "", fullName: "", email: "nope", status: "Banned" as never }),
    ) as InvalidUserDataException;
    expect(error.issues.map((issue) => issue.split(" ")[0])).toEqual(["userId", "fullName", "email", "status"]);
  });

  it("restore() validates stored data", () => {
    const stored = {
      userId: "u-1",
      fullName: "Abebe Kebede",
      email: "abebe@example.com",
      passwordHash: VALID_PASSWORD_HASH,
      roleId: "role-1",
      status: "Active" as const,
      createdAt: new Date(),
    };
    expect(User.restore(stored).roleId).toBe("role-1");
    expect(catchError(() => User.restore({ ...stored, roleId: "" }))).toBeInstanceOf(InvalidUserDataException);
    expect(catchError(() => User.restore({ ...stored, status: "Deleted" as never }))).toBeInstanceOf(InvalidUserDataException);
  });
});

describe("User role assignment", () => {
  it("registers with, and keeps, the assigned role", () => {
    const role = makeRole({ roleName: "Evaluation Committee" });
    expect(User.register({ ...baseProps(), role }).roleId).toBe(role.roleId);
  });

  it("assignRole() replaces the role with another valid Role", () => {
    const user = makeUser({ role: makeRole({ roleName: "Supplier" }) });
    const broker = makeRole({ roleName: "Procurement Broker" });

    user.assignRole(broker);
    expect(user.roleId).toBe(broker.roleId);
  });

  it("rejects a user created without a real Role", () => {
    for (const role of [undefined, null, {}, { roleId: "fake", roleName: "Administrator" }, "Administrator"]) {
      const error = catchError(() => User.register({ ...baseProps(), role: role as never }));
      expect(error).toBeInstanceOf(InvalidRoleException);
    }
  });

  it("assignRole() rejects anything that is not a Role and keeps the current role", () => {
    const role = makeRole();
    const user = makeUser({ role });

    expect(catchError(() => user.assignRole({ roleId: "x" } as never))).toBeInstanceOf(InvalidRoleException);
    expect(catchError(() => user.assignRole(undefined as never))).toBeInstanceOf(InvalidRoleException);
    expect(user.roleId).toBe(role.roleId);
  });

  it("cannot hold a role with an unsupported name, because such a Role cannot exist", () => {
    const error = catchError(() =>
      Role.create({ roleId: "r-x", roleName: "Super Admin" as never, description: "Not allowed" }),
    );
    expect(error).toBeInstanceOf(InvalidRoleException);
  });
});

describe("User password hash handling", () => {
  it("never includes the hash in JSON, string or inspect output", () => {
    const user = makeUser();

    expect(JSON.stringify(user)).not.toContain(VALID_PASSWORD_HASH);
    expect(JSON.stringify(user)).not.toContain("passwordHash");
    expect(user.toJSON()).not.toHaveProperty("passwordHash");
    expect(Object.keys(user)).toEqual([]);
    expect(String(user)).not.toContain(VALID_PASSWORD_HASH);
    expect(inspect(user, { depth: 5, showHidden: true })).not.toContain(VALID_PASSWORD_HASH);
  });

  it("rejects values that cannot be a hash without repeating them in the error", () => {
    for (const plain of ["hunter2", "Passw0rd!", "my plain text password that is long enough"]) {
      const error = catchError(() => User.register({ ...baseProps(), passwordHash: plain })) as InvalidUserDataException;
      expect(error).toBeInstanceOf(InvalidUserDataException);
      expect(error.issues).toEqual(["passwordHash must be a hashed password, not a plain-text password"]);
      expect(error.message).not.toContain(plain);
      expect(JSON.stringify(error.details)).not.toContain(plain);
    }
    expect(PASSWORD_HASH_MIN_LENGTH).toBe(20);
  });

  it("changePassword() stores the new hash and keeps the old one when the new value is invalid", () => {
    const user = makeUser();
    const newHash = `$argon2id$v=19$${"y".repeat(60)}`;

    user.changePassword(newHash);
    expect(user.passwordHash).toBe(newHash);

    expect(catchError(() => user.changePassword("short"))).toBeInstanceOf(InvalidUserDataException);
    expect(catchError(() => user.changePassword(""))).toBeInstanceOf(InvalidUserDataException);
    expect(user.passwordHash).toBe(newHash);
  });
});

describe("User status", () => {
  it("moves between Active, Inactive and Suspended", () => {
    const user = makeUser();
    expect(user.isActive()).toBe(true);

    user.deactivate();
    expect(user.status).toBe("Inactive");
    user.deactivate();
    expect(user.status).toBe("Inactive");

    user.activate();
    expect(user.status).toBe("Active");

    user.suspend();
    expect(user.status).toBe("Suspended");
    expect(user.isActive()).toBe(false);
  });

  it("assertCanAuthenticate() passes for Active accounts only", () => {
    const user = makeUser();
    expect(() => user.assertCanAuthenticate()).not.toThrow();

    const blocked: Array<() => User> = [
      () => {
        const inactive = makeUser();
        inactive.deactivate();
        return inactive;
      },
      () => {
        const suspended = makeUser();
        suspended.suspend();
        return suspended;
      },
      () => makeUser({ status: "Pending" }),
    ];
    for (const build of blocked) {
      const blockedUser = build();
      const error = catchError(() => blockedUser.assertCanAuthenticate());
      expect(error).toBeInstanceOf(AccountInactiveException);
      expect((error as AccountInactiveException).httpStatus).toBe(403);
      expect(error.message).toBe("This account is not active.");
    }
  });
});

describe("User Pending status and guarded transitions", () => {
  const statusOf = (status: UserStatus): User => {
    const user = makeUser({ status: "Active" });
    if (status === "Pending") return makeUser({ status: "Pending" });
    if (status === "Inactive") user.deactivate();
    if (status === "Suspended") user.suspend();
    return user;
  };

  it("a self-registered supplier starts Pending and is not active", () => {
    const supplier = makeUser({ role: makeRole({ roleName: "Supplier" }), status: "Pending" });
    expect(supplier.status).toBe("Pending");
    expect(supplier.isPending()).toBe(true);
    expect(supplier.isActive()).toBe(false);
  });

  it("a Pending account cannot authenticate (so it cannot reach bid submission)", () => {
    const supplier = makeUser({ status: "Pending" });
    expect(catchError(() => supplier.assertCanAuthenticate())).toBeInstanceOf(AccountInactiveException);
  });

  it("approve() activates a Pending account", () => {
    const supplier = makeUser({ status: "Pending" });
    supplier.approve();
    expect(supplier.status).toBe("Active");
    expect(supplier.isPending()).toBe(false);
    expect(() => supplier.assertCanAuthenticate()).not.toThrow();
  });

  it("approve() works only on Pending accounts", () => {
    for (const status of ["Active", "Inactive", "Suspended"] as const) {
      const user = statusOf(status);
      const error = catchError(() => user.approve());
      expect(error).toBeInstanceOf(InvalidUserStatusTransitionException);
      expect(user.status).toBe(status);
    }
  });

  it("activate() cannot be used to skip approval of a Pending account", () => {
    const supplier = makeUser({ status: "Pending" });
    expect(catchError(() => supplier.activate())).toBeInstanceOf(InvalidUserStatusTransitionException);
    expect(supplier.status).toBe("Pending");
  });

  it("a Pending account can be rejected by deactivating it, and the rejected account cannot log in", () => {
    const supplier = makeUser({ status: "Pending" });
    supplier.deactivate();
    expect(supplier.status).toBe("Inactive");
    expect(catchError(() => supplier.assertCanAuthenticate())).toBeInstanceOf(AccountInactiveException);
  });

  it("a Pending account cannot be suspended", () => {
    const supplier = makeUser({ status: "Pending" });
    expect(catchError(() => supplier.suspend())).toBeInstanceOf(InvalidUserStatusTransitionException);
    expect(supplier.status).toBe("Pending");
  });

  it("nothing can move back to Pending: no method exists for it", () => {
    const user = makeUser();
    expect("makePending" in user).toBe(false);
    for (const status of USER_STATUSES) {
      expect(USER_STATUS_TRANSITIONS[status]).not.toContain("Pending");
    }
  });

  it("follows the documented transition table exactly", () => {
    expect(USER_STATUS_TRANSITIONS).toEqual({
      Pending: ["Active", "Inactive"],
      Active: ["Inactive", "Suspended"],
      Inactive: ["Active"],
      Suspended: ["Active", "Inactive"],
    });

    const actions = {
      activate: (user: User) => user.activate(),
      deactivate: (user: User) => user.deactivate(),
      suspend: (user: User) => user.suspend(),
    };
    const targets = { activate: "Active", deactivate: "Inactive", suspend: "Suspended" } as const;

    for (const from of USER_STATUSES) {
      for (const [name, act] of Object.entries(actions)) {
        const target = targets[name as keyof typeof targets];
        const user = statusOf(from);
        const viaApproveOnly = from === "Pending" && target === "Active";
        const allowed = from === target || (USER_STATUS_TRANSITIONS[from].includes(target) && !viaApproveOnly);

        if (allowed) {
          act(user);
          expect(user.status, `${from} -> ${target}`).toBe(target);
        } else {
          expect(catchError(() => act(user)), `${from} -> ${target}`).toBeInstanceOf(InvalidUserStatusTransitionException);
          expect(user.status, `${from} stays`).toBe(from);
        }
      }
    }
  });

  it("an invalid transition reports a safe conflict error", () => {
    const error = catchError(() => makeUser({ status: "Pending" }).suspend()) as InvalidUserStatusTransitionException;
    expect(error.httpStatus).toBe(409);
    expect(error.toSafeResponse()).toEqual({
      code: "INVALID_STATUS_TRANSITION",
      message: "This account status change is not allowed.",
    });
  });

  it("status changes never touch the password hash or role", () => {
    const user = makeUser({ status: "Pending" });
    const { passwordHash, roleId } = user;
    user.approve();
    user.suspend();
    user.activate();
    expect(user.passwordHash).toBe(passwordHash);
    expect(user.roleId).toBe(roleId);
  });
});

describe("User profile", () => {
  it("updateProfile() changes the name and email, normalized", () => {
    const user = makeUser();
    user.updateProfile({ fullName: " Chala  Aser ", email: "Chala@Example.com" });
    expect(user.fullName).toBe("Chala Aser");
    expect(user.email).toBe("chala@example.com");
  });

  it("updateProfile() can change one field and leaves the other alone", () => {
    const user = makeUser({ fullName: "Original Name", email: "original@example.com" });
    user.updateProfile({ fullName: "Changed Name" });
    expect(user.fullName).toBe("Changed Name");
    expect(user.email).toBe("original@example.com");
  });

  it("updateProfile() is all-or-nothing and rejects an empty update", () => {
    const user = makeUser({ fullName: "Original Name", email: "original@example.com" });

    expect(catchError(() => user.updateProfile({ fullName: "Fine Name", email: "broken" }))).toBeInstanceOf(InvalidUserDataException);
    expect(catchError(() => user.updateProfile({}))).toBeInstanceOf(InvalidUserDataException);
    expect(user.fullName).toBe("Original Name");
    expect(user.email).toBe("original@example.com");
  });

  it("does not let callers change the creation date from outside", () => {
    const user = makeUser({ createdAt: new Date("2026-01-01T00:00:00Z") });
    user.createdAt.setFullYear(1999);
    expect(user.createdAt.getUTCFullYear()).toBe(2026);
  });

  it("serializes to the documented attributes except the hash", () => {
    const role = makeRole();
    const user = User.register({ ...baseProps(), role, createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(user.toJSON()).toEqual({
      userId: "user-1",
      fullName: "Abebe Kebede",
      email: "abebe@example.com",
      roleId: role.roleId,
      status: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
