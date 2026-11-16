import type { User, UserStatus } from "@/entities/User";

/**
 * Fields of a user that can be changed through update(). Values must already have
 * been validated by the User entity (use cases change the entity first, then pass
 * the resulting values here).
 */
export interface UserUpdateData {
  fullName?: string;
  email?: string;
  passwordHash?: string;
  roleId?: string;
  status?: UserStatus;
}

/**
 * ODD: interfaces.UserRepositoryInterface
 *
 * Stores and retrieves users. It is an abstraction: MongoUserRepository
 * (src/repositories, a later step) implements it. Use cases depend on this
 * interface and never on MongoDB.
 *
 * Contract (every implementation must follow it; tests/support/userRepositoryContract.ts checks it):
 *  - Lookups (findById, findByEmail) return null when nothing matches. They do not throw.
 *  - Email matching is case-insensitive and ignores surrounding spaces.
 *  - Email is unique. create() and update() throw DuplicateEmailException when it would collide.
 *  - update, updateStatus and delete throw UserNotFoundException for an unknown userId.
 *  - Unexpected storage failures throw UserRepositoryException or DatabaseOperationException,
 *    never a raw driver error and never a message containing credentials.
 *  - Returned users are new User instances; changing one does not change stored data
 *    until update() is called.
 *
 * updateStatus() and update({ status }) do NOT check status transitions. Use cases must
 * change status through the User entity (approve, activate, deactivate, suspend) and
 * pass the result here, so Pending -> Active can only happen through approve().
 *
 * The ODD defines no existsByEmail(). Use findByEmail() !== null.
 */
export interface UserRepositoryInterface {
  /** Saves a new user and returns it. Throws DuplicateEmailException if the email is taken. */
  create(user: User): Promise<User>;

  findById(userId: string): Promise<User | null>;

  findByEmail(email: string): Promise<User | null>;

  /** Changes the given fields and returns the updated user. */
  update(userId: string, userData: UserUpdateData): Promise<User>;

  /** Deletes a user record. */
  delete(userId: string): Promise<void>;

  findAll(): Promise<User[]>;

  /** Changes only the account status and returns the updated user. */
  updateStatus(userId: string, status: UserStatus): Promise<User>;
}
