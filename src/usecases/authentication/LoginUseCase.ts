import {
  AccountInactiveException,
  InvalidCredentialsException,
  RoleNotFoundException,
} from "@/entities/exceptions";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import type { TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";
import { toUserResponse, type LoginInput, type LoginResultDto } from "./dtos";
import { DUMMY_PASSWORD_HASH } from "./dummyPasswordHash";
import { PASSWORD_MAX_LENGTH } from "./passwordPolicy";

/**
 * Login (ODD AuthenticationUseCase: login; ODD User.authenticate()).
 *
 * Every way of failing to log in, namely a malformed request, an unknown email, a wrong
 * password, and a Pending, Inactive or Suspended account, throws the same
 * InvalidCredentialsException. The password is always checked exactly once, against a dummy
 * Argon2id hash when the email is unknown, so timing does not reveal which emails exist. The
 * account status is checked only after the password was verified, so it does not leak either.
 *
 * This use case never logs. It must not: it handles passwords and tokens.
 */
export class LoginUseCase {
  constructor(
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
    private readonly passwords: PasswordServiceInterface,
    private readonly tokens: TokenServiceInterface,
  ) {}

  async execute(input: LoginInput): Promise<LoginResultDto> {
    const email = input?.email;
    const password = input?.password;
    if (
      typeof email !== "string" ||
      email.trim() === "" ||
      typeof password !== "string" ||
      password === "" ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      throw new InvalidCredentialsException();
    }

    const user = await this.users.findByEmail(email);
    const passwordMatches = await this.passwords.verify(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (user === null || !passwordMatches) throw new InvalidCredentialsException();

    try {
      user.assertCanAuthenticate();
    } catch (error) {
      // The real reason (the status) is deliberately not passed on.
      if (error instanceof AccountInactiveException) throw new InvalidCredentialsException();
      throw error;
    }

    const role = await this.roles.findById(user.roleId);
    if (role === null) throw new RoleNotFoundException();

    const issued = await this.tokens.issue({ userId: user.userId, roleId: role.roleId });
    return { user: toUserResponse(user, role), token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  }
}
