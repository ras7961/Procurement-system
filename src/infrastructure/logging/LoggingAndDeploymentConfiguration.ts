import type { EnvironmentConfiguration, AppEnvironment } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { ConfigurationStatus } from "@/shared/types/health";
import { redact, sanitizeMessage } from "@/shared/utilities/redact";

/**
 * ODD: infrastructure.LoggingAndDeploymentConfiguration
 *
 * Structured (JSON-lines) logging with secret redaction, plus the small amount of
 * deployment information the ODD assigns to this class. Logging must keep working
 * even when the rest of the configuration is broken, so it reads LOG_LEVEL
 * leniently and never throws.
 */

export type LogLevel = "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(level: LogLevel, line: string): void;
}

const consoleSink: LogSink = {
  write(level, line) {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
};

export class LoggingAndDeploymentConfiguration {
  private level: LogLevel = "info";
  private readonly startedAt = new Date();

  constructor(
    private readonly configuration: EnvironmentConfiguration,
    private readonly sink: LogSink = consoleSink,
  ) {
    this.initializeLogger();
  }

  initializeLogger(): void {
    const requested = this.configuration.getValue("LOG_LEVEL");
    this.level = requested === "warn" || requested === "error" || requested === "info" ? requested : "info";
  }

  logInfo(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  logWarning(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  logError(message: string, error?: unknown, context?: Record<string, unknown>): void {
    this.write("error", message, context, error);
  }

  getLogLevel(): LogLevel {
    return this.level;
  }

  getDeploymentSettings(): { environment: AppEnvironment; logLevel: LogLevel } {
    return { environment: this.configuration.getEnvironment(), logLevel: this.level };
  }

  validateDeploymentConfiguration(): ConfigurationStatus {
    return this.configuration.validateConfiguration();
  }

  getHealthCheckStatus(): { status: "up"; environment: AppEnvironment; startedAt: string } {
    return {
      status: "up",
      environment: this.configuration.getEnvironment(),
      startedAt: this.startedAt.toISOString(),
    };
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>, error?: unknown): void {
    if (SEVERITY[level] < SEVERITY[this.level]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeMessage(message),
    };
    if (context) entry.context = redact(context);
    if (error !== undefined) entry.error = describeError(error);

    this.sink.write(level, JSON.stringify(entry));
  }
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const described: Record<string, unknown> = { name: error.name, message: sanitizeMessage(error.message) };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") described.code = code;
    return described;
  }
  return { message: sanitizeMessage(String(error)) };
}
