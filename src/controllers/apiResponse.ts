import { AppError, RoleNotFoundException } from "@/entities/exceptions";

/**
 * The JSON shape every authentication endpoint returns, and the one place that turns errors into
 * responses. Uses only the standard Web `Response`, so no framework is imported.
 *
 * Success: { success: true,  data, message }
 * Error:   { success: false, error: { code, message } }
 *
 * What may leave the application: an AppError below HTTP 500 shows its own code and message (both
 * are written to be safe for users). Everything else, including every 5xx, becomes a generic
 * message. Stack traces, database errors, tokens, hashes and secrets are never put in a response.
 */

export interface ApiSuccessBody<TData> {
  success: true;
  data: TData;
  message: string;
}

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string };
}

/** Where unexpected failures are recorded. LoggingAndDeploymentConfiguration fits this shape. */
export interface ErrorLogger {
  logError(message: string, error?: unknown, context?: Record<string, unknown>): void;
}

/** A request the API refuses before it reaches a use case: bad origin, bad content type, bad body, ... */
export class ApiRequestException extends AppError {
  constructor(code: string, message: string, httpStatus = 400) {
    super("ApiRequestException", message, code, httpStatus);
  }
}

/**
 * Authenticated responses must never be stored by a browser or a shared cache. `no-store` is
 * applied to every response from these endpoints, errors included. `Vary: Cookie` keeps a cache
 * from mixing up two users' responses if a proxy ignores `no-store`.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cache-Control", "no-store, max-age=0"],
  ["Pragma", "no-cache"],
  ["Vary", "Cookie"],
  ["X-Content-Type-Options", "nosniff"],
];

function jsonResponse(status: number, body: ApiSuccessBody<unknown> | ApiErrorBody, setCookies: readonly string[]): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function successResponse<TData>(
  status: number,
  data: TData,
  message: string,
  setCookies: readonly string[] = [],
): Response {
  return jsonResponse(status, { success: true, data, message }, setCookies);
}

export function failureResponse(status: number, code: string, message: string, setCookies: readonly string[] = []): Response {
  return jsonResponse(status, { success: false, error: { code, message } }, setCookies);
}

/**
 * Converts anything thrown while handling a request into a safe response.
 * `setCookies` is for the one case where the cookie must be cleared even though the request failed (logout).
 */
export function errorResponse(
  error: unknown,
  logger: ErrorLogger | undefined,
  operation: string,
  setCookies: readonly string[] = [],
): Response {
  // A missing Supplier role is a server data problem, not something the client did wrong.
  const isClientError = error instanceof AppError && error.httpStatus < 500 && !(error instanceof RoleNotFoundException);
  if (isClientError) {
    return failureResponse(error.httpStatus, error.code, error.message, setCookies);
  }

  logger?.logError("Authentication request failed", error, { operation });
  if (error instanceof AppError && error.httpStatus === 503) {
    return failureResponse(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", setCookies);
  }
  return failureResponse(500, "INTERNAL_ERROR", "An unexpected error occurred.", setCookies);
}
