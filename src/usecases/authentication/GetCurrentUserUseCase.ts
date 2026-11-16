import { RoleNotFoundException, UserNotFoundException } from "@/entities/exceptions";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { toUserResponse, type GetCurrentUserInput, type UserResponseDto } from "./dtos";

/**
 * Returns the authenticated user's current account information.
 *
 * The id comes from a token the HTTP adapter already verified. The account is read again, so a
 * user who was suspended or deactivated after logging in gets AccountInactiveException instead of
 * data. The response is a UserResponseDto and never contains passwordHash.
 */
export class GetCurrentUserUseCase {
  constructor(
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
  ) {}

  async execute(input: GetCurrentUserInput): Promise<UserResponseDto> {
    const userId = input?.userId;
    if (typeof userId !== "string" || userId === "") throw new UserNotFoundException();

    const user = await this.users.findById(userId);
    if (user === null) throw new UserNotFoundException();
    user.assertCanAuthenticate();

    const role = await this.roles.findById(user.roleId);
    if (role === null) throw new RoleNotFoundException();
    return toUserResponse(user, role);
  }
}
