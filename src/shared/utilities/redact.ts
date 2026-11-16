/**
 * Helpers that keep secrets out of logs and error output.
 * Pure functions with no imports.
 */

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|credential|api[-_]?key|cookie|uri|connection/i;
const CONNECTION_STRING = /mongodb(\+srv)?:\/\/\S+/gi;
const MAX_DEPTH = 4;

export const REDACTED = "[redacted]";

/** Replaces connection strings (which can embed credentials) inside free text. */
export function sanitizeMessage(text: string): string {
  return text.replace(CONNECTION_STRING, "[redacted-connection-string]");
}

/** Returns a copy of `value` with sensitive-looking keys masked, recursively. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeMessage(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return output;
}
