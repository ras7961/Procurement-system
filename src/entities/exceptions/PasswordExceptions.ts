import { AppError, type AppErrorOptions } from "./AppError";

/**
 * Not listed in the ODD. Raised when a password cannot be hashed (empty input, or the
 * hashing library is unavailable). The message never contains the password or a hash.
 */
export class PasswordHashingException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "PasswordHashingException",
      "The password could not be processed.",
      "PASSWORD_HASHING_ERROR",
      500,
      options,
    );
  }
}
