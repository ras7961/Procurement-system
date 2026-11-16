import { z } from "zod";
import {
  TENDER_CATEGORY_MAX_LENGTH,
  TENDER_DESCRIPTION_MAX_LENGTH,
  TENDER_TITLE_MAX_LENGTH,
  TENDER_STATUSES,
  MAX_TENDER_PAGE_SIZE,
  type TenderStatus,
} from "@/entities/Tender";
import type {
  CreateTenderInput,
  ListTendersInput,
  UpdateTenderInput,
} from "@/usecases/tender/dtos";
import { ApiRequestException } from "./apiResponse";

/**
 * Request validation for the tender endpoints (the "validate the request structure" duty of ODD
 * controllers). Shape, presence and length only; all business rules stay in the use cases.
 *
 * Unknown fields in bodies are rejected immediately so clients can never send role, status,
 * brokerId or any other protected field through ordinary create/update paths. Query parameters are
 * validated with the same strictness.
 */

const text = z.string({
  error: (issue) =>
    issue.input === undefined ? "is required" : "must be a string",
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isoDate = text.refine(
  (v) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)),
  "must be an ISO 8601 UTC date-time string",
);

const stringList = z
  .array(z.string(), { error: () => "must be an array of strings" })
  .min(0);

/**
 * Administrators may supply brokerId to name the responsible Procurement Broker.
 * All other roles must not send it at all; the schema below excludes it and .strict() catches it.
 */
const createTenderAdminSchema = z
  .object({
    title: text
      .trim()
      .min(1, "is required")
      .max(
        TENDER_TITLE_MAX_LENGTH,
        `must be at most ${TENDER_TITLE_MAX_LENGTH} characters`,
      ),
    description: text
      .trim()
      .min(1, "is required")
      .max(
        TENDER_DESCRIPTION_MAX_LENGTH,
        `must be at most ${TENDER_DESCRIPTION_MAX_LENGTH} characters`,
      ),
    category: text
      .trim()
      .min(1, "is required")
      .max(
        TENDER_CATEGORY_MAX_LENGTH,
        `must be at most ${TENDER_CATEGORY_MAX_LENGTH} characters`,
      ),
    estimatedBudget: z
      .number({ error: () => "estimatedBudget must be a positive number" })
      .positive("estimatedBudget must be a positive number"),
    requirements: stringList.optional(),
    evaluationCriteria: stringList.optional(),
    submissionDeadline: isoDate,
    /** Required for Administrators: identifies the active Procurement Broker responsible for this tender. */
    brokerId: text
      .trim()
      .min(1, "brokerId must be a non-empty text")
      .optional(),
  })
  .strict();

/** Same as the Admin schema but brokerId is excluded and .strict() rejects it if present. */
const createTenderSchema = createTenderAdminSchema
  .omit({ brokerId: true })
  .strict();

const updateTenderSchema = z
  .object({
    title: text
      .trim()
      .min(1, "must not be blank")
      .max(
        TENDER_TITLE_MAX_LENGTH,
        `must be at most ${TENDER_TITLE_MAX_LENGTH} characters`,
      )
      .optional(),
    description: text
      .trim()
      .min(1, "must not be blank")
      .max(
        TENDER_DESCRIPTION_MAX_LENGTH,
        `must be at most ${TENDER_DESCRIPTION_MAX_LENGTH} characters`,
      )
      .optional(),
    category: text
      .trim()
      .min(1, "must not be blank")
      .max(
        TENDER_CATEGORY_MAX_LENGTH,
        `must be at most ${TENDER_CATEGORY_MAX_LENGTH} characters`,
      )
      .optional(),
    estimatedBudget: z
      .number({ error: () => "estimatedBudget must be a positive number" })
      .positive("estimatedBudget must be a positive number")
      .optional(),
    requirements: stringList.optional(),
    evaluationCriteria: stringList.optional(),
    submissionDeadline: isoDate.optional(),
    // Status, brokerId and all other fields are intentionally absent.
  })
  .strict();

function parse<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  label: string,
): z.output<TSchema> {
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
  throw new ApiRequestException(
    "INVALID_REQUEST",
    `${label} is invalid: ${[...problems].join("; ")}.`,
  );
}

/**
 * Parses and validates the POST /api/tenders body.
 *
 * Role-aware brokerId policy (enforced here before the use case sees the input):
 *   - Administrator: may supply an optional `brokerId`; the use case validates that it names
 *     an active Procurement Broker.
 *   - All other roles: `brokerId` must not appear in the request body. If present, the
 *     `.strict()` schema rejects it immediately with a 400.
 *
 * The caller's role is derived from the authenticated session (`callerRoleName`), never from
 * the request body, so a client cannot escalate its own privileges.
 */
export function parseCreateTenderRequest(
  body: Record<string, unknown>,
  actingUserId: string,
  callerRoleName: string,
): CreateTenderInput {
  const isAdmin = callerRoleName === "Administrator";
  const data = parse(
    isAdmin ? createTenderAdminSchema : createTenderSchema,
    body,
    "The request",
  );
  return {
    actingUserId,
    title: data.title,
    description: data.description,
    category: data.category,
    estimatedBudget: data.estimatedBudget,
    requirements: data.requirements,
    evaluationCriteria: data.evaluationCriteria,
    submissionDeadline: new Date(data.submissionDeadline),
    // Forward brokerId only for Administrators; the use case performs the final validation
    // (active user, Procurement Broker role). For all other roles brokerId is always undefined.
    ...(isAdmin && "brokerId" in data
      ? { brokerId: (data as { brokerId?: string }).brokerId }
      : {}),
  };
}

/** Parses and validates the PATCH /api/tenders/[id] body. */
export function parseUpdateTenderRequest(
  body: Record<string, unknown>,
  actingUserId: string,
  tenderId: string,
): UpdateTenderInput {
  const data = parse(updateTenderSchema, body, "The request");
  return {
    actingUserId,
    tenderId,
    changes: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined
        ? { description: data.description }
        : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.estimatedBudget !== undefined
        ? { estimatedBudget: data.estimatedBudget }
        : {}),
      ...(data.requirements !== undefined
        ? { requirements: data.requirements }
        : {}),
      ...(data.evaluationCriteria !== undefined
        ? { evaluationCriteria: data.evaluationCriteria }
        : {}),
      ...(data.submissionDeadline !== undefined
        ? { submissionDeadline: new Date(data.submissionDeadline) }
        : {}),
    },
  };
}

/** Parses and validates GET /api/tenders query parameters. */
export function parseListTendersRequest(
  searchParams: URLSearchParams,
  actingUserId: string,
): ListTendersInput {
  const raw: Record<string, unknown> = {};

  const statusValues = searchParams.getAll("status");
  if (statusValues.length > 0) {
    const invalid = statusValues.filter(
      (s) => !(TENDER_STATUSES as readonly string[]).includes(s),
    );
    if (invalid.length > 0 || statusValues.length === 0) {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        `The request is invalid: status must be one or more of: ${TENDER_STATUSES.join(", ")}.`,
      );
    }
    raw.status = statusValues as TenderStatus[];
  }

  const brokerId = searchParams.get("brokerId");
  if (brokerId !== null) {
    if (typeof brokerId !== "string" || brokerId.trim() === "") {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        "The request is invalid: brokerId must be a non-empty text.",
      );
    }
    raw.brokerId = brokerId.trim();
  }

  const category = searchParams.get("category");
  if (category !== null) {
    if (category.trim() === "") {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        "The request is invalid: category must be a non-empty text.",
      );
    }
    raw.category = category.trim();
  }

  const limitStr = searchParams.get("limit");
  if (limitStr !== null) {
    const limit = Number(limitStr);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TENDER_PAGE_SIZE) {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        `The request is invalid: limit must be a whole number from 1 to ${MAX_TENDER_PAGE_SIZE}.`,
      );
    }
    raw.limit = limit;
  }

  const skipStr = searchParams.get("skip");
  if (skipStr !== null) {
    const skip = Number(skipStr);
    if (!Number.isInteger(skip) || skip < 0) {
      throw new ApiRequestException(
        "INVALID_REQUEST",
        "The request is invalid: skip must be a whole number of 0 or more.",
      );
    }
    raw.skip = skip;
  }

  return {
    actingUserId,
    ...(raw.status !== undefined
      ? { status: raw.status as TenderStatus | readonly TenderStatus[] }
      : {}),
    ...(raw.brokerId !== undefined ? { brokerId: raw.brokerId as string } : {}),
    ...(raw.category !== undefined ? { category: raw.category as string } : {}),
    ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}),
    ...(raw.skip !== undefined ? { skip: raw.skip as number } : {}),
  };
}
