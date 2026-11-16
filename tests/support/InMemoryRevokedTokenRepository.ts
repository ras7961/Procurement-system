import type { RevokedTokenRepositoryInterface } from "@/interfaces/repositories/RevokedTokenRepositoryInterface";

/** Test double for RevokedTokenRepositoryInterface, with failure injection. */
export class InMemoryRevokedTokenRepository implements RevokedTokenRepositoryInterface {
  readonly records = new Map<string, Date>();
  failWith: Error | null = null;
  isRevokedCalls = 0;

  async revoke(tokenId: string, expiresAt: Date): Promise<void> {
    if (this.failWith) throw this.failWith;
    if (!this.records.has(tokenId)) this.records.set(tokenId, expiresAt);
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    this.isRevokedCalls += 1;
    if (this.failWith) throw this.failWith;
    return this.records.has(tokenId);
  }
}
