import { describe, expect, it } from "vitest";
import { InvalidConfigurationException } from "@/entities/exceptions";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";

const base = { MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DB_NAME: "procurement_test" };
const STRONG_SECRET = "Zk3p9Qw8Lm2Xv7Ra5Ty1Hn6Bc4Df0GsJu-_ExampleFree";
const strong = STRONG_SECRET.replace("ExampleFree", "q8W2e9R4t6");

describe("JWT configuration", () => {
  it("applies documented defaults (15 minute access tokens)", () => {
    const settings = new EnvironmentConfiguration({ ...base, NODE_ENV: "development", JWT_SECRET: strong }).getJwtSettings();

    expect(settings).toMatchObject({
      issuer: "procurement-system",
      audience: "procurement-system-api",
      accessTokenTtlSeconds: 900,
      secretSource: "environment",
    });
    expect(settings.secret).toBe(strong);
  });

  it("reads issuer, audience and lifetime from the environment", () => {
    const settings = new EnvironmentConfiguration({
      ...base,
      JWT_SECRET: strong,
      JWT_ISSUER: "issuer-x",
      JWT_AUDIENCE: "audience-y",
      JWT_ACCESS_TOKEN_TTL_SECONDS: "120",
    }).getJwtSettings();

    expect(settings).toMatchObject({ issuer: "issuer-x", audience: "audience-y", accessTokenTtlSeconds: 120 });
  });

  it("keeps the secret out of logs and serialization", () => {
    const settings = new EnvironmentConfiguration({ ...base, JWT_SECRET: strong }).getJwtSettings();

    expect(JSON.stringify(settings)).not.toContain(strong);
    expect(JSON.stringify({ ...settings })).not.toContain(strong);
    expect(Object.keys(settings)).not.toContain("secret");
  });

  describe("production", () => {
    // Stage 1E: APP_ORIGIN is also required in production, so a valid production config includes it.
    const production = { ...base, NODE_ENV: "production", APP_ORIGIN: "https://procurement.example.org" };

    it("is invalid without JWT_SECRET", () => {
      const status = new EnvironmentConfiguration(production).validateConfiguration();
      expect(status.valid).toBe(false);
      expect(status.issues.join(" ")).toContain("JWT_SECRET: is required in production");
      expect(() => new EnvironmentConfiguration(production).getJwtSettings()).toThrow(InvalidConfigurationException);
    });

    it("treats an empty JWT_SECRET (copied .env.example) as missing", () => {
      expect(new EnvironmentConfiguration({ ...production, JWT_SECRET: "" }).validateConfiguration().valid).toBe(false);
    });

    it("rejects short secrets, placeholders and low-variety secrets without echoing them", () => {
      for (const secret of ["short", "x".repeat(40), "changeme-changeme-changeme-changeme-1234", "your-secret-key-your-secret-key-12345", "ab".repeat(20)]) {
        const status = new EnvironmentConfiguration({ ...production, JWT_SECRET: secret }).validateConfiguration();
        expect(status.valid).toBe(false);
        expect(status.issues.join(" ")).toContain("JWT_SECRET");
        expect(JSON.stringify(status)).not.toContain(secret);
      }
    });

    it("accepts a strong secret", () => {
      const configuration = new EnvironmentConfiguration({ ...production, JWT_SECRET: strong });
      expect(configuration.validateConfiguration().valid).toBe(true);
      expect(configuration.getJwtSettings().secretSource).toBe("environment");
    });
  });

  describe("development and test", () => {
    it.each(["development", "test"])("%s: a missing secret is replaced by a random per-process secret, not a fixed one", (environment) => {
      const first = new EnvironmentConfiguration({ ...base, NODE_ENV: environment });
      const second = new EnvironmentConfiguration({ ...base, NODE_ENV: environment });

      expect(first.validateConfiguration().valid).toBe(true);
      const settings = first.getJwtSettings();
      expect(settings.secretSource).toBe("ephemeral");
      expect(settings.secret.length).toBeGreaterThanOrEqual(32);
      expect(first.getJwtSettings().secret).toBe(settings.secret); // stable within the process
      expect(second.getJwtSettings().secret).not.toBe(settings.secret); // different elsewhere
    });

    it("still rejects a secret that is set but too short", () => {
      const status = new EnvironmentConfiguration({ ...base, NODE_ENV: "development", JWT_SECRET: "short" }).validateConfiguration();
      expect(status.valid).toBe(false);
      expect(status.issues.join(" ")).toContain("JWT_SECRET");
      expect(JSON.stringify(status)).not.toContain("short");
    });
  });

  it("bounds the access-token lifetime to 60..3600 seconds", () => {
    for (const ttl of ["59", "3601", "0", "-5", "abc", "90.5"]) {
      const status = new EnvironmentConfiguration({ ...base, JWT_SECRET: strong, JWT_ACCESS_TOKEN_TTL_SECONDS: ttl }).validateConfiguration();
      expect(status.valid, ttl).toBe(false);
      expect(status.issues.join(" ")).toContain("JWT_ACCESS_TOKEN_TTL_SECONDS");
    }
    for (const ttl of ["60", "3600"]) {
      expect(new EnvironmentConfiguration({ ...base, JWT_SECRET: strong, JWT_ACCESS_TOKEN_TTL_SECONDS: ttl }).validateConfiguration().valid).toBe(true);
    }
  });
});
