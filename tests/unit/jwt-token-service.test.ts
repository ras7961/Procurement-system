import { SignJWT, UnsecuredJWT, type JWTPayload } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthenticationServiceException, DatabaseOperationException, InvalidConfigurationException } from "@/entities/exceptions";
import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { JwtTokenService } from "@/services/JwtTokenService";
import { InMemoryRevokedTokenRepository } from "../support/InMemoryRevokedTokenRepository";
import { catchAsyncError } from "../support/fixtures";

const SECRET = "unit-test-signing-secret-0123456789-abcdefXYZ";
const OTHER_SECRET = "a-completely-different-signing-secret-9876543210";
const START = new Date("2026-06-01T12:00:00.000Z");

function makeSettings(overrides: Partial<Omit<JwtSettings, "secret">> & { secret?: string } = {}): JwtSettings {
  return { secret: SECRET, issuer: "test-issuer", audience: "test-audience", accessTokenTtlSeconds: 900, secretSource: "environment", ...overrides };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const payloadOf = (token: string) => decode(token.split(".")[1] as string);
const headerOf = (token: string) => decode(token.split(".")[0] as string);

describe("JwtTokenService", () => {
  let clock: { now: Date };
  let revoked: InMemoryRevokedTokenRepository;
  let service: JwtTokenService;

  const secondsFromStart = (seconds: number) => Math.floor(START.getTime() / 1000) + seconds;

  /** Signs an arbitrary token with the test secret so verification rules can be probed one at a time. */
  async function craft(options: { omit?: string; alg?: string; secret?: string; issuer?: string; audience?: string; typ?: string; iat?: number; exp?: number } = {}) {
    const payload: JWTPayload = { roleId: "role-1" };
    const iat = options.iat ?? secondsFromStart(0);
    const builder = new SignJWT(payload)
      .setProtectedHeader({ alg: options.alg ?? "HS256", typ: options.typ ?? "JWT" })
      .setSubject("user-1")
      .setJti("jti-crafted")
      .setIssuedAt(iat)
      .setExpirationTime(options.exp ?? secondsFromStart(900))
      .setIssuer(options.issuer ?? "test-issuer")
      .setAudience(options.audience ?? "test-audience");
    const token = await builder.sign(new TextEncoder().encode(options.secret ?? SECRET));
    if (!options.omit) return token;
    // Rebuild without one claim, re-signed so only the missing claim is wrong.
    const [header, body] = token.split(".") as [string, string];
    const claims = decode(body);
    delete claims[options.omit];
    return signRaw(decode(header), claims, options.secret ?? SECRET);
  }

  async function signRaw(header: Record<string, unknown>, claims: Record<string, unknown>, secret: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode(header)}.${encode(claims)}`;
    return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
  }

  beforeEach(() => {
    clock = { now: new Date(START) };
    revoked = new InMemoryRevokedTokenRepository();
    service = new JwtTokenService(() => makeSettings(), revoked, { now: () => clock.now });
  });

  describe("issuance", () => {
    it("returns a signed JWT and its expiry", async () => {
      const issued = await service.issue({ userId: "user-1", roleId: "role-1" });

      expect(issued.token.split(".")).toHaveLength(3);
      expect(issued.expiresAt).toEqual(new Date(START.getTime() + 900_000));
      expect(headerOf(issued.token)).toEqual({ alg: "HS256", typ: "JWT" });
    });

    it("contains exactly the necessary claims", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      const payload = payloadOf(token);

      expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "roleId", "sub"]);
      expect(payload).toMatchObject({
        sub: "user-1",
        roleId: "role-1",
        iss: "test-issuer",
        aud: "test-audience",
        iat: secondsFromStart(0),
        exp: secondsFromStart(900),
      });
      expect(typeof payload.jti).toBe("string");
    });

    it("never puts secrets or personal data in the token", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      const decoded = JSON.stringify([headerOf(token), payloadOf(token)]);

      expect(token).not.toContain(SECRET);
      expect(decoded).not.toMatch(/password|hash|email|argon2|fullName|name/i);
    });

    it("gives every token a unique id", async () => {
      const ids = new Set<unknown>();
      for (let i = 0; i < 100; i += 1) ids.add(payloadOf((await service.issue({ userId: "user-1", roleId: "role-1" })).token).jti);
      expect(ids.size).toBe(100);
    });

    it("uses the configured lifetime", async () => {
      const short = new JwtTokenService(() => makeSettings({ accessTokenTtlSeconds: 60 }), revoked, { now: () => clock.now });
      const { token, expiresAt } = await short.issue({ userId: "user-1", roleId: "role-1" });

      expect(payloadOf(token).exp).toBe(secondsFromStart(60));
      expect(expiresAt).toEqual(new Date(START.getTime() + 60_000));
    });

    it("refuses incomplete claims", async () => {
      for (const claims of [{ userId: "", roleId: "r" }, { userId: "u", roleId: "" }, undefined, { userId: 5, roleId: "r" }]) {
        expect(await catchAsyncError(() => service.issue(claims as never))).toBeInstanceOf(AuthenticationServiceException);
      }
    });
  });

  describe("verification", () => {
    it("accepts a valid token and returns its claims", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      expect(await service.verify(token)).toEqual({ userId: "user-1", roleId: "role-1" });
    });

    it("rejects an expired token, and accepts it until the last second", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });

      clock.now = new Date(START.getTime() + 899_000);
      expect(await service.verify(token)).not.toBeNull();
      clock.now = new Date(START.getTime() + 900_000);
      expect(await service.verify(token)).toBeNull();
      clock.now = new Date(START.getTime() + 3_600_000);
      expect(await service.verify(token)).toBeNull();
    });

    it("rejects a token signed with another secret", async () => {
      expect(await service.verify(await craft({ secret: OTHER_SECRET }))).toBeNull();
    });

    it("rejects a token whose payload was tampered with", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      const [header, , signature] = token.split(".") as [string, string, string];
      const forged = Buffer.from(JSON.stringify({ ...payloadOf(token), sub: "admin-user" })).toString("base64url");

      expect(await service.verify(`${header}.${forged}.${signature}`)).toBeNull();
    });

    it("rejects a wrong issuer and a wrong audience", async () => {
      expect(await service.verify(await craft({ issuer: "someone-else" }))).toBeNull();
      expect(await service.verify(await craft({ audience: "another-api" }))).toBeNull();
      expect(await service.verify(await craft())).not.toBeNull(); // the control: the crafted token is otherwise valid
    });

    it("rejects unsupported algorithms, even when signed with the right secret", async () => {
      expect(await service.verify(await craft({ alg: "HS512" }))).toBeNull();
      expect(await service.verify(await craft({ alg: "HS384" }))).toBeNull();

      const none = new UnsecuredJWT({ roleId: "role-1" })
        .setSubject("user-1")
        .setJti("j")
        .setIssuedAt(secondsFromStart(0))
        .setExpirationTime(secondsFromStart(900))
        .setIssuer("test-issuer")
        .setAudience("test-audience")
        .encode();
      expect(await service.verify(none)).toBeNull();
    });

    it("rejects malformed input without throwing and without touching the revocation store", async () => {
      for (const token of ["", " ", "abc", "a.b", "a.b.c", "..", "x.y.z.w", "x".repeat(5000), 123, null, undefined, {}]) {
        expect(await service.verify(token as never), String(token)).toBeNull();
      }
      expect(revoked.isRevokedCalls).toBe(0);
    });

    it.each(["sub", "jti", "iat", "exp", "iss", "aud", "roleId"])("rejects a token missing the %s claim", async (claim) => {
      expect(await service.verify(await craft({ omit: claim }))).toBeNull();
    });

    it("rejects a wrong token type header and an issued-in-the-future token", async () => {
      expect(await service.verify(await craft({ typ: "at+jwt" }))).toBeNull();
      expect(await service.verify(await craft({ iat: secondsFromStart(3600), exp: secondsFromStart(4500) }))).toBeNull();
    });
  });

  describe("revocation", () => {
    it("makes a revoked token fail verification, and leaves other tokens alone", async () => {
      const first = await service.issue({ userId: "user-1", roleId: "role-1" });
      const second = await service.issue({ userId: "user-1", roleId: "role-1" });

      await service.revoke(first.token);

      expect(await service.verify(first.token)).toBeNull();
      expect(await service.verify(second.token)).not.toBeNull();
    });

    it("stores only the token id and expiry, never the token", async () => {
      const { token, expiresAt } = await service.issue({ userId: "user-1", roleId: "role-1" });
      await service.revoke(token);

      expect([...revoked.records.entries()]).toEqual([[payloadOf(token).jti, expiresAt]]);
      expect(JSON.stringify([...revoked.records.entries()])).not.toContain(token);
    });

    it("is idempotent", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      await service.revoke(token);
      await service.revoke(token);
      await Promise.all([service.revoke(token), service.revoke(token)]);

      expect(revoked.records.size).toBe(1);
      expect(await service.verify(token)).toBeNull();
    });

    it("ignores unknown, malformed, forged and expired tokens without creating records", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      clock.now = new Date(START.getTime() + 901_000);

      for (const candidate of ["garbage", "", await craft({ secret: OTHER_SECRET }), token, undefined]) {
        await expect(service.revoke(candidate as never)).resolves.toBeUndefined();
      }
      expect(revoked.records.size).toBe(0);
    });

    it("does not let a database failure silently pass a token", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      revoked.failWith = new DatabaseOperationException();

      expect(await catchAsyncError(() => service.verify(token))).toBeInstanceOf(DatabaseOperationException);
    });

    it("reports a failure to store a revocation instead of pretending it worked", async () => {
      const { token } = await service.issue({ userId: "user-1", roleId: "role-1" });
      revoked.failWith = new DatabaseOperationException();

      expect(await catchAsyncError(() => service.revoke(token))).toBeInstanceOf(DatabaseOperationException);
    });

    it("rejects an invalid token without needing the database, even while it is down", async () => {
      revoked.failWith = new DatabaseOperationException();
      expect(await service.verify("garbage")).toBeNull();
    });
  });

  describe("settings", () => {
    it("are read on first use, not when the service is created", async () => {
      let reads = 0;
      const lazy = new JwtTokenService(() => { reads += 1; return makeSettings(); }, revoked, { now: () => clock.now });
      expect(reads).toBe(0);

      await lazy.issue({ userId: "u", roleId: "r" });
      await lazy.issue({ userId: "u", roleId: "r" });
      expect(reads).toBe(1);
    });

    it("refuse a secret shorter than 32 characters, without echoing it", async () => {
      const weak = new JwtTokenService(() => makeSettings({ secret: "too-short" }), revoked);
      const error = await catchAsyncError(() => weak.issue({ userId: "u", roleId: "r" }));

      expect(error).toBeInstanceOf(InvalidConfigurationException);
      expect(JSON.stringify((error as InvalidConfigurationException).toSafeResponse())).not.toContain("too-short");
    });

    it("pass on a configuration failure instead of verifying with a default", async () => {
      const broken = new JwtTokenService(() => { throw new InvalidConfigurationException(["JWT_SECRET: is required in production"]); }, revoked);
      expect(await catchAsyncError(() => broken.verify("a.b.c"))).toBeInstanceOf(InvalidConfigurationException);
    });

    it("announce a temporary secret exactly once", async () => {
      let notices = 0;
      const ephemeral = new JwtTokenService(() => makeSettings({ secretSource: "ephemeral" }), revoked, { onEphemeralSecret: () => { notices += 1; } });

      await ephemeral.issue({ userId: "u", roleId: "r" });
      await ephemeral.issue({ userId: "u", roleId: "r" });
      expect(notices).toBe(1);
    });
  });
});
