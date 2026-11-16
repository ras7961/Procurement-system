import { PasswordHashingException } from "@/entities/exceptions";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import type { AuthTokenClaims, IssuedToken, TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";

/**
 * Fast stand-in for Argon2PasswordService. It is NOT secure and only exists in tests. It records
 * every verify() call so tests can check what was verified against what.
 */
export class FakePasswordService implements PasswordServiceInterface {
  readonly verifyCalls: Array<{ password: string; hash: string }> = [];
  failWith: Error | null = null;

  async hash(plainTextPassword: string): Promise<string> {
    if (this.failWith) throw this.failWith;
    return `$argon2id$fake$${Buffer.from(plainTextPassword).toString("base64")}$${"x".repeat(10)}`;
  }

  async verify(plainTextPassword: string, passwordHash: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    this.verifyCalls.push({ password: plainTextPassword, hash: passwordHash });
    return passwordHash === (await this.hash(plainTextPassword));
  }

  breakLibrary(): void {
    this.failWith = new PasswordHashingException();
  }
}

/** In-memory token service: tokens are random strings, revoked ones stop verifying. */
export class FakeTokenService implements TokenServiceInterface {
  readonly issued = new Map<string, AuthTokenClaims>();
  readonly revoked: string[] = [];
  failWith: Error | null = null;
  private counter = 0;

  async issue(claims: AuthTokenClaims): Promise<IssuedToken> {
    if (this.failWith) throw this.failWith;
    this.counter += 1;
    const token = `test-token-${this.counter}`;
    this.issued.set(token, claims);
    return { token, expiresAt: new Date("2030-01-01T00:00:00.000Z") };
  }

  async verify(token: string): Promise<AuthTokenClaims | null> {
    return this.revoked.includes(token) ? null : (this.issued.get(token) ?? null);
  }

  async revoke(token: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.revoked.push(token);
  }
}
