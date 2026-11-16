import type { SystemHealthProbe } from "@/interfaces/services/SystemHealthProbe";
import type { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type { ConfigurationStatus, DatabaseStatus } from "@/shared/types/health";

/**
 * Implements SystemHealthProbe on top of the infrastructure classes.
 *
 * In production the names of invalid settings are hidden from the response so the
 * public endpoint does not reveal how the deployment is configured; they are
 * still written to the server log.
 */
export class SystemHealthProbeAdapter implements SystemHealthProbe {
  constructor(
    private readonly configuration: EnvironmentConfiguration,
    private readonly database: MongoDBConnection,
  ) {}

  checkConfiguration(): ConfigurationStatus {
    const status = this.configuration.validateConfiguration();
    return this.configuration.isProduction() ? { valid: status.valid, issues: [] } : status;
  }

  checkDatabase(): Promise<DatabaseStatus> {
    return this.database.checkConnection();
  }

  getEnvironment(): string {
    return this.configuration.getEnvironment();
  }
}
