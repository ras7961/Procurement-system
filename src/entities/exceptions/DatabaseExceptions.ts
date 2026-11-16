import { AppError, type AppErrorOptions } from "./AppError";

/** ODD: MongoDBConnection and repository possible exceptions. */

export class DatabaseConfigurationException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "DatabaseConfigurationException",
      "The database is not configured correctly.",
      "DATABASE_CONFIGURATION_ERROR",
      500,
      options,
    );
  }
}

export class DatabaseConnectionException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("DatabaseConnectionException", "Unable to connect to the database.", "DATABASE_CONNECTION_ERROR", 503, options);
  }
}

export class DatabaseUnavailableException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("DatabaseUnavailableException", "The database is currently unavailable.", "DATABASE_UNAVAILABLE", 503, options);
  }
}

export class DatabaseOperationException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("DatabaseOperationException", "A database operation failed.", "DATABASE_OPERATION_ERROR", 500, options);
  }
}
