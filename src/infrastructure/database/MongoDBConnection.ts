import { MongoClient, type Db } from "mongodb";
import {
  DatabaseConfigurationException,
  DatabaseConnectionException,
  InvalidConfigurationException,
} from "@/entities/exceptions";
import type { AppConfiguration, EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import type { DatabaseStatus } from "@/shared/types/health";

/**
 * ODD: infrastructure.MongoDBConnection
 *
 * The single place in the application that knows how to reach MongoDB. Concrete
 * repositories (src/repositories, added in later stages) receive this class and
 * call getDatabase(). Nothing else may import the MongoDB driver.
 *
 * Connection handling:
 *  - Lazy: no connection is opened until something needs the database.
 *  - Shared: concurrent callers wait on the same pending connection attempt, and
 *    later callers reuse the connected client (the driver pools connections).
 *  - Recoverable: a failed attempt is not cached, so the next call can retry.
 *  - Safe: errors never include the connection string or credentials.
 */
export class MongoDBConnection {
  private client: MongoClient | null = null;
  private pending: Promise<MongoClient> | null = null;

  constructor(
    private readonly configuration: EnvironmentConfiguration,
    private readonly logger: LoggingAndDeploymentConfiguration,
  ) {}

  /** Establishes the connection if it is not already established. */
  async connect(): Promise<void> {
    await this.ensureClient();
  }

  /** Returns the configured database, connecting first if necessary. */
  async getDatabase(): Promise<Db> {
    const client = await this.ensureClient();
    return client.db(this.settings().MONGODB_DB_NAME);
  }

  /** Reports connectivity without throwing. Used by the health check. */
  async checkConnection(): Promise<DatabaseStatus> {
    if (!this.configuration.validateConfiguration().valid) {
      return { status: "not_configured" };
    }

    const startedAt = Date.now();
    try {
      const database = await this.getDatabase();
      await database.command({ ping: 1 });
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.logger.logError("Database health check failed", error);
      return { status: "down" };
    }
  }

  /** Closes the connection. Safe to call when not connected. */
  async closeConnection(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.pending = null;
    if (client) {
      await client.close();
      this.logger.logInfo("MongoDB connection closed");
    }
  }

  private ensureClient(): Promise<MongoClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.pending) return this.pending;

    const attempt = this.openClient().finally(() => {
      this.pending = null;
    });
    this.pending = attempt;
    return attempt;
  }

  private async openClient(): Promise<MongoClient> {
    const settings = this.settings();
    const client = new MongoClient(settings.MONGODB_URI, {
      serverSelectionTimeoutMS: settings.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: 10,
    });

    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      this.logger.logError("MongoDB connection failed", error);
      throw new DatabaseConnectionException({
        cause: error,
        details: { reason: error instanceof Error ? error.name : "UnknownError" },
      });
    }

    this.client = client;
    this.logger.logInfo("MongoDB connection established", { database: settings.MONGODB_DB_NAME });
    return client;
  }

  private settings(): AppConfiguration {
    try {
      return this.configuration.loadConfiguration();
    } catch (error) {
      if (error instanceof InvalidConfigurationException) {
        throw new DatabaseConfigurationException({ cause: error, details: { issues: error.issues } });
      }
      throw error;
    }
  }
}
