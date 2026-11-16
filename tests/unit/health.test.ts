import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthController } from "@/controllers/HealthController";
import { createContainer } from "@/infrastructure/container";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { SystemHealthProbe } from "@/interfaces/services/SystemHealthProbe";
import { SystemHealthProbeAdapter } from "@/services/SystemHealthProbeAdapter";
import type { ConfigurationStatus, DatabaseStatus } from "@/shared/types/health";
import { CheckSystemHealthUseCase } from "@/usecases/health/CheckSystemHealthUseCase";

function fakeProbe(configuration: ConfigurationStatus, database: DatabaseStatus | Error) {
  const checkDatabase = vi.fn(async () => {
    if (database instanceof Error) throw database;
    return database;
  });
  const probe: SystemHealthProbe = {
    checkConfiguration: () => configuration,
    checkDatabase,
    getEnvironment: () => "test",
  };
  return { probe, checkDatabase };
}

const fixedNow = () => new Date("2026-11-10T00:00:00.000Z");

describe("CheckSystemHealthUseCase", () => {
  it("is healthy when configuration is valid and the database is up", async () => {
    const { probe } = fakeProbe({ valid: true, issues: [] }, { status: "up", latencyMs: 3 });
    const report = await new CheckSystemHealthUseCase(probe, fixedNow).execute();
    expect(report).toEqual({
      status: "healthy",
      timestamp: "2026-11-10T00:00:00.000Z",
      environment: "test",
      checks: { application: "up", configuration: { valid: true, issues: [] }, database: { status: "up", latencyMs: 3 } },
    });
  });

  it("is unhealthy and skips the database check when configuration is invalid", async () => {
    const { probe, checkDatabase } = fakeProbe({ valid: false, issues: ["MONGODB_URI: is required"] }, { status: "up" });
    const report = await new CheckSystemHealthUseCase(probe, fixedNow).execute();
    expect(report.status).toBe("unhealthy");
    expect(report.checks.database.status).toBe("not_configured");
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("is unhealthy when the database is down", async () => {
    const { probe } = fakeProbe({ valid: true, issues: [] }, { status: "down" });
    expect((await new CheckSystemHealthUseCase(probe).execute()).status).toBe("unhealthy");
  });

  it("treats a throwing probe as database down instead of crashing", async () => {
    const { probe } = fakeProbe({ valid: true, issues: [] }, new Error("adapter bug"));
    const report = await new CheckSystemHealthUseCase(probe).execute();
    expect(report.checks.database.status).toBe("down");
    expect(report.status).toBe("unhealthy");
  });
});

describe("HealthController", () => {
  it("maps healthy to 200 and unhealthy to 503", async () => {
    const healthy = fakeProbe({ valid: true, issues: [] }, { status: "up" }).probe;
    const unhealthy = fakeProbe({ valid: true, issues: [] }, { status: "down" }).probe;
    expect((await new HealthController(new CheckSystemHealthUseCase(healthy)).getHealth()).statusCode).toBe(200);
    expect((await new HealthController(new CheckSystemHealthUseCase(unhealthy)).getHealth()).statusCode).toBe(503);
  });
});

describe("SystemHealthProbeAdapter", () => {
  it("hides the names of invalid settings in production", () => {
    const configuration = new EnvironmentConfiguration({ NODE_ENV: "production" });
    const probe = new SystemHealthProbeAdapter(configuration, {} as never);
    expect(probe.checkConfiguration()).toEqual({ valid: false, issues: [] });
  });

  it("lists the names of invalid settings outside production", () => {
    const configuration = new EnvironmentConfiguration({ NODE_ENV: "development" });
    const probe = new SystemHealthProbeAdapter(configuration, {} as never);
    expect(probe.checkConfiguration().issues.join(" ")).toContain("MONGODB_URI");
  });
});

describe("composition root", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports unhealthy without attempting a connection when configuration is missing", async () => {
    const { healthController } = createContainer({ NODE_ENV: "test" });
    const { statusCode, body } = await healthController.getHealth();
    expect(statusCode).toBe(503);
    expect(body.checks.configuration.valid).toBe(false);
    expect(body.checks.database.status).toBe("not_configured");
  });

  it("reports the database as down, without leaking credentials, when MongoDB is unreachable", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logged.push(String(line)));

    const { healthController, mongoDB } = createContainer({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://admin:SuperSecretPw@127.0.0.1:1",
      MONGODB_DB_NAME: "procurement_test",
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: "300",
    });

    const { statusCode, body } = await healthController.getHealth();
    await mongoDB.closeConnection();

    expect(statusCode).toBe(503);
    expect(body.checks.configuration.valid).toBe(true);
    expect(body.checks.database.status).toBe("down");
    expect(JSON.stringify(body)).not.toContain("SuperSecretPw");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("SuperSecretPw");
  });
});
