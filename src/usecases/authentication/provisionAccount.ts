import { DuplicateEmailException, InvalidUserDataException } from "@/entities/exceptions";
import type { Role } from "@/entities/Role";
import { User, type InitialUserStatus } from "@/entities/User";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import { generateId } from "@/shared/utilities/uuid";
import { DUMMY_PASSWORD_HASH } from "./dummyPasswordHash";
import { validateNewPassword } from "./passwordPolicy";

export interface NewAccount {
  fullName: string;
  email: string;
  password: string;
  role: Role;
  status: InitialUserStatus;
}

/**
 * The steps both account-creation use cases share (internal to this module).
 *
 *  1. Validate everything first, reporting all problems together, before any slow hashing.
 *  2. Refuse an email that is already registered.
 *  3. Hash the password through PasswordServiceInterface.
 *  4. Build the User entity, with a UUID created here, and store it.
 *
 * The caller decides the role and the status. This function never reads them from user input.
 */
export async function provisionAccount(
  users: UserRepositoryInterface,
  passwords: PasswordServiceInterface,
  account: NewAccount,
): Promise<User> {
  const userId = generateId();
  const issues = validateNewPassword(account.password);

  // Dry run with a placeholder hash: the entity validates name, email and role.
  let candidate: User | null = null;
  try {
    candidate = User.register({ ...pick(account), userId, passwordHash: DUMMY_PASSWORD_HASH });
  } catch (error) {
    if (!(error instanceof InvalidUserDataException)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0 || candidate === null) throw new InvalidUserDataException(issues);

  if ((await users.findByEmail(candidate.email)) !== null) throw new DuplicateEmailException();

  const passwordHash = await passwords.hash(account.password);
  const user = User.register({ ...pick(account), userId, passwordHash });
  // A concurrent registration with the same email is stopped by the repository's unique index.
  return users.create(user);
}

function pick(account: NewAccount) {
  return { fullName: account.fullName, email: account.email, role: account.role, status: account.status };
}
