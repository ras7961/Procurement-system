import { z } from "zod";
import { EMAIL_MAX_LENGTH, FULL_NAME_MAX_LENGTH } from "@/entities/User";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/usecases/authentication/passwordPolicy";
import type { LoginInput, RegisterSupplierInput } from "@/usecases/authentication/dtos";
import { ApiRequestException } from "./apiResponse";

/**
 * Request validation for the authentication endpoints (the "validate the request structure" duty
 * of ODD controllers). It checks shape, presence and length only, using the limits the entity and
 * the password policy already define. The use cases still enforce every business rule themselves.
 *
 * Unknown fields are rejected, never ignored: a request that tries to send a role, status,
 * permissions or password hash is refused outright, and the offending field names are not echoed.
 */

const text = z.string({ error: (issue) => (issue.input === undefined ? "is required" : "must be a string") });

const registerSchema = z
  .object({
    fullName: text
      .trim()
      .min(1, "is required")
      .max(FULL_NAME_MAX_LENGTH, `must be at most ${FULL_NAME_MAX_LENGTH} characters`),
    email: text
      .trim()
      .min(1, "is required")
      .max(EMAIL_MAX_LENGTH, `must be at most ${EMAIL_MAX_LENGTH} characters`)
      .refine((value) => z.email().safeParse(value).success, "must be a valid email address"),
    password: text
      .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
      .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`),
  })
  .strict();

/** Login checks structure only. Whether the credentials are right is the use case's answer, always the same generic one. */
const loginSchema = z
  .object({
    email: text
      .trim()
      .min(1, "is required")
      .max(EMAIL_MAX_LENGTH, `must be at most ${EMAIL_MAX_LENGTH} characters`),
    password: text
      .min(1, "is required")
      .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`),
  })
  .strict();

export function parseRegisterRequest(body: Record<string, unknown>): RegisterSupplierInput {
  return parse(registerSchema, body);
}

export function parseLoginRequest(body: Record<string, unknown>): LoginInput {
  return parse(loginSchema, body);
}

function parse<TSchema extends z.ZodType>(schema: TSchema, body: unknown): z.output<TSchema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const problems = new Set<string>();
  for (const issue of result.error.issues) {
    problems.add(
      issue.code === "unrecognized_keys"
        ? "the request contains fields that are not allowed"
        : `${issue.path.map(String).join(".")} ${issue.message}`,
    );
  }
  throw new ApiRequestException("INVALID_REQUEST", `The request is invalid: ${[...problems].join("; ")}.`);
}
