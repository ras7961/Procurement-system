/**
 * Centralized application error structure.
 *
 * Every error the application raises on purpose extends AppError. It carries a
 * stable machine-readable `code`, an HTTP status the controllers can map to, and
 * optional `details`. The `message` of an AppError must always be safe to show to
 * a user: never put passwords, tokens, connection strings or other sensitive data
 * in it (ODD design note: "never expose passwords, credentials, tokens ...").
 * Technical detail belongs in `cause` / `details`, which are logged but not
 * returned to clients.
 *
 * This file has no imports: entities stay independent of every framework.
 */

export interface AppErrorOptions {
  /** The underlying error, kept for logging only. */
  cause?: unknown;
  /** Non-sensitive structured context for logs. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  /**
   * `name` is passed in explicitly. Class names are minified in production
   * builds, so `new.target.name` would produce meaningless names like "od".
   */
  constructor(name: string, message: string, code: string, httpStatus: number, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options.details;
  }

  /** The only representation that may be sent to a client. */
  toSafeResponse(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}
