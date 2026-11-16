import { AppError, type AppErrorOptions } from "./AppError";

/** ODD: Role possible exceptions. (InvalidRoleException lives with the User exceptions.) */

export class RoleNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("RoleNotFoundException", "The requested role was not found.", "ROLE_NOT_FOUND", 404, options);
  }
}

export class DuplicateRoleException extends AppError {
  constructor(options?: AppErrorOptions) {
    super("DuplicateRoleException", "A role with this name already exists.", "DUPLICATE_ROLE", 409, options);
  }
}

/** Occurs when an invalid permission is assigned, or a permission that is not assigned is removed. */
export class PermissionNotFoundException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "PermissionNotFoundException",
      "The permission is invalid or is not assigned to this role.",
      "PERMISSION_NOT_FOUND",
      400,
      options,
    );
  }
}

/** Occurs when an operation is attempted without the required permission. */
export class UnauthorizedAccessException extends AppError {
  constructor(options?: AppErrorOptions) {
    super(
      "UnauthorizedAccessException",
      "You do not have permission to perform this operation.",
      "UNAUTHORIZED_ACCESS",
      403,
      options,
    );
  }
}
