/**
 * Application-level contract for password hashing and checking.
 *
 * Use cases (registration, login, change password) depend on this interface, never on a
 * hashing library. Argon2PasswordService (src/services) implements it with Argon2id.
 * The User entity never sees a plain-text password: it only stores the string returned
 * by hash().
 *
 * Rules every implementation must follow:
 *  - Never log, return in an error, or otherwise expose a plain-text password or a hash.
 *  - hash() returns a self-contained string (algorithm, parameters and salt included), and
 *    hashing the same password twice gives different strings (random salt).
 *  - verify() never throws because of bad input or a bad hash. It answers false for a wrong
 *    password, an empty password, and a malformed or unsupported hash.
 */
export interface PasswordServiceInterface {
  /** Hashes a plain-text password. Throws PasswordHashingException if it cannot be processed. */
  hash(plainTextPassword: string): Promise<string>;

  /** True only when `plainTextPassword` matches `passwordHash`. */
  verify(plainTextPassword: string, passwordHash: string): Promise<boolean>;
}
