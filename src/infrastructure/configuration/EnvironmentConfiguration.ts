import { randomBytes } from "node:crypto";
import { z } from "zod";
import { InvalidConfigurationException, MissingConfigurationException } from "@/entities/exceptions";
import type { ConfigurationStatus } from "@/shared/types/health";

/**
 * ODD: infrastructure.EnvironmentConfiguration
 *
 * Reads environment variables, validates them once, and gives the rest of the
 * infrastructure typed, validated access. Secrets are never hard-coded; they come
 * only from the environment (.env.local in development).
 *
 * Validation problems are reported by setting name only. Values are never
 * included, so reports are safe to log or return from the health endpoint.
 */

export type AppEnvironment = "development" | "test" | "production";

/** Authentication tokens. See the JWT_* variables in .env.example. */
export const JWT_SECRET_MIN_LENGTH = 32;
export const JWT_TTL_MIN_SECONDS = 60;
export const JWT_TTL_MAX_SECONDS = 3600;
export const JWT_TTL_DEFAULT_SECONDS = 900;

/** The application's own origin, used to reject cross-site requests (CSRF). See APP_ORIGIN in .env.example. */
export const DEFAULT_APP_ORIGIN = "http://localhost:3000";

/** True for a bare http(s) origin: scheme, host and optional port, with no path, query or trailing slash. */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

const PLACEHOLDER_SECRET = /change.?me|replace|placeholder|your[-_ ]?(secret|key)|example|secret.?secret|password/i;

/** A secret that is long enough but obviously not random (a placeholder, or very few distinct characters). */
function isWeakSecret(secret: string): boolean {
  return PLACEHOLDER_SECRET.test(secret) || new Set(secret).size < 10;
}

const configurationSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["info", "warn", "error"]).default("info"),
    MONGODB_URI: z
      .string()
      .min(1, "is required")
      .refine((value) => /^mongodb(\+srv)?:\/\//.test(value), "must start with mongodb:// or mongodb+srv://"),
    MONGODB_DB_NAME: z.string().min(1, "is required"),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    // Required in production (see the rule below). Optional elsewhere: a temporary secret is generated.
    JWT_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH, `must be at least ${JWT_SECRET_MIN_LENGTH} characters`).optional(),
    // Required in production (see the rule below). Elsewhere it defaults to DEFAULT_APP_ORIGIN.
    APP_ORIGIN: z
      .string()
      .refine(isHttpOrigin, "must be an origin such as https://procurement.example.org (no path, no trailing slash)")
      .optional(),
    JWT_ISSUER: z.string().min(1, "must not be empty").default("procurement-system"),
    JWT_AUDIENCE: z.string().min(1, "must not be empty").default("procurement-system-api"),
    JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int("must be a whole number of seconds")
      .min(JWT_TTL_MIN_SECONDS, `must be at least ${JWT_TTL_MIN_SECONDS} seconds`)
      .max(JWT_TTL_MAX_SECONDS, `must be at most ${JWT_TTL_MAX_SECONDS} seconds (access tokens are short-lived)`)
      .default(JWT_TTL_DEFAULT_SECONDS),
  })
  .superRefine((configuration, context) => {
    if (configuration.NODE_ENV !== "production") return;
    if (configuration.APP_ORIGIN === undefined) {
      context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "is required in production" });
    }
    if (configuration.JWT_SECRET === undefined) {
      context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "is required in production" });
    } else if (isWeakSecret(configuration.JWT_SECRET)) {
      context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "is too weak for production: use a long random value" });
    }
  });

export type AppConfiguration = z.infer<typeof configurationSchema>;

/**
 * Validated settings for JwtTokenService. `secret` is not enumerable, so logging or
 * serializing the object never prints it.
 */
export interface JwtSettings {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  /** "ephemeral" means JWT_SECRET was not set (development/test only): tokens stop working on restart. */
  readonly secretSource: "environment" | "ephemeral";
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export class EnvironmentConfiguration {
  private readonly source: EnvironmentSource;
  private loaded: AppConfiguration | null = null;
  private ephemeralSecret: string | null = null;

  constructor(source: EnvironmentSource = process.env) {
    // Treat empty strings (e.g. "MONGODB_URI=" in a copied .env.example) as unset.
    this.source = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  }

  /** Validates and returns the full configuration. Throws InvalidConfigurationException. */
  loadConfiguration(): AppConfiguration {
    if (this.loaded) return this.loaded;

    const result = configurationSchema.safeParse(this.source);
    if (!result.success) {
      throw new InvalidConfigurationException(describeIssues(result.error.issues));
    }
    this.loaded = result.data;
    return this.loaded;
  }

  /**
   * The JWT settings. Throws InvalidConfigurationException when the configuration is invalid
   * (in production that includes a missing or weak JWT_SECRET).
   *
   * Outside production, a missing JWT_SECRET is replaced by a random secret that lives only in
   * this process. There is no fixed fallback secret anywhere.
   */
  getJwtSettings(): JwtSettings {
    const configuration = this.loadConfiguration();
    let secret = configuration.JWT_SECRET;
    let secretSource: JwtSettings["secretSource"] = "environment";
    if (secret === undefined) {
      this.ephemeralSecret ??= randomBytes(48).toString("base64url");
      secret = this.ephemeralSecret;
      secretSource = "ephemeral";
    }
    const settings = {
      issuer: configuration.JWT_ISSUER,
      audience: configuration.JWT_AUDIENCE,
      accessTokenTtlSeconds: configuration.JWT_ACCESS_TOKEN_TTL_SECONDS,
      secretSource,
    };
    return Object.defineProperty(settings, "secret", { value: secret, enumerable: false }) as JwtSettings;
  }

  /**
   * The one origin from which state-changing requests are accepted (Origin check against CSRF).
   * Throws InvalidConfigurationException when the configuration is invalid; in production that
   * includes a missing or malformed APP_ORIGIN.
   */
  getAppOrigin(): string {
    return this.loadConfiguration().APP_ORIGIN ?? DEFAULT_APP_ORIGIN;
  }

  /** Returns a raw value, or undefined when it is not set. */
  getValue(key: string): string | undefined {
    return this.source[key];
  }

  /** Returns a raw value, or throws MissingConfigurationException. */
  getRequiredValue(key: string): string {
    const value = this.getValue(key);
    if (value === undefined) throw new MissingConfigurationException(key);
    return value;
  }

  /** Non-throwing validation, suitable for the health check. */
  validateConfiguration(): ConfigurationStatus {
    const result = configurationSchema.safeParse(this.source);
    return result.success ? { valid: true, issues: [] } : { valid: false, issues: describeIssues(result.error.issues) };
  }

  /** Works even when the rest of the configuration is invalid. */
  getEnvironment(): AppEnvironment {
    const value = this.getValue("NODE_ENV");
    return value === "production" || value === "test" ? value : "development";
  }

  isProduction(): boolean {
    return this.getEnvironment() === "production";
  }
}

function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "configuration"}: ${issue.message}`);
}
