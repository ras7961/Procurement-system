/**
 * Rules for a NEW password (registration, administrator-created accounts).
 * Length only, following current NIST guidance: no composition rules, long passphrases allowed.
 * The upper limit stops very large inputs from being hashed.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns the problems found. The password itself is never echoed. */
export function validateNewPassword(password: unknown): string[] {
  if (typeof password !== "string" || password.length === 0) return ["password is required"];
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) issues.push(`password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  return issues;
}
