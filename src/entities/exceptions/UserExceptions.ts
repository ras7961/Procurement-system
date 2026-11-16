import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: User and UserRepositoryInterface possible exceptions.
 *
 * Messages are safe to show to users. They never contain passwords, hashes or
 * submitted values. Validation messages name the invalid field only.
 */

/**
 * Not listed in the ODD: it covers invalid user attributes (empty name, malformed
 * email, unknown status, ...). Named after the ODD's InvalidTenderDataException
 * and InvalidSupplierDataException.
 */
export class InvalidUserDataException extends AppError {
  readonly issues: string[];

  constructor(issues: string[], options?: AppErrorOptions) {
    super(
      "InvalidUserDataException",
      `The user data is invalid: ${issues.join("; ")}.`,
      "INVALID_USER_DATA",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when an invalid role is assigned (also used for invalid Role data). */
export class InvalidRoleException extends AppError {
  readonly issues: string[];

  constructor(issues: string[] = [], options?: AppErrorOptions) {
    super(
      "InvalidRoleException",
      issues.length > 0 ? `The role is invalid: ${issues.join("; ")}.` : "The specified role is invalid.",
      "INVALID_ROLE",
      400,
      { ...options, details: { ...options?.details, issues } },
    );
    this.issues = issues;
  }
}

/** ODD: occurs when an inactive account attempts to access the system. */
export class AccountInactiveException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("AccountInactiveException", "This account is not active.", "ACCOUNT_INACTIVE", 403, options);
  }
}

/**
 * Not listed in the ODD. Occurs when an account status change is not allowed,
 * e.g. suspending a Pending account or activating one that still needs approval.
 */
export class InvalidUserStatusTransitionException extends AppError {
  constructor(from: string, to: string, options?: AppErrorOptions) {
    super(
      "InvalidUserStatusTransitionException",
      "This account status change is not allowed.",
      "INVALID_STATUS_TRANSITION",
      409,
      { ...options, details: { ...options?.details, from, to } },
    );
  }
}

/** ODD: occurs when an email address is already registered. The email is not echoed. */
export class DuplicateEmailException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "DuplicateEmailException",
      "A user with this email address already exists.",
      "DUPLICATE_EMAIL",
      409,
      options,
    );
  }
}

/** ODD: UserRepositoryInterface. */
export class UserNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("UserNotFoundException", "The requested user was not found.", "USER_NOT_FOUND", 404, options);
  }
}

/** ODD: UserRepositoryInterface. Generic failure of a user storage operation. */
export class UserRepositoryException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("UserRepositoryException", "A user storage operation failed.", "USER_REPOSITORY_ERROR", 500, options);
  }
}
