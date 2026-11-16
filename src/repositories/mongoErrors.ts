/**
 * Helpers for translating MongoDB driver errors at the repository boundary.
 * They inspect errors structurally, so no driver error class leaks out of this folder.
 */

const DUPLICATE_KEY_CODE = 11000;

/**
 * True when `error` is a duplicate-key violation on the given field or index.
 * MongoDB reports the violated key pattern; the index name in the message is a fallback.
 */
export function isDuplicateKeyOn(error: unknown, field: string, indexName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; keyPattern?: unknown; message?: unknown };
  if (candidate.code !== DUPLICATE_KEY_CODE) return false;

  if (typeof candidate.keyPattern === "object" && candidate.keyPattern !== null) {
    return field in candidate.keyPattern;
  }
  return typeof candidate.message === "string" && candidate.message.includes(indexName);
}

/**
 * Non-sensitive facts about a driver error, safe to keep in AppError.details for logs.
 * Deliberately excludes the message, which can contain hosts or document values.
 */
export function describeDriverError(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = { driverError: error instanceof Error ? error.name : "UnknownError" };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" || typeof code === "string") details.driverCode = code;
  return details;
}
