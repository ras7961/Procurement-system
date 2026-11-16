import { z } from "zod";
import {
  REVIEW_OUTCOMES,
  SUPPLIER_ADDRESS_MAX_LENGTH,
  SUPPLIER_COMPANY_NAME_MAX_LENGTH,
  SUPPLIER_EMAIL_MAX_LENGTH,
  SUPPLIER_PHONE_MAX_LENGTH,
  SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH,
  MAX_SUPPLIER_PAGE_SIZE,
  VERIFICATION_STATUSES,
  type VerificationStatus,
} from "@/entities/Supplier";
import type {
  ListSuppliersInput,
  RegisterSupplierProfileInput,
  UpdateSupplierProfileInput,
  VerifySupplierInput,
} from "@/usecases/supplier/dtos";
import { ApiRequestException } from "./apiResponse";

/**
 * Request validation for the supplier endpoints (the "validate the request structure" duty of ODD controllers).
 * Shape, presence and length only; all business rules stay in the entity and use cases.
 *
 * Unknown fields in bodies are rejected so clients can never send userId (for a Supplier), verificationStatus,
 * registrationDate, supplierId, role or any other protected field through ordinary register/update paths.
 */

const text = z.string({ error: (issue) => (issue.input === undefined ? "is required" : "must be a string") });

const required = (max: number) => text.trim().min(1, "is required").max(max, `must be at most ${max} characters`);
const optional = (max: number) => text.trim().min(1, "must not be blank").max(max, `must be at most ${max} characters`).optional();

const profileShape = {
  companyName: required(SUPPLIER_COMPANY_NAME_MAX_LENGTH),
  registrationNumber: required(SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH),
  email: required(SUPPLIER_EMAIL_MAX_LENGTH),
  phoneNumber: required(SUPPLIER_PHONE_MAX_LENGTH),
  address: required(SUPPLIER_ADDRESS_MAX_LENGTH),
};

/** A Supplier registers their own profile: no userId. */
const registerOwnSchema = z.object(profileShape).strict();

/** Administrators and Procurement Brokers name the Supplier user the profile belongs to. */
const registerForUserSchema = z.object({ ...profileShape, userId: text.trim().min(1, "userId must be a non-empty text").optional() }).strict();

const updateSchema = z
  .object({
    companyName: optional(SUPPLIER_COMPANY_NAME_MAX_LENGTH),
    registrationNumber: optional(SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH),
    email: optional(SUPPLIER_EMAIL_MAX_LENGTH),
    phoneNumber: optional(SUPPLIER_PHONE_MAX_LENGTH),
    address: optional(SUPPLIER_ADDRESS_MAX_LENGTH),
    // userId, verificationStatus, registrationDate and supplierId are intentionally absent.
  })
  .strict();

const verifySchema = z
  .object({
    status: z.enum(REVIEW_OUTCOMES, { error: () => `status must be one of: ${REVIEW_OUTCOMES.join(", ")}` }),
  })
  .strict();

function parse<TSchema extends z.ZodType>(schema: TSchema, body: unknown, label: string): z.output<TSchema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const problems = new Set<string>();
  for (const issue of result.error.issues) {
    problems.add(
      issue.code === "unrecognized_keys"
        ? "the request contains fields that are not allowed"
        : `${issue.path.map(String).join(".")} ${issue.message}`.trim(),
    );
  }
  throw new ApiRequestException("INVALID_REQUEST", `${label} is invalid: ${[...problems].join("; ")}.`);
}

/**
 * Parses and validates the POST /api/suppliers body.
 *
 * Role-aware userId policy (decided from the caller's STORED role, never from the body):
 *   - Administrator / Procurement Broker: may (and must, for the use case) supply `userId`.
 *   - Every other role: `userId` must not appear; the strict schema rejects it with a 400.
 */
export function parseRegisterSupplierRequest(
  body: Record<string, unknown>,
  actingUserId: string,
  callerRoleName: string,
): RegisterSupplierProfileInput {
  const staff = callerRoleName === "Administrator" || callerRoleName === "Procurement Broker";
  const data: z.output<typeof registerForUserSchema> = staff
    ? parse(registerForUserSchema, body, "The request")
    : parse(registerOwnSchema, body, "The request");
  return {
    actingUserId,
    companyName: data.companyName,
    registrationNumber: data.registrationNumber,
    email: data.email,
    phoneNumber: data.phoneNumber,
    address: data.address,
    // Only staff can reach a schema that allows userId; for everyone else it is always absent.
    ...(staff && data.userId !== undefined ? { userId: data.userId } : {}),
  };
}

/** Parses and validates the PATCH /api/suppliers/[id] body: profile fields only, at least one. */
export function parseUpdateSupplierRequest(body: Record<string, unknown>, actingUserId: string, supplierId: string): UpdateSupplierProfileInput {
  const data = parse(updateSchema, body, "The request");
  const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  if (Object.keys(changes).length === 0) {
    throw new ApiRequestException("INVALID_REQUEST", "The request is invalid: at least one field to update is required.");
  }
  return { actingUserId, supplierId, changes };
}

/** Parses and validates the POST /api/suppliers/[id]/verification body. */
export function parseVerifySupplierRequest(body: Record<string, unknown>, actingUserId: string, supplierId: string): VerifySupplierInput {
  const data = parse(verifySchema, body, "The request");
  return { actingUserId, supplierId, status: data.status };
}

/** Parses and validates GET /api/suppliers query parameters. */
export function parseListSuppliersRequest(searchParams: URLSearchParams, actingUserId: string): ListSuppliersInput {
  const input: ListSuppliersInput = { actingUserId };

  const statusValues = searchParams.getAll("verificationStatus");
  if (statusValues.length > 0) {
    const invalid = statusValues.filter((value) => !(VERIFICATION_STATUSES as readonly string[]).includes(value));
    if (invalid.length > 0) {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        `The request is invalid: verificationStatus must be one or more of: ${VERIFICATION_STATUSES.join(", ")}.`,
      );
    }
    input.verificationStatus = statusValues as VerificationStatus[];
  }

  const limitText = searchParams.get("limit");
  if (limitText !== null) {
    const limit = Number(limitText);
    if (limitText.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > MAX_SUPPLIER_PAGE_SIZE) {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        `The request is invalid: limit must be a whole number from 1 to ${MAX_SUPPLIER_PAGE_SIZE}.`,
      );
    }
    input.limit = limit;
  }

  const skipText = searchParams.get("skip");
  if (skipText !== null) {
    const skip = Number(skipText);
    if (skipText.trim() === "" || !Number.isInteger(skip) || skip < 0) {
      throw new ApiRequestException("INVALID_REQUEST", "The request is invalid: skip must be a whole number of 0 or more.");
    }
    input.skip = skip;
  }

  return input;
}
