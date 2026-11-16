import { SignJWT } from "jose";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { Role, ROLE_NAMES, type RoleName } from "@/entities/Role";
import { getPermissionsForRole } from "@/entities/RolePermissionMatrix";
import { User, type UserStatus } from "@/entities/User";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import { generateId } from "@/shared/utilities/uuid";

/**
 * The Stage 1E API scenarios, written once and run twice:
 *  - tests/unit/auth-api.test.ts runs them with in-memory repositories (always runs);
 *  - tests/integration/auth-api.test.ts runs the same scenarios against a real MongoDB test database
 *    (skipped when no MongoDB is available).
 * Both go through the real route handlers, the real controller, the real use cases and the real
 * JwtTokenService (HS256, jose), so the only thing that differs is where the data is stored.
 */

export interface AuthApiWorld {
  /** The configured application origin: the only origin POST requests may come from. */
  readonly origin: string;
  readonly jwt: { secret: string; issuer: string; audience: string };
  readonly secureCookies: boolean;
  readonly users: UserRepositoryInterface;
  readonly roles: RoleRepositoryInterface;
  readonly passwords: PasswordServiceInterface;
  /** Failure injection. Only the in-memory world provides it. */
  readonly faults?: {
    breakUserStore(): void;
    breakRevocationStore(): void;
    heal(): void;
    readonly loggedErrors: unknown[];
  };
  dispose(): Promise<void>;
}

const PASSWORD = "correct horse battery";
const COOKIE_NAME = "procurement_session";
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

interface Sent {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON under test
  text: string;
  headers: Headers;
  setCookie: string | null;
}

interface SendOptions {
  body?: unknown;
  rawBody?: string;
  /** Defaults to the configured origin. `null` sends no Origin header. */
  origin?: string | null;
  referer?: string;
  contentType?: string | null;
  cookie?: string;
}

export function defineAuthApiScenarios(label: string, createWorld: () => Promise<AuthApiWorld>, options: { skip?: boolean } = {}) {
  describe.skipIf(options.skip === true)(label, () => {
    let world: AuthApiWorld;
    const rolesByName = {} as Record<RoleName, Role>;
    const knownHashes = new Set<string>();
    let counter = 0;

    beforeAll(async () => {
      world = await createWorld();
      for (const roleName of ROLE_NAMES) {
        rolesByName[roleName] = await world.roles.create(
          Role.create({ roleId: generateId(), roleName, description: `The ${roleName} role.`, permissions: getPermissionsForRole(roleName) }),
        );
      }
    }, 120_000);

    afterAll(async () => {
      await world?.dispose();
    }, 60_000);

    const nextEmail = () => `person${(counter += 1)}.${generateId().slice(0, 8)}@example.com`;

    // ---------------------------------------------------------------- helpers

    async function seedUser(overrides: { roleName?: RoleName; status?: UserStatus; email?: string } = {}) {
      const passwordHash = await world.passwords.hash(PASSWORD);
      knownHashes.add(passwordHash);
      const role = rolesByName[overrides.roleName ?? "Supplier"];
      const user = await world.users.create(
        User.restore({
          userId: generateId(),
          fullName: "Abebe Kebede",
          email: overrides.email ?? nextEmail(),
          passwordHash,
          roleId: role.roleId,
          status: overrides.status ?? "Active",
          createdAt: new Date(),
        }),
      );
      return user;
    }

    function buildRequest(method: "GET" | "POST", path: string, o: SendOptions): Request {
      const headers = new Headers();
      const origin = o.origin === undefined ? world.origin : o.origin;
      if (origin !== null) headers.set("Origin", origin);
      if (o.referer !== undefined) headers.set("Referer", o.referer);
      if (o.cookie !== undefined) headers.set("Cookie", o.cookie);
      let body: string | undefined;
      if (method === "POST") {
        body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
        if (o.contentType !== null) headers.set("Content-Type", o.contentType ?? "application/json");
      }
      return new Request(`${world.origin}/api/auth/${path}`, { method, headers, body });
    }

    /** Calls the real route handler and checks everything that must hold for EVERY response. */
    async function send(path: "register" | "login" | "logout" | "me", o: SendOptions = {}): Promise<Sent> {
      const handler = { register: registerRoute, login: loginRoute, logout: logoutRoute, me: meRoute }[path];
      const response = await handler(buildRequest(path === "me" ? "GET" : "POST", path, o));
      const text = await response.text();
      const sent: Sent = { status: response.status, body: JSON.parse(text), text, headers: response.headers, setCookie: response.headers.get("set-cookie") };
      assertUniversalRules(sent);
      return sent;
    }

    function assertUniversalRules(sent: Sent): void {
      // Standard JSON envelope.
      if (sent.status < 400) {
        expect(Object.keys(sent.body).sort()).toEqual(["data", "message", "success"]);
        expect(sent.body.success).toBe(true);
      } else {
        expect(Object.keys(sent.body).sort()).toEqual(["error", "success"]);
        expect(sent.body.success).toBe(false);
        expect(Object.keys(sent.body.error).sort()).toEqual(["code", "message"]);
      }
      // Authenticated responses are never cached, and there is no CORS support.
      expect(sent.headers.get("cache-control")).toMatch(/no-store/);
      expect(sent.headers.get("pragma")).toBe("no-cache");
      expect(sent.headers.get("vary")).toMatch(/Cookie/i);
      expect(sent.headers.get("content-type")).toMatch(/^application\/json/);
      for (const name of sent.headers.keys()) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
      // Nothing secret or technical in any body.
      for (const forbidden of [
        /passwordHash/i,
        /\$argon2/,
        /\$2[aby]\$/,
        /JWT_SECRET/,
        /mongodb(\+srv)?:\/\//i,
        /MongoServerError|MongoNetworkError|DatabaseOperationException/,
        /\bat\s+\S+\s+\(.*:\d+:\d+\)/,
        /eyJ[\w-]{10,}/,
        /hunter2/,
      ]) {
        expect(sent.text).not.toMatch(forbidden);
      }
      expect(sent.text).not.toContain(world.jwt.secret);
      expect(sent.text).not.toContain(PASSWORD);
      for (const hash of knownHashes) expect(sent.text).not.toContain(hash);
    }

    function tokenFrom(setCookie: string | null): string {
      const match = setCookie?.match(new RegExp(`^${COOKIE_NAME}=([^;]+);`));
      if (!match?.[1]) throw new Error("no session token in Set-Cookie");
      return match[1];
    }

    const cookieFor = (token: string) => `${COOKIE_NAME}=${token}`;

    function expectCookieAttributes(setCookie: string | null): void {
      expect(setCookie).not.toBeNull();
      expect(setCookie).toMatch(/;\s*HttpOnly/);
      expect(setCookie).toMatch(/;\s*SameSite=Lax/);
      expect(setCookie).toMatch(/;\s*Path=\//);
      if (world.secureCookies) expect(setCookie).toMatch(/;\s*Secure/);
      else expect(setCookie).not.toMatch(/Secure/);
    }

    async function loginAs(user: User): Promise<{ token: string; sent: Sent }> {
      const sent = await send("login", { body: { email: user.email, password: PASSWORD } });
      expect(sent.status).toBe(200);
      return { token: tokenFrom(sent.setCookie), sent };
    }

    /** A token that is well-formed, signed with the real secret and unexpired unless told otherwise. */
    async function forgeToken(user: User, overrides: { secret?: string; expiresInSeconds?: number; issuer?: string; audience?: string } = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ roleId: user.roleId })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(user.userId)
        .setJti(generateId())
        .setIssuedAt(now - 3600)
        .setExpirationTime(now + (overrides.expiresInSeconds ?? 600))
        .setIssuer(overrides.issuer ?? world.jwt.issuer)
        .setAudience(overrides.audience ?? world.jwt.audience)
        .sign(new TextEncoder().encode(overrides.secret ?? world.jwt.secret));
    }

    // ------------------------------------------------------------- registration

    describe("POST /api/auth/register", () => {
      it("creates a Supplier account with Pending status and returns safe user data only", async () => {
        const email = nextEmail();
        const sent = await send("register", { body: { fullName: "Hana Tesfaye", email, password: PASSWORD } });

        expect(sent.status).toBe(201);
        expect(sent.body.data.user).toMatchObject({ email, fullName: "Hana Tesfaye", roleName: "Supplier", status: "Pending" });
        expect(Object.keys(sent.body.data.user).sort()).toEqual(["createdAt", "email", "fullName", "roleId", "roleName", "status", "userId"]);
        expect(sent.setCookie).toBeNull(); // registering does not log anyone in

        const stored = await world.users.findByEmail(email);
        expect(stored?.status).toBe("Pending");
        expect(stored?.roleId).toBe(rolesByName.Supplier.roleId);
        expect(stored?.passwordHash).not.toBe(PASSWORD);
        expect(sent.text).not.toContain(stored!.passwordHash);
      });

      it.each([
        ["no fields", {}, "fullName is required"],
        ["a missing email", { fullName: "A B", password: PASSWORD }, "email is required"],
        ["a malformed email", { fullName: "A B", email: "not-an-email", password: PASSWORD }, "email must be a valid email address"],
        ["an over-long email", { fullName: "A B", email: `${"a".repeat(250)}@example.com`, password: PASSWORD }, "email must be at most 254 characters"],
        ["a blank name", { fullName: "   ", email: "blank@example.com", password: PASSWORD }, "fullName is required"],
        ["an over-long name", { fullName: "n".repeat(101), email: "long@example.com", password: PASSWORD }, "fullName must be at most 100 characters"],
        ["a name that is not a string", { fullName: 42, email: "type@example.com", password: PASSWORD }, "fullName must be a string"],
        ["a short password", { fullName: "A B", email: "short@example.com", password: "short" }, "password must be at least 8 characters"],
        ["an over-long password", { fullName: "A B", email: "huge@example.com", password: "p".repeat(129) }, "password must be at most 128 characters"],
        ["a missing password", { fullName: "A B", email: "nopass@example.com" }, "password is required"],
      ])("rejects %s with 400", async (_name, body, expectedMessage) => {
        const sent = await send("register", { body });
        expect(sent.status).toBe(400);
        expect(sent.body.error.code).toBe("INVALID_REQUEST");
        expect(sent.body.error.message).toContain(expectedMessage);
        const email = (body as { email?: unknown }).email;
        if (typeof email === "string") expect(await world.users.findByEmail(email)).toBeNull();
      });

      it("rejects bodies that are not a JSON object", async () => {
        const cases: SendOptions[] = [
          { rawBody: "{not json" },
          { rawBody: "[]" },
          { rawBody: "null" },
          { rawBody: '"text"' },
          { rawBody: "" },
          { body: { fullName: "x".repeat(20_000), email: "big@example.com", password: PASSWORD } },
          { body: { fullName: "A B", email: "form@example.com", password: PASSWORD }, contentType: "text/plain" },
          { body: { fullName: "A B", email: "form@example.com", password: PASSWORD }, contentType: null },
        ];
        for (const options of cases) {
          const sent = await send("register", options);
          expect(sent.status).toBe(400);
          expect(sent.body.error.code).toBe("INVALID_REQUEST");
        }
      });

      it("rejects a duplicate email with 409, whatever the letter case", async () => {
        const email = nextEmail();
        expect((await send("register", { body: { fullName: "First Person", email, password: PASSWORD } })).status).toBe(201);

        for (const attempt of [email, email.toUpperCase(), `  ${email}  `]) {
          const sent = await send("register", { body: { fullName: "Second Person", email: attempt, password: PASSWORD } });
          expect(sent.status).toBe(409);
          expect(sent.body.error.code).toBe("DUPLICATE_EMAIL");
        }
        const existing = await seedUser();
        expect((await send("register", { body: { fullName: "Third Person", email: existing.email, password: PASSWORD } })).status).toBe(409);
      });

      it.each([
        ["roleName", "Administrator"],
        ["role", "Administrator"],
        ["roleId", "any-role-id"],
        ["status", "Active"],
        ["permissions", ["*", "user:manage"]],
        ["passwordHash", "$argon2id$v=19$m=65536,t=3,p=4$AAAA$BBBB"],
        ["userId", "chosen-id"],
        ["isAdmin", true],
      ])("rejects an attempt to set %s, creates no account and does not echo the field", async (field, value) => {
        const email = nextEmail();
        const sent = await send("register", { body: { fullName: "Sly Person", email, password: PASSWORD, [field]: value } });

        expect(sent.status).toBe(400);
        expect(sent.body.error.code).toBe("INVALID_REQUEST");
        expect(sent.body.error.message).toContain("not allowed");
        expect(sent.text).not.toContain(field);
        expect(await world.users.findByEmail(email)).toBeNull();
      });
    });

    // -------------------------------------------------------------------- login

    describe("POST /api/auth/login", () => {
      it("signs in an Active user: token only in an HttpOnly cookie, never in the JSON", async () => {
        const user = await seedUser();
        const { token, sent } = await loginAs(user);

        expect(token).toMatch(JWT_SHAPE);
        expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).alg).toBe("HS256");
        expectCookieAttributes(sent.setCookie);
        expect(sent.setCookie).toMatch(/Max-Age=(89\d|900)(;|$)/); // the 15-minute default, minus the milliseconds since issuing
        expect(sent.setCookie).not.toMatch(/Expires/i);

        expect(sent.body.data.user).toMatchObject({ userId: user.userId, email: user.email, roleName: "Supplier", status: "Active" });
        expect(typeof sent.body.data.expiresAt).toBe("string");
        expect(Object.keys(sent.body.data).sort()).toEqual(["expiresAt", "user"]);
        expect(sent.text).not.toContain(token);
        expect(sent.text).not.toMatch(/token/i);
      });

      it("fails with the identical generic 401 for every reason, and sets no cookie", async () => {
        const active = await seedUser();
        const attempts = [
          { email: active.email, password: "wrong password!" },
          { email: `nobody.${generateId().slice(0, 8)}@example.com`, password: PASSWORD },
          { email: (await seedUser({ status: "Pending" })).email, password: PASSWORD },
          { email: (await seedUser({ status: "Inactive" })).email, password: PASSWORD },
          { email: (await seedUser({ status: "Suspended" })).email, password: PASSWORD },
        ];

        const results = [];
        for (const body of attempts) results.push(await send("login", { body }));

        for (const sent of results) {
          expect(sent.status).toBe(401);
          expect(sent.setCookie).toBeNull();
        }
        expect(results[0]!.body).toEqual({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
        for (const sent of results) expect(sent.text).toBe(results[0]!.text);
      });

      it.each([
        ["no fields", {}],
        ["no password", { email: "a@example.com" }],
        ["no email", { password: PASSWORD }],
        ["values that are not strings", { email: 1, password: 2 }],
        ["an over-long password", { email: "a@example.com", password: "p".repeat(129) }],
        ["extra fields", { email: "a@example.com", password: PASSWORD, roleName: "Administrator" }],
      ])("rejects %s with 400 and sets no cookie", async (_name, body) => {
        const sent = await send("login", { body });
        expect(sent.status).toBe(400);
        expect(sent.body.error.code).toBe("INVALID_REQUEST");
        expect(sent.setCookie).toBeNull();
      });
    });

    // ------------------------------------------------------------------- logout

    describe("POST /api/auth/logout", () => {
      it("revokes the token and clears the cookie with matching attributes", async () => {
        const { token } = await loginAs(await seedUser());
        expect((await send("me", { cookie: cookieFor(token) })).status).toBe(200);

        const sent = await send("logout", { cookie: cookieFor(token) });

        expect(sent.status).toBe(200);
        expect(sent.setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=;`));
        expect(sent.setCookie).toMatch(/Max-Age=0/);
        expect(sent.setCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
        expectCookieAttributes(sent.setCookie);

        const afterwards = await send("me", { cookie: cookieFor(token) });
        expect(afterwards.status).toBe(401);
        expect(afterwards.body.error.code).toBe("AUTHENTICATION_REQUIRED");
      });

      it("is idempotent: repeated, cookie-less, garbage and expired-token logouts all succeed and clear the cookie", async () => {
        const user = await seedUser();
        const { token } = await loginAs(user);
        const expired = await forgeToken(user, { expiresInSeconds: -60 });

        const cookies = [cookieFor(token), cookieFor(token), undefined, cookieFor("garbage"), cookieFor("a.b.c"), cookieFor(expired)];
        for (const cookie of cookies) {
          const sent = await send("logout", { cookie });
          expect(sent.status).toBe(200);
          expect(sent.body.success).toBe(true);
          expect(sent.setCookie).toMatch(/Max-Age=0/);
        }
      });

      it("refuses a cross-site logout without clearing the cookie or revoking the session", async () => {
        const { token } = await loginAs(await seedUser());

        const sent = await send("logout", { cookie: cookieFor(token), origin: "https://evil.example" });

        expect(sent.status).toBe(403);
        expect(sent.setCookie).toBeNull();
        expect((await send("me", { cookie: cookieFor(token) })).status).toBe(200);
      });
    });

    // ----------------------------------------------------------------------- me

    describe("GET /api/auth/me", () => {
      it("returns the current user's safe data", async () => {
        const user = await seedUser();
        const { token } = await loginAs(user);

        const sent = await send("me", { cookie: cookieFor(token) });

        expect(sent.status).toBe(200);
        expect(sent.body.data.user).toMatchObject({ userId: user.userId, email: user.email, roleName: "Supplier", status: "Active" });
        expect(Object.keys(sent.body.data.user)).not.toContain("passwordHash");
        expect(sent.setCookie).toBeNull();
      });

      it("finds the session cookie among other cookies", async () => {
        const { token } = await loginAs(await seedUser());
        const sent = await send("me", { cookie: `theme=dark; ${COOKIE_NAME}=${token}; lang=am` });
        expect(sent.status).toBe(200);
      });

      it("takes the role from the database, not from the token", async () => {
        const user = await seedUser({ roleName: "Supplier" });
        const { token } = await loginAs(user); // the token carries the Supplier role id
        await world.users.update(user.userId, { roleId: rolesByName["Evaluation Committee"].roleId });

        const sent = await send("me", { cookie: cookieFor(token) });

        expect(sent.status).toBe(200);
        expect(sent.body.data.user.roleName).toBe("Evaluation Committee");
      });

      it("rejects a missing cookie, an empty cookie and garbage with the same generic 401", async () => {
        const responses = [
          await send("me"),
          await send("me", { cookie: `${COOKIE_NAME}=` }),
          await send("me", { cookie: cookieFor("garbage") }),
          await send("me", { cookie: cookieFor("a.b.c") }),
          await send("me", { cookie: cookieFor("x".repeat(5000)) }),
          await send("me", { cookie: "other=value" }),
        ];
        for (const sent of responses) {
          expect(sent.status).toBe(401);
          expect(sent.body).toEqual({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } });
        }
      });

      it("rejects tampered, forged, expired, wrongly addressed and unsigned tokens", async () => {
        const user = await seedUser();
        const { token } = await loginAs(user);
        const [header, payload, signature] = token.split(".") as [string, string, string];
        const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
        const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${payload}.`;

        const bad = [
          `${header}.${payload}.${flipped}`,
          await forgeToken(user, { secret: `${generateId()}${generateId()}` }),
          await forgeToken(user, { expiresInSeconds: -60 }),
          await forgeToken(user, { issuer: "someone-else" }),
          await forgeToken(user, { audience: "another-api" }),
          unsigned,
        ];
        for (const candidate of bad) {
          const sent = await send("me", { cookie: cookieFor(candidate) });
          expect(sent.status).toBe(401);
          expect(sent.body.error.code).toBe("AUTHENTICATION_REQUIRED");
        }
        // The untouched, correctly signed token still works.
        expect((await send("me", { cookie: cookieFor(await forgeToken(user)) })).status).toBe(200);
      });

      it("rejects a revoked token", async () => {
        const { token } = await loginAs(await seedUser());
        await send("logout", { cookie: cookieFor(token) });
        expect((await send("me", { cookie: cookieFor(token) })).status).toBe(401);
      });

      it.each<UserStatus>(["Suspended", "Inactive"])("rejects a session whose account became %s with 403", async (status) => {
        const user = await seedUser();
        const { token } = await loginAs(user);
        await world.users.updateStatus(user.userId, status);

        const sent = await send("me", { cookie: cookieFor(token) });

        expect(sent.status).toBe(403);
        expect(sent.body.error.code).toBe("ACCOUNT_INACTIVE");
      });

      it("rejects a valid token whose account was deleted", async () => {
        const user = await seedUser();
        const { token } = await loginAs(user);
        await world.users.delete(user.userId);

        const sent = await send("me", { cookie: cookieFor(token) });

        expect(sent.status).toBe(401);
        expect(sent.body.error.code).toBe("AUTHENTICATION_REQUIRED");
      });
    });

    // --------------------------------------------------------------------- CSRF

    describe("CSRF: Origin validation on state-changing requests", () => {
      const evilOrigins = [
        ["a foreign site", "https://evil.example"],
        ["the literal string null", "null"],
        ["the same host on another port", "https://procurement.example.org:8443"],
        ["the same host over http", "http://procurement.example.org"],
        ["a sub-domain of the application", "https://evil.procurement.example.org"],
        ["a look-alike suffix", "https://procurement.example.org.evil.example"],
        ["the right origin with a trailing slash", "https://procurement.example.org/"],
        ["an empty value", ""],
      ] as const;

      it.each(["register", "login", "logout"] as const)("%s: a request with no Origin and no Referer is refused", async (path) => {
        const sent = await send(path, { body: { email: "a@example.com", password: PASSWORD, fullName: "A B" }, origin: null });
        expect(sent.status).toBe(403);
        expect(sent.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
        expect(sent.setCookie).toBeNull();
      });

      it.each(evilOrigins)("refuses %s as the Origin on every POST endpoint", async (_name, origin) => {
        const user = await seedUser();
        const email = nextEmail();
        const attempts = [
          send("register", { body: { fullName: "Eve", email, password: PASSWORD }, origin }),
          send("login", { body: { email: user.email, password: PASSWORD }, origin }),
          send("logout", { origin }),
        ];
        for (const sent of await Promise.all(attempts)) {
          expect(sent.status).toBe(403);
          expect(sent.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
          expect(sent.setCookie).toBeNull();
        }
        expect(await world.users.findByEmail(email)).toBeNull();
      });

      it("accepts the exact configured Origin", async () => {
        const user = await seedUser();
        expect((await send("login", { body: { email: user.email, password: PASSWORD }, origin: world.origin })).status).toBe(200);
      });

      it("falls back to the Referer when there is no Origin, and refuses a foreign or unparseable one", async () => {
        const user = await seedUser();
        const body = { email: user.email, password: PASSWORD };

        expect((await send("login", { body, origin: null, referer: `${world.origin}/login?next=/dashboard` })).status).toBe(200);
        expect((await send("login", { body, origin: null, referer: "https://evil.example/login" })).status).toBe(403);
        expect((await send("login", { body, origin: null, referer: "not a url" })).status).toBe(403);
      });

      it("trusts the Origin over the Referer when they disagree", async () => {
        const user = await seedUser();
        const sent = await send("login", {
          body: { email: user.email, password: PASSWORD },
          origin: "https://evil.example",
          referer: `${world.origin}/login`,
        });
        expect(sent.status).toBe(403);
      });

      it("refuses an HTML-form content type even from the right origin, so a plain cross-site form cannot post", async () => {
        const user = await seedUser();
        const sent = await send("login", {
          rawBody: `email=${encodeURIComponent(user.email)}&password=${encodeURIComponent(PASSWORD)}`,
          contentType: "application/x-www-form-urlencoded",
        });
        expect(sent.status).toBe(400);
        expect(sent.setCookie).toBeNull();
      });

      it("does not need an Origin for the read-only GET /me, and never answers with CORS headers", async () => {
        const { token } = await loginAs(await seedUser());
        const sent = await send("me", { cookie: cookieFor(token), origin: "https://evil.example" });
        expect(sent.status).toBe(200); // send() already asserts there is no access-control-* header
      });
    });

    // ------------------------------------------------------------------ caching

    describe("response caching", () => {
      it("marks success and error responses of every endpoint as non-cacheable", async () => {
        const user = await seedUser();
        const { token, sent: loginSent } = await loginAs(user);
        const responses = [
          loginSent,
          await send("login", { body: { email: user.email, password: "wrong password!" } }),
          await send("register", { body: { fullName: "Cache Test", email: nextEmail(), password: PASSWORD } }),
          await send("register", { body: {} }),
          await send("me", { cookie: cookieFor(token) }),
          await send("me"),
          await send("logout", { cookie: cookieFor(token) }),
          await send("logout", { origin: "https://evil.example" }),
        ];
        for (const sent of responses) {
          expect(sent.headers.get("cache-control")).toBe("no-store, max-age=0");
          expect(sent.headers.get("pragma")).toBe("no-cache");
          expect(sent.headers.get("vary")).toBe("Cookie");
        }
      });
    });

    // ----------------------------------------------------------- failure safety

    describe("unexpected failures (failure injection)", () => {
      const heal = () => world.faults?.heal();

      it("hides database errors and credentials, logs the failure, and fails closed", async (context) => {
        if (!world.faults) return context.skip();
        const user = await seedUser();
        const { token } = await loginAs(user);

        // The user store fails during login.
        world.faults.breakUserStore();
        const login = await send("login", { body: { email: user.email, password: PASSWORD } });
        expect(login.status).toBe(500);
        expect(login.body.error).toEqual({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
        expect(login.setCookie).toBeNull();
        expect(world.faults.loggedErrors.length).toBeGreaterThan(0);
        heal();

        // The revocation store fails during authentication: the request must fail, not succeed.
        world.faults.breakRevocationStore();
        const me = await send("me", { cookie: cookieFor(token) });
        expect(me.status).toBe(500);
        expect(me.body.error.code).toBe("INTERNAL_ERROR");

        // ...and during logout: the error is reported, but the browser's cookie is still cleared.
        const logout = await send("logout", { cookie: cookieFor(token) });
        expect(logout.status).toBe(500);
        expect(logout.body.error.code).toBe("INTERNAL_ERROR");
        expect(logout.setCookie).toMatch(/Max-Age=0/);
        heal();
      });
    });
  });
}
