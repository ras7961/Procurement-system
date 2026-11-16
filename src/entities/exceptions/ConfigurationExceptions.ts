import { AppError, type AppErrorOptions } from "./AppError";

/** ODD: EnvironmentConfiguration possible exceptions. */

export class EnvironmentConfigurationException extends AppError {
  constructor(
    message = "The application environment is not configured correctly.",
    options?: AppErrorOptions,
    name = "EnvironmentConfigurationException",
  ) {
    super(name, message, "ENVIRONMENT_CONFIGURATION_ERROR", 500, options);
  }
}

export class MissingConfigurationException extends EnvironmentConfigurationException {
  readonly key: string;

  constructor(key: string) {
    super(`Required configuration value "${key}" is missing.`, { details: { key } }, "MissingConfigurationException");
    this.key = key;
  }
}

export class InvalidConfigurationException extends EnvironmentConfigurationException {
  /** Names of the invalid settings and why, never their values. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super("The application configuration is invalid.", { details: { issues } }, "InvalidConfigurationException");
    this.issues = issues;
  }
}
