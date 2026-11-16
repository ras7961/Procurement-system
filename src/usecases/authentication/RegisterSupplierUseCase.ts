import { RoleNotFoundException } from "@/entities/exceptions";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import { toUserResponse, type RegisterSupplierInput, type UserResponseDto } from "./dtos";
import { provisionAccount } from "./provisionAccount";

/**
 * Public supplier self-registration (ODD AuthenticationUseCase: register).
 *
 * - The role is always Supplier and the status is always Pending. Neither can be chosen by the
 *   caller: the input has no such fields, and any extra fields are ignored.
 * - An Administrator must approve the account (User.approve()) before it can log in or bid.
 * - Brokers, Evaluation Committee members and Administrators are never created here.
 */
export class RegisterSupplierUseCase {
  constructor(
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
    private readonly passwords: PasswordServiceInterface,
  ) {}

  async execute(input: RegisterSupplierInput): Promise<UserResponseDto> {
    const role = await this.roles.findByName("Supplier");
    if (role === null) throw new RoleNotFoundException();

    const user = await provisionAccount(this.users, this.passwords, {
      // Fields are named one by one on purpose: nothing else from `input` is used.
      fullName: input?.fullName,
      email: input?.email,
      password: input?.password,
      role,
      status: "Pending",
    });
    return toUserResponse(user, role);
  }
}
