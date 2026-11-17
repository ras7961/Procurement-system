import { z } from "zod";
import {
  BID_DOCUMENTS_MAX_ITEMS,
  BID_DOCUMENT_REFERENCE_MAX_LENGTH,
  BID_FINANCIAL_PROPOSAL_MAX,
  BID_STATUSES,
  BID_TECHNICAL_PROPOSAL_MAX_LENGTH,
  MAX_BID_PAGE_SIZE,
  type BidStatus,
} from "@/entities/Bid";
import type { ListBidsInput, SubmitBidInput, UpdateBidInput } from "@/usecases/bid/dtos";
import { ApiRequestException } from "./apiResponse";

/**
 * Request validation for the bid endpoints (the "validate the request structure" duty of ODD controllers).
 * Shape, presence and length only; all business rules stay in the entity and use cases.
 *
 * Unknown fields in bodies are rejected so clients can never send supplierId, userId, role, status, complianceStatus,
 * submissionDate or any other protected field. The supplier a bid belongs to is always derived from the authenticated session.
 */

const text = z.string({ error: (issue) => (issue.input === undefined ? "is required" : "must be a string") });

const reference = text
  .trim()
  .min(1, "must not be blank")
  .max(BID_DOCUMENT_REFERENCE_MAX_LENGTH, `must be at most ${BID_DOCUMENT_REFERENCE_MAX_LENGTH} characters`)
  .regex(/^\S+$/, "must not contain spaces");

const technicalProposal = text.trim().min(1, "is required").max(BID_TECHNICAL_PROPOSAL_MAX_LENGTH, `must be at most ${BID_TECHNICAL_PROPOSAL_MAX_LENGTH} characters`);

const financialProposal = z
  .number({ error: (issue) => (issue.input === undefined ? "is required" : "must be a number") })
  .finite("must be a finite number")
  .gt(0, "must be greater than zero")
  .max(BID_FINANCIAL_PROPOSAL_MAX, `must be at most ${BID_FINANCIAL_PROPOSAL_MAX}`);

const supportingDocuments = z
  .array(reference, { error: () => "must be a list of document references" })
  .max(BID_DOCUMENTS_MAX_ITEMS, `must have at most ${BID_DOCUMENTS_MAX_ITEMS} items`);

const submitSchema = z
  .object({
    tenderId: text.trim().min(1, "is required").max(100, "must be at most 100 characters").regex(/^\S+$/, "must not contain spaces"),
    technicalProposal,
    financialProposal,
    supportingDocuments: supportingDocuments.optional(),
    // supplierId, userId, status, complianceStatus, submissionDate and bidId are intentionally absent.
  })
  .strict();

const updateSchema = z
  .object({
    technicalProposal: technicalProposal.optional(),
    financialProposal: financialProposal.optional(),
    supportingDocuments: supportingDocuments.optional(),
    // tenderId and every protected field are intentionally absent.
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

/** Parses and validates the POST /api/bids body. */
export function parseSubmitBidRequest(body: Record<string, unknown>, actingUserId: string): SubmitBidInput {
  const data = parse(submitSchema, body, "The request");
  return {
    actingUserId,
    tenderId: data.tenderId,
    technicalProposal: data.technicalProposal,
    financialProposal: data.financialProposal,
    ...(data.supportingDocuments !== undefined ? { supportingDocuments: data.supportingDocuments } : {}),
  };
}

/** Parses and validates the PATCH /api/bids/[id] body: proposal fields only, at least one. */
export function parseUpdateBidRequest(body: Record<string, unknown>, actingUserId: string, bidId: string): UpdateBidInput {
  const data = parse(updateSchema, body, "The request");
  const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  if (Object.keys(changes).length === 0) {
    throw new ApiRequestException("INVALID_REQUEST", "The request is invalid: at least one field to update is required.");
  }
  return { actingUserId, bidId, changes };
}

/** Parses and validates GET /api/bids query parameters. */
export function parseListBidsRequest(searchParams: URLSearchParams, actingUserId: string): ListBidsInput {
  const input: ListBidsInput = { actingUserId };

  const tenderId = searchParams.get("tenderId");
  if (tenderId !== null) {
    if (!/^\S{1,100}$/.test(tenderId)) {
      throw new ApiRequestException("INVALID_REQUEST", "The request is invalid: tenderId must be a text of 1 to 100 characters without spaces.");
    }
    input.tenderId = tenderId;
  }

  const statusValues = searchParams.getAll("status");
  if (statusValues.length > 0) {
    const invalid = statusValues.filter((value) => !(BID_STATUSES as readonly string[]).includes(value));
    if (invalid.length > 0) {
      throw new ApiRequestException("INVALID_REQUEST", `The request is invalid: status must be one or more of: ${BID_STATUSES.join(", ")}.`);
    }
    input.status = statusValues as BidStatus[];
  }

  const limitText = searchParams.get("limit");
  if (limitText !== null) {
    const limit = Number(limitText);
    if (limitText.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BID_PAGE_SIZE) {
      throw new ApiRequestException("INVALID_REQUEST", `The request is invalid: limit must be a whole number from 1 to ${MAX_BID_PAGE_SIZE}.`);
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
