import { describe, expect, it } from "vitest";
import {
  AppError,
  DatabaseConnectionException,
  InvalidConfigurationException,
  MissingConfigurationException,
} from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import {
  LoggingAndDeploymentConfiguration,
  type LogLevel,
} from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import { redact, sanitizeMessage } from "@/shared/utilities/redact";

describe("AppError hierarchy", () => {
  it("carries code, status and name, and only exposes a safe response", () => {
    const cause = new Error("raw driver failure with mongodb://u:p@host");
    const error = new DatabaseConnectionException({ cause, details: { reason: "MongoServerSelectionError" } });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DatabaseConnectionException");
    expect(error.httpStatus).toBe(503);
    expect(error.cause).toBe(cause);
    expect(error.toSafeResponse()).toEqual({ code: "DATABASE_CONNECTION_ERROR", message: "Unable to connect to the database." });
    expect(JSON.stringify(error.toSafeResponse())).not.toContain("mongodb://");
  });

  it("configuration exceptions describe the problem without values", () => {
    const missing = new MissingConfigurationException("MONGODB_URI");
    expect(missing.key).toBe("MONGODB_URI");
    expect(missing.message).toContain("MONGODB_URI");

    const invalid = new InvalidConfigurationException(["MONGODB_URI: is required"]);
    expect(invalid.issues).toEqual(["MONGODB_URI: is required"]);
    expect(invalid.httpStatus).toBe(500);
  });
});

describe("redaction", () => {
  it("masks connection strings in free text", () => {
    expect(sanitizeMessage("failed for mongodb+srv://admin:pw@cluster.example.net/db")).toBe(
      "failed for [redacted-connection-string]",
    );
    expect(sanitizeMessage("no secrets here")).toBe("no secrets here");
  });

  it("masks sensitive keys recursively and keeps harmless ones", () => {
    const result = redact({ user: "ana", password: "x", nested: { apiKey: "k", token: "t", note: "hi" }, list: [{ secret: "s" }] });
    expect(result).toEqual({
      user: "ana",
      password: "[redacted]",
      nested: { apiKey: "[redacted]", token: "[redacted]", note: "hi" },
      list: [{ secret: "[redacted]" }],
    });
  });
});

describe("LoggingAndDeploymentConfiguration", () => {
  function createLogger(env: Record<string, string>) {
    const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
    const logger = new LoggingAndDeploymentConfiguration(new EnvironmentConfiguration(env), {
      write: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
    });
    return { logger, lines };
  }

  it("writes structured JSON at the configured level", () => {
    const { logger, lines } = createLogger({ LOG_LEVEL: "warn" });
    logger.logInfo("hidden");
    logger.logWarning("visible", { tender: "T-1" });
    logger.logError("boom", new Error("bad"), { step: 2 });

    expect(logger.getLogLevel()).toBe("warn");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
    expect(lines[0]?.entry).toMatchObject({ level: "warn", message: "visible", context: { tender: "T-1" } });
    expect(lines[1]?.entry).toMatchObject({ error: { name: "Error", message: "bad" } });
    expect(typeof lines[0]?.entry.timestamp).toBe("string");
  });

  it("never writes secrets", () => {
    const { logger, lines } = createLogger({});
    logger.logInfo("connecting to mongodb://admin:hunter2@db", { password: "hunter2", MONGODB_URI: "mongodb://a:b@c" });
    logger.logError("failed", new Error("cannot reach mongodb://admin:hunter2@db:27017"));
    const output = JSON.stringify(lines);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("admin:");
  });

  it("falls back to info for an invalid level and keeps working with broken configuration", () => {
    const { logger, lines } = createLogger({ LOG_LEVEL: "nonsense" });
    logger.logInfo("still works");
    expect(logger.getLogLevel()).toBe("info");
    expect(lines).toHaveLength(1);
  });

  it("reports deployment settings and a running status", () => {
    const { logger } = createLogger({ NODE_ENV: "production", LOG_LEVEL: "error" });
    expect(logger.getDeploymentSettings()).toEqual({ environment: "production", logLevel: "error" });
    expect(logger.getHealthCheckStatus()).toMatchObject({ status: "up", environment: "production" });
    expect(logger.validateDeploymentConfiguration().valid).toBe(false);
  });
});
