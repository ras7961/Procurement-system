import { MAX_EVALUATION_PAGE_SIZE } from "@/entities/Evaluation";
import { ApiRequestException } from "./apiResponse";

/** Validates GET /api/evaluations query parameters. Shape only; no identity or role value is ever read from the client. */
export function parseListEvaluationsRequest(searchParams: URLSearchParams, actingUserId: string) {
  const tenderId = searchParams.get("tenderId");
  if (tenderId === null || !/^\S{1,100}$/.test(tenderId)) {
    throw new ApiRequestException("INVALID_REQUEST", "The request is invalid: tenderId is required (1 to 100 characters, no spaces).");
  }
  const input: { actingUserId: string; tenderId: string; limit?: number; skip?: number } = { actingUserId, tenderId };
  const limitText = searchParams.get("limit");
  if (limitText !== null) {
    const limit = Number(limitText);
    if (limitText.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVALUATION_PAGE_SIZE) {
      throw new ApiRequestException("INVALID_REQUEST", `The request is invalid: limit must be a whole number from 1 to ${MAX_EVALUATION_PAGE_SIZE}.`);
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
