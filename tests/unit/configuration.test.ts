import { describe, expect, it } from "vitest";
import { InvalidConfigurationException, MissingConfigurationException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";

const valid = {
  NODE_ENV: "development",
  MONGODB_URI: "mongodb://user:topsecret@127.0.0.1:27017",
  MONGODB_DB_NAME: "procurement_test",
};

describe("EnvironmentConfiguration", () => {
  it("loads a valid configuration and applies defaults", () => {
    const config = new EnvironmentConfiguration(valid).loadConfiguration();
    expect(config.MONGODB_DB_NAME).toBe("procurement_test");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.MONGODB_SERVER_SELECTION_TIMEOUT_MS).toBe(5000);
  });

  it("coerces numeric settings", () => {
    const config = new EnvironmentConfiguration({ ...valid, MONGODB_SERVER_SELECTION_TIMEOUT_MS: "1500" });
    expect(config.loadConfiguration().MONGODB_SERVER_SELECTION_TIMEOUT_MS).toBe(1500);
  });

  it("reports missing required settings by name", () => {
    const status = new EnvironmentConfiguration({ NODE_ENV: "test" }).validateConfiguration();
    expect(status.valid).toBe(false);
    expect(status.issues.join(" ")).toContain("MONGODB_URI");
    expect(status.issues.join(" ")).toContain("MONGODB_DB_NAME");
  });

  it("treats empty strings as unset (copied .env.example)", () => {
    const status = new EnvironmentConfiguration({ ...valid, MONGODB_URI: "" }).validateConfiguration();
    expect(status.valid).toBe(false);
  });

  it("rejects a connection string with the wrong scheme without echoing it", () => {
    const bad = { ...valid, MONGODB_URI: "postgres://admin:hunter2@host/db" };
    const status = new EnvironmentConfiguration(bad).validateConfiguration();
    expect(status.valid).toBe(false);
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(JSON.stringify(status)).not.toContain("postgres://");
  });

  it("rejects invalid enum and number values", () => {
    expect(new EnvironmentConfiguration({ ...valid, LOG_LEVEL: "verbose" }).validateConfiguration().valid).toBe(false);
    expect(
      new EnvironmentConfiguration({ ...valid, MONGODB_SERVER_SELECTION_TIMEOUT_MS: "-5" }).validateConfiguration().valid,
    ).toBe(false);
  });

  it("throws InvalidConfigurationException from loadConfiguration", () => {
    expect(() => new EnvironmentConfiguration({}).loadConfiguration()).toThrow(InvalidConfigurationException);
  });

  it("getRequiredValue throws MissingConfigurationException for an unset key", () => {
    const config = new EnvironmentConfiguration(valid);
    expect(config.getRequiredValue("MONGODB_DB_NAME")).toBe("procurement_test");
    expect(() => config.getRequiredValue("NOT_SET")).toThrow(MissingConfigurationException);
  });

  it("detects the environment and tolerates unknown values", () => {
    expect(new EnvironmentConfiguration({ NODE_ENV: "production" }).isProduction()).toBe(true);
    expect(new EnvironmentConfiguration({ NODE_ENV: "test" }).getEnvironment()).toBe("test");
    expect(new EnvironmentConfiguration({ NODE_ENV: "weird" }).getEnvironment()).toBe("development");
    expect(new EnvironmentConfiguration({}).isProduction()).toBe(false);
  });
});
