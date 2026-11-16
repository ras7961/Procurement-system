import type { ConfigurationStatus, DatabaseStatus } from "@/shared/types/health";

/**
 * Port used by CheckSystemHealthUseCase to ask the outside world about its own
 * state. It is a Stage 0 diagnostic contract, not an ODD business interface.
 * An adapter in src/services implements it using the infrastructure classes.
 */
export interface SystemHealthProbe {
  /** Must report setting names only, never values. */
  checkConfiguration(): ConfigurationStatus;
  /** Must not throw: failures are reported as status "down". */
  checkDatabase(): Promise<DatabaseStatus>;
  getEnvironment(): string;
}
