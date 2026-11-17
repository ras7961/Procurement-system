import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: Evaluation, EvaluationRepositoryInterface and BidEvaluationUseCase possible exceptions
 * (EvaluationNotFoundException, InvalidEvaluationScoreException, IncompleteEvaluationException,
 * EvaluationAlreadyCompletedException) plus EvaluationRepositoryException for storage failures and
 * BidNotEligibleForEvaluationException (not named in the ODD; needed to refuse withdrawn bids). Messages never echo submitted values.
 */

/** Also used when an evaluation is outside what the caller may see, so its existence is not revealed. */
export class EvaluationNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("EvaluationNotFoundException", "The requested evaluation was not found.", "EVALUATION_NOT_FOUND", 404, options);
  }
}

export class InvalidEvaluationScoreException extends AppError {
  readonly issues: string[];
  constructor(issues: string[], options?: AppErrorOptions) {
    super("InvalidEvaluationScoreException", `The evaluation data is invalid: ${issues.join("; ")}.`, "INVALID_EVALUATION_SCORE", 400, {
      ...options,
      details: { ...options?.details, issues },
    });
    this.issues = issues;
  }
}

export class IncompleteEvaluationException extends AppError {
  constructor(missing: string[], options?: AppErrorOptions) {
    super("IncompleteEvaluationException", `The evaluation cannot be completed: ${missing.join(", ")} not recorded.`, "INCOMPLETE_EVALUATION", 409, {
      ...options,
      details: { ...options?.details, missing },
    });
  }
}

export class EvaluationAlreadyCompletedException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("EvaluationAlreadyCompletedException", "The evaluation is already completed and cannot be changed.", "EVALUATION_ALREADY_COMPLETED", 409, options);
  }
}

/** A withdrawn bid (or any bid for which Bid.isEligibleForEvaluation() is false) can never be evaluated. */
export class BidNotEligibleForEvaluationException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("BidNotEligibleForEvaluationException", "This bid is not eligible for evaluation.", "BID_NOT_ELIGIBLE_FOR_EVALUATION", 409, options);
  }
}

export class EvaluationRepositoryException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("EvaluationRepositoryException", "The evaluation could not be stored or read.", "EVALUATION_REPOSITORY_ERROR", 500, options);
  }
}
