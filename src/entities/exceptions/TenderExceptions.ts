import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: Tender and TenderRepositoryInterface possible exceptions.
 * Messages are safe to show to users: they name fields and statuses, never submitted values.
 */

/** ODD: TenderRepositoryInterface. */
export class TenderNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("TenderNotFoundException", "The requested tender was not found.", "TENDER_NOT_FOUND", 404, options);
  }
}

/** ODD: occurs when required tender information is incomplete or invalid. Lists every problem found. */
export class InvalidTenderDataException extends AppError {
  readonly issues: string[];

  constructor(issues: string[], options?: AppErrorOptions) {
    super(
      "InvalidTenderDataException",
      `The tender data is invalid: ${issues.join("; ")}.`,
      "INVALID_TENDER_DATA",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when an operation is not allowed for the current tender status. */
export class InvalidTenderStatusException extends AppError {
  constructor(status: string, operation: string, options?: AppErrorOptions) {
    super(
      "InvalidTenderStatusException",
      `The operation "${operation}" is not allowed while the tender is ${status}.`,
      "INVALID_TENDER_STATUS",
      409,
      { ...options, details: { ...options?.details, status, operation } },
    );
  }
}

/** ODD: occurs when an operation is attempted after the applicable deadline. */
export class DeadlineExpiredException extends AppError {
  constructor(operation: string, options?: AppErrorOptions) {
    super(
      "DeadlineExpiredException",
      `The operation "${operation}" cannot be performed because the submission deadline has passed.`,
      "DEADLINE_EXPIRED",
      409,
      { ...options, details: { ...options?.details, operation } },
    );
  }
}

/**
 * Not listed in the ODD. Occurs when a tender is closed before its submission deadline without
 * the explicit early-closure authorization that ODD Tender.close() requires.
 */
export class TenderDeadlineNotReachedException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "TenderDeadlineNotReachedException",
      "The submission deadline has not been reached. Closing the tender early needs explicit authorization.",
      "TENDER_DEADLINE_NOT_REACHED",
      409,
      options,
    );
  }
}

/** ODD: TenderRepositoryInterface. Generic failure of a tender storage operation. */
export class TenderRepositoryException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("TenderRepositoryException", "A tender storage operation failed.", "TENDER_REPOSITORY_ERROR", 500, options);
  }
}
