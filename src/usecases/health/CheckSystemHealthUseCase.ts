import type { SystemHealthProbe } from "@/interfaces/services/SystemHealthProbe";
import type { DatabaseStatus, HealthReport } from "@/shared/types/health";

/**
 * Stage 0 diagnostic use case: is the application running, is its configuration
 * valid, and can it reach its database?
 *
 * The database is only checked when the configuration is valid, so a broken
 * configuration never triggers a pointless connection attempt.
 */
export class CheckSystemHealthUseCase {
  constructor(
    private readonly probe: SystemHealthProbe,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<HealthReport> {
    const configuration = this.probe.checkConfiguration();

    let database: DatabaseStatus = { status: "not_configured" };
    if (configuration.valid) {
      try {
        database = await this.probe.checkDatabase();
      } catch {
        // The probe contract says it must not throw; this guards against a faulty adapter.
        database = { status: "down" };
      }
    }

    const healthy = configuration.valid && database.status === "up";
    return {
      status: healthy ? "healthy" : "unhealthy",
      timestamp: this.now().toISOString(),
      environment: this.probe.getEnvironment(),
      checks: { application: "up", configuration, database },
    };
  }
}
