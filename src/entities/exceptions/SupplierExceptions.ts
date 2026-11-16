import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: Supplier and SupplierRepositoryInterface possible exceptions.
 * Messages are safe to show to users: they name fields and statuses, never submitted values.
 * (InvalidDocumentException is not defined: supplier documents are not part of Stage 2D.)
 */

/** ODD: SupplierRepositoryInterface. Also used when a supplier is outside what the caller may see. */
export class SupplierNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("SupplierNotFoundException", "The requested supplier was not found.", "SUPPLIER_NOT_FOUND", 404, options);
  }
}

/** ODD: occurs when supplier information is incomplete or invalid. Lists every problem found. */
export class InvalidSupplierDataException extends AppError {
  readonly issues: string[];

  constructor(issues: string[], options?: AppErrorOptions) {
    super(
      "InvalidSupplierDataException",
      `The supplier data is invalid: ${issues.join("; ")}.`,
      "INVALID_SUPPLIER_DATA",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when a registration number (or a user's supplier profile) is already registered. */
export class DuplicateRegistrationException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "DuplicateRegistrationException",
      "A supplier with this registration number, or a profile for this user, already exists.",
      "DUPLICATE_SUPPLIER_REGISTRATION",
      409,
      options,
    );
  }
}

/** ODD: occurs when a verification change is not allowed for the supplier's current verification status. */
export class SupplierVerificationException extends AppError {
  constructor(status: string, operation: string, options?: AppErrorOptions) {
    super(
      "SupplierVerificationException",
      `The operation "${operation}" is not allowed while the supplier is ${status}.`,
      "SUPPLIER_VERIFICATION_ERROR",
      409,
      { ...options, details: { ...options?.details, status, operation } },
    );
  }
}

/** ODD: SupplierRepositoryInterface. Generic failure of a supplier storage operation. */
export class SupplierRepositoryException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("SupplierRepositoryException", "A supplier storage operation failed.", "SUPPLIER_REPOSITORY_ERROR", 500, options);
  }
}
