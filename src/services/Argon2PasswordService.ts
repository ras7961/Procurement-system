import { PasswordHashingException } from "@/entities/exceptions";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";

type Argon2Module = typeof import("argon2");

/** Every hash this service creates, and the only kind it will verify, starts with this. */
const ARGON2ID_PREFIX = "$argon2id$";

/**
 * PasswordServiceInterface implemented with Argon2id (the `argon2` npm package, which wraps
 * the reference C implementation).
 *
 * Parameters: the package defaults are used on purpose. For argon2 0.45 they are memory 64 MiB,
 * 3 passes and 4 lanes, which is above the OWASP minimum (19 MiB, 2 passes, 1 lane). Only the
 * type is set explicitly, to Argon2id, so a future change of the library default cannot change
 * the algorithm silently. Re-check the defaults against the OWASP Password Storage Cheat Sheet
 * when upgrading the package.
 *
 * The library is loaded on first use, so importing this file (for example through the
 * composition root during a health check) does not load the native module.
 *
 * This class never logs and never puts a password or hash into an error.
 */
export class Argon2PasswordService implements PasswordServiceInterface {
  #library: Promise<Argon2Module> | null = null;

  async hash(plainTextPassword: string): Promise<string> {
    if (typeof plainTextPassword !== "string" || plainTextPassword.length === 0) {
      throw new PasswordHashingException({ details: { reason: "empty or invalid password input" } });
    }

    const argon2 = await this.#load();
    try {
      return await argon2.hash(plainTextPassword, { type: argon2.argon2id });
    } catch (error) {
      throw new PasswordHashingException({ details: { reason: errorName(error) } });
    }
  }

  async verify(plainTextPassword: string, passwordHash: string): Promise<boolean> {
    if (
      typeof plainTextPassword !== "string" ||
      plainTextPassword.length === 0 ||
      typeof passwordHash !== "string" ||
      !passwordHash.startsWith(ARGON2ID_PREFIX)
    ) {
      return false;
    }

    // A library that fails to load is a server problem, not a wrong password, so it is
    // thrown rather than reported as false.
    const argon2 = await this.#load();
    try {
      return await argon2.verify(passwordHash, plainTextPassword);
    } catch {
      // Malformed or corrupted hash: indistinguishable from a wrong password to the caller.
      return false;
    }
  }

  #load(): Promise<Argon2Module> {
    this.#library ??= import("argon2").catch((error: unknown) => {
      this.#library = null;
      throw new PasswordHashingException({ details: { reason: errorName(error) } });
    });
    return this.#library;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
