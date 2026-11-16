/** Plain data shapes for the health check. No logic and no imports. */

export type DatabaseState = "up" | "down" | "not_configured";

export interface ConfigurationStatus {
  valid: boolean;
  /** Names of invalid or missing settings. Never contains setting values. */
  issues: string[];
}

export interface DatabaseStatus {
  status: DatabaseState;
  latencyMs?: number;
}

export interface HealthReport {
  status: "healthy" | "unhealthy";
  timestamp: string;
  environment: string;
  checks: {
    application: "up";
    configuration: ConfigurationStatus;
    database: DatabaseStatus;
  };
}
