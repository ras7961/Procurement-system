import argon2 from "argon2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordHashingException } from "@/entities/exceptions";
import { User } from "@/entities/User";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import { Argon2PasswordService } from "@/services/Argon2PasswordService";
import { catchAsyncError, makeRole } from "../support/fixtures";

// Made-up test passwords, not real credentials.
const PASSWORD = "Correct-Horse-Battery-Staple-42";
const OTHER_PASSWORD = "Another-Completely-Different-Pass-7";

const service: PasswordServiceInterface = new Argon2PasswordService();

describe("Argon2PasswordService: hashing", () => {
  it("hashes a password into an Argon2id string that does not contain the password", async () => {
    const hash = await service.hash(PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(PASSWORD);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[\w+/]+\$[\w+/]+$/);
  });

  it("uses the library defaults, which are at least the OWASP minimum (m >= 19 MiB, t >= 2)", async () => {
    const params = (await service.hash(PASSWORD)).split("$")[3] ?? "";
    const { m, t } = Object.fromEntries(params.split(",").map((pair) => pair.split("="))) as Record<string, string>;
    expect(Number(m)).toBeGreaterThanOrEqual(19 * 1024);
    expect(Number(t)).toBeGreaterThanOrEqual(2);
  });

  it("generates a different hash each time for the same password (random salt)", async () => {
    const [first, second] = await Promise.all([service.hash(PASSWORD), service.hash(PASSWORD)]);
    expect(first).not.toBe(second);
    expect(await service.verify(PASSWORD, first)).toBe(true);
    expect(await service.verify(PASSWORD, second)).toBe(true);
  });

  it("refuses to hash an empty or non-string password, with a safe error", async () => {
    for (const input of ["", undefined, null, 12345]) {
      const error = await catchAsyncError(() => service.hash(input as never));
      expect(error).toBeInstanceOf(PasswordHashingException);
      expect(error.message).toBe("The password could not be processed.");
    }
  });

  it("produces a value the User entity accepts as a password hash, and never leaks it", async () => {
    const hash = await service.hash(PASSWORD);
    const user = User.register({
      userId: "u-1",
      fullName: "Abebe Kebede",
      email: "abebe@example.com",
      passwordHash: hash,
      role: makeRole(),
    });

    expect(user.passwordHash).toBe(hash);
    expect(JSON.stringify(user)).not.toContain(hash);
  });
});

describe("Argon2PasswordService: verification", () => {
  it("accepts the correct password", async () => {
    expect(await service.verify(PASSWORD, await service.hash(PASSWORD))).toBe(true);
  });

  it("rejects an incorrect password, including near misses and case changes", async () => {
    const hash = await service.hash(PASSWORD);
    for (const wrong of [OTHER_PASSWORD, PASSWORD.toLowerCase(), `${PASSWORD} `, PASSWORD.slice(0, -1)]) {
      expect(await service.verify(wrong, hash)).toBe(false);
    }
  });

  it("rejects an empty or non-string password without throwing", async () => {
    const hash = await service.hash(PASSWORD);
    for (const input of ["", undefined, null, 12345]) {
      expect(await service.verify(input as never, hash)).toBe(false);
    }
  });

  it("returns false for malformed or unsupported hashes instead of throwing", async () => {
    const real = await service.hash(PASSWORD);
    const argon2i = await argon2.hash(PASSWORD, { type: argon2.argon2i });
    const argon2d = await argon2.hash(PASSWORD, { type: argon2.argon2d });

    const malformed: unknown[] = [
      "",
      " ",
      "garbage",
      "plain text password",
      PASSWORD,
      "$argon2id$",
      "$argon2id$v=19$m=65536,t=3,p=4$bm90LWEtcmVhbC1zYWx0$bm90LWEtcmVhbC1oYXNo",
      real.slice(0, real.length - 10),
      `${real}extra`,
      real.replace("$argon2id$", "$argon2id$v=99$"),
      real.toUpperCase(),
      `${real}\n`,
      "$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      argon2i,
      argon2d,
      undefined,
      null,
      12345,
    ];
    for (const hash of malformed) {
      expect(await service.verify(PASSWORD, hash as never), `hash: ${String(hash).slice(0, 25)}`).toBe(false);
    }
  });

  it("verifies Argon2id hashes made with other parameters by the same library", async () => {
    const custom = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(await service.verify(PASSWORD, custom)).toBe(true);
    expect(await service.verify(OTHER_PASSWORD, custom)).toBe(false);
  });
});

describe("Argon2PasswordService: secrecy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never writes a password or hash to the console", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push(args.map(String).join(" ")));
    }

    const hash = await service.hash(PASSWORD);
    await service.verify(PASSWORD, hash);
    await service.verify(OTHER_PASSWORD, hash);
    await service.verify(PASSWORD, "$argon2id$malformed");
    await catchAsyncError(() => service.hash(""));

    const output = written.join("\n");
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(OTHER_PASSWORD);
    expect(output).not.toContain(hash);
  });

  it("keeps errors free of the password", async () => {
    const error = await catchAsyncError(() => service.hash(""));
    expect(JSON.stringify([error.message, (error as PasswordHashingException).details])).not.toContain(PASSWORD);
  });
});
