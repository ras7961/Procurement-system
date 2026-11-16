import { AppError, type AppErrorOptions } from "./AppError";

/**
 * ODD: AuthenticationController / User possible exception "InvalidCredentialsException".
 *
 * The one generic failure a login attempt can produce. Its message is identical for an
 * unknown email, a wrong password, and an account that is Pending, Inactive or Suspended,
 * so a caller cannot tell which of these happened.
 */
export class InvalidCredentialsException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("InvalidCredentialsException", "Invalid email or password.", "INVALID_CREDENTIALS", 401, options);
  }
}

/**
 * Not listed in the ODD (the ODD's UnauthorizedAccessException means "authenticated but not
 * permitted", HTTP 403). Raised when a protected operation is attempted without a valid session:
 * no token, or a token that is malformed, forged, expired or revoked, or one whose account no
 * longer exists. The message is identical in all of these cases, so a caller learns nothing about why.
 */
export class AuthenticationRequiredException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("AuthenticationRequiredException", "Authentication is required.", "AUTHENTICATION_REQUIRED", 401, options);
  }
}

/**
 * ODD: AuthenticationController possible exception "AuthenticationServiceException".
 * The authentication machinery itself failed (for example a token could not be signed).
 * The message is generic; technical detail stays in `cause`.
 */
export class AuthenticationServiceException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "AuthenticationServiceException",
      "Authentication could not be completed.",
      "AUTHENTICATION_SERVICE_ERROR",
      500,
      options,
    );
  }
}
