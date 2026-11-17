import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: Bid, BidRepositoryInterface and BidSubmissionUseCase possible exceptions
 * (BidNotFoundException, TenderClosedException, DuplicateBidException, InvalidBidDataException, BidSubmissionException,
 * InvalidDocumentException) plus BidRepositoryException for storage failures.
 * Messages are safe to show to users: they name fields and statuses, never submitted values.
 */

/** ODD: BidRepositoryInterface. Also used when a bid is outside what the caller may see, so its existence is not revealed. */
export class BidNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("BidNotFoundException", "The requested bid was not found.", "BID_NOT_FOUND", 404, options);
  }
}

/** ODD: occurs when required bid information is incomplete or invalid. Lists every problem found. */
export class InvalidBidDataException extends AppError {
  readonly issues: string[];

  constructor(issues: string[], options?: AppErrorOptions) {
    super(
      "InvalidBidDataException",
      `The bid data is invalid: ${issues.join("; ")}.`,
      "INVALID_BID_DATA",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when a supporting document reference does not meet the validation rules. */
export class InvalidDocumentException extends AppError {
  readonly issues: string[];

  constructor(issues: string[], options?: AppErrorOptions) {
    super(
      "InvalidDocumentException",
      `A supporting document reference is invalid: ${issues.join("; ")}.`,
      "INVALID_DOCUMENT",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when a bid is submitted after the tender has closed (or while the tender no longer accepts bids). */
export class TenderClosedException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("TenderClosedException", "The tender is closed and no longer accepts bids.", "TENDER_CLOSED", 409, options);
  }
}

/** ODD: occurs when a supplier attempts a second bid for the same tender (one submission per supplier per tender). */
export class DuplicateBidException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("DuplicateBidException", "A bid from this supplier already exists for this tender.", "DUPLICATE_BID", 409, options);
  }
}

/**
 * ODD: occurs when the bid submission process fails. Used when the bid cannot be submitted or changed for a business
 * reason, for example no supplier profile exists yet, or the bid is no longer in the Submitted status.
 * `reason` is a fixed, safe sentence fragment written by the application, never user input.
 */
export class BidSubmissionException extends AppError {
  constructor(reason: string, options?: AppErrorOptions) {
    super("BidSubmissionException", `The bid cannot be processed: ${reason}.`, "BID_SUBMISSION_ERROR", 409, {
      ...options,
      details: { ...options?.details, reason },
    });
  }
}

/** ODD: BidRepositoryInterface. Generic failure of a bid storage operation. */
export class BidRepositoryException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("BidRepositoryException", "A bid storage operation failed.", "BID_REPOSITORY_ERROR", 500, options);
  }
}
