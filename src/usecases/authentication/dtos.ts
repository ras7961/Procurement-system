import type { Role } from "@/entities/Role";
import type { User } from "@/entities/User";

/**
 * Input and output shapes of the authentication use cases. Plain data: no entities, no
 * password hashes. Controllers map HTTP requests into the inputs and the results into responses.
 */

/** Public supplier self-registration. There is deliberately no role or status field. */
export interface RegisterSupplierInput {
  fullName: string;
  email: string;
  password: string;
}

/** Account creation by an administrator. `actingUserId` is the authenticated caller. */
export interface CreateUserAccountInput {
  actingUserId: string;
  fullName: string;
  email: string;
  password: string;
  roleName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LogoutInput {
  /** The token presented by the client, if any. */
  token?: string;
}

export interface GetCurrentUserInput {
  /** The authenticated user's id, taken from a verified token by the HTTP adapter. */
  userId: string;
}

export interface AuthenticateSessionInput {
  /** The session token presented by the client, if any. */
  token?: string;
}

/** The account information that may leave the application. It never contains passwordHash. */
export interface UserResponseDto {
  userId: string;
  fullName: string;
  email: string;
  roleId: string;
  roleName: string;
  status: string;
  createdAt: string;
}

export interface LoginResultDto {
  user: UserResponseDto;
  /** For the HTTP adapter to place in a cookie or header. Never log it. */
  token: string;
  expiresAt: string;
}

export interface LogoutResultDto {
  /** Always true: the adapter must clear the client's cookie or token whatever happened server-side. */
  clearCredentials: true;
}

/** Builds the response by naming each field, so a new User field can never leak by accident. */
export function toUserResponse(user: User, role: Role): UserResponseDto {
  return {
    userId: user.userId,
    fullName: user.fullName,
    email: user.email,
    roleId: user.roleId,
    roleName: role.roleName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
