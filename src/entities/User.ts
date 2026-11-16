import {
  AccountInactiveException,
  InvalidRoleException,
  InvalidUserDataException,
  InvalidUserStatusTransitionException,
} from "./exceptions";
import { Role } from "./Role";

/**
 * ODD: entities.User
 *
 * A person with an account in the system. The role decides what they may do.
 *
 * ODD operation mapping:
 *   register()        -> User.register()  (and User.restore() when loading stored data)
 *   authenticate()    -> assertCanAuthenticate(): the account-state half only. Checking the
 *                        password is the job of AuthenticationUseCase and a password service.
 *   updateProfile()   -> updateProfile()
 *   changePassword()  -> changePassword(): takes an ALREADY HASHED password
 *   deactivate()      -> deactivate()
 *   assignRole()      -> assignRole()
 *
 * Also provided: approve(), activate(), suspend(), isPending(), because the status
 * values include Pending and Suspended and the SDD says User Management "activates"
 * and "deactivates" accounts.
 *
 * Status model (approved in Stage 1B; the ODD lists only Active, Inactive, Suspended):
 *   Pending   self-registered supplier waiting for administrator approval. Cannot log in.
 *   Active    may log in (and, for suppliers, submit bids).
 *   Inactive  deactivated. Cannot log in.
 *   Suspended temporarily blocked. Cannot log in.
 * Allowed changes are listed in USER_STATUS_TRANSITIONS. Pending leaves only through
 * approve() (-> Active) or deactivate() (-> Inactive, i.e. rejected), and nothing can
 * return to Pending. The entity cannot know WHO is acting: the use case must check that
 * the actor holds the "user:manage" permission before calling approve() or activate().
 *
 * Passwords: this class never sees a plain-text password. It stores the hash it is
 * given, never serializes it (toJSON, logging, inspect), and rejects values that
 * cannot be a hash. Hashing is done by a later step (AuthenticationService).
 *
 * Saving, loading and uniqueness of email are NOT done here: use cases do that
 * through UserRepositoryInterface. The class has no framework or database types.
 */

export const USER_STATUSES = ["Pending", "Active", "Inactive", "Suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Statuses a brand-new account may start with. Inactive and Suspended only arise later. */
export const INITIAL_USER_STATUSES = ["Pending", "Active"] as const;
export type InitialUserStatus = (typeof INITIAL_USER_STATUSES)[number];

/** Allowed status changes. Staying in the same status is always a harmless no-op. */
export const USER_STATUS_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = {
  Pending: ["Active", "Inactive"],
  Active: ["Inactive", "Suspended"],
  Inactive: ["Active"],
  Suspended: ["Active", "Inactive"],
};

export const FULL_NAME_MAX_LENGTH = 100;
export const EMAIL_MAX_LENGTH = 254;
/**
 * Safety net, not a format check: real hashes (bcrypt, argon2, scrypt) are far
 * longer, while a typed password usually is not.
 */
export const PASSWORD_HASH_MIN_LENGTH = 20;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegisterUserProps {
  userId: string;
  fullName: string;
  email: string;
  /** Output of the password hasher, never a plain-text password. */
  passwordHash: string;
  role: Role;
  /**
   * Defaults to "Active". The account-creation workflow decides: supplier
   * self-registration passes "Pending"; administrator-created accounts are Active.
   */
  status?: InitialUserStatus;
  /** Defaults to now. */
  createdAt?: Date;
}

export interface RestoreUserProps {
  userId: string;
  fullName: string;
  email: string;
  passwordHash: string;
  roleId: string;
  status: UserStatus;
  createdAt: Date;
}

export interface UpdateProfileProps {
  fullName?: string;
  email?: string;
}

interface ValidUserData {
  userId: string;
  fullName: string;
  email: string;
  passwordHash: string;
  roleId: string;
  status: UserStatus;
  createdAt: Date;
}

export class User {
  readonly #userId: string;
  #fullName: string;
  #email: string;
  #passwordHash: string;
  #roleId: string;
  #status: UserStatus;
  readonly #createdAt: Date;

  private constructor(data: ValidUserData) {
    this.#userId = data.userId;
    this.#fullName = data.fullName;
    this.#email = data.email;
    this.#passwordHash = data.passwordHash;
    this.#roleId = data.roleId;
    this.#status = data.status;
    this.#createdAt = data.createdAt;
  }

  /** ODD register(): builds a new, validated user holding the given role. */
  static register(props: RegisterUserProps): User {
    assertRole(props.role);
    return new User(
      validateUserData({
        userId: props.userId,
        fullName: props.fullName,
        email: props.email,
        passwordHash: props.passwordHash,
        roleId: props.role.roleId,
        status: props.status ?? "Active",
        createdAt: props.createdAt ?? new Date(),
      }, INITIAL_USER_STATUSES),
    );
  }

  /** Rebuilds a user from stored data (used by repository implementations). Validates too. */
  static restore(props: RestoreUserProps): User {
    return new User(validateUserData(props));
  }

  get userId(): string {
    return this.#userId;
  }

  get fullName(): string {
    return this.#fullName;
  }

  /** Always lowercase, so email comparison and uniqueness are case-insensitive. */
  get email(): string {
    return this.#email;
  }

  get roleId(): string {
    return this.#roleId;
  }

  get status(): UserStatus {
    return this.#status;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  /**
   * The stored password hash. Only repositories (to save it) and the authentication
   * flow (to verify it) should read this. Never log it or return it to a client.
   */
  get passwordHash(): string {
    return this.#passwordHash;
  }

  /** ODD updateProfile(). Changes are applied together or not at all. */
  updateProfile(changes: UpdateProfileProps): void {
    const issues: string[] = [];
    let fullName = this.#fullName;
    let email = this.#email;

    if (changes.fullName === undefined && changes.email === undefined) {
      throw new InvalidUserDataException(["at least one of fullName or email is required"]);
    }
    if (changes.fullName !== undefined) fullName = normalizeFullName(changes.fullName, issues);
    if (changes.email !== undefined) email = normalizeEmail(changes.email, issues);
    if (issues.length > 0) throw new InvalidUserDataException(issues);

    this.#fullName = fullName;
    this.#email = email;
  }

  /** ODD changePassword(). Takes a new, already hashed password. */
  changePassword(newPasswordHash: string): void {
    const issues: string[] = [];
    const passwordHash = validatePasswordHash(newPasswordHash, issues);
    if (issues.length > 0) throw new InvalidUserDataException(issues);
    this.#passwordHash = passwordHash;
  }

  /** ODD assignRole(). Only a real Role can be assigned. */
  assignRole(role: Role): void {
    assertRole(role);
    this.#roleId = role.roleId;
  }

  /**
   * Approves a Pending account (Pending -> Active). The only way out of Pending
   * into Active. Throws InvalidUserStatusTransitionException for any other status.
   * Callers must have checked that the actor is an authorized administrator.
   */
  approve(): void {
    if (this.#status !== "Pending") {
      throw new InvalidUserStatusTransitionException(this.#status, "Active");
    }
    this.#status = "Active";
  }

  /** ODD deactivate(). Pending (rejected), Active and Suspended accounts become Inactive. No-op if already Inactive. */
  deactivate(): void {
    this.#moveTo("Inactive");
  }

  /** Re-activates an Inactive or Suspended account. A Pending account must go through approve(). */
  activate(): void {
    this.#moveTo("Active");
  }

  /** Suspends an Active account. */
  suspend(): void {
    this.#moveTo("Suspended");
  }

  isActive(): boolean {
    return this.#status === "Active";
  }

  isPending(): boolean {
    return this.#status === "Pending";
  }

  #moveTo(target: UserStatus): void {
    if (this.#status === target) return;

    const allowed = USER_STATUS_TRANSITIONS[this.#status].includes(target);
    // Pending -> Active is in the table, but only approve() may perform it.
    const bypassesApproval = this.#status === "Pending" && target === "Active";
    if (!allowed || bypassesApproval) {
      throw new InvalidUserStatusTransitionException(this.#status, target);
    }
    this.#status = target;
  }

  /**
   * The account-state half of ODD authenticate(): only Active accounts may log in.
   * Throws AccountInactiveException for Inactive and Suspended accounts.
   */
  assertCanAuthenticate(): void {
    if (!this.isActive()) {
      throw new AccountInactiveException({ details: { status: this.#status } });
    }
  }

  /** Safe representation for logs and responses. The password hash is deliberately left out. */
  toJSON(): {
    userId: string;
    fullName: string;
    email: string;
    roleId: string;
    status: UserStatus;
    createdAt: string;
  } {
    return {
      userId: this.#userId,
      fullName: this.#fullName,
      email: this.#email,
      roleId: this.#roleId,
      status: this.#status,
      createdAt: this.#createdAt.toISOString(),
    };
  }
}

function assertRole(role: unknown): asserts role is Role {
  if (!(role instanceof Role)) {
    throw new InvalidRoleException(["role must be a valid Role"]);
  }
}

function normalizeFullName(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("fullName is required");
    return "";
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > FULL_NAME_MAX_LENGTH) {
    issues.push(`fullName must be at most ${FULL_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

function normalizeEmail(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("email is required");
    return "";
  }
  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    issues.push("email must be a valid email address");
  }
  return email;
}

function validatePasswordHash(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value === "") {
    issues.push("passwordHash is required");
    return "";
  }
  if (/\s/.test(value) || value.length < PASSWORD_HASH_MIN_LENGTH) {
    // Deliberately says nothing about the value itself.
    issues.push("passwordHash must be a hashed password, not a plain-text password");
  }
  return value;
}

/** Validates everything, collects every problem, and returns clean data or throws. */
function validateUserData(
  data: {
    userId: unknown;
    fullName: unknown;
    email: unknown;
    passwordHash: unknown;
    roleId: unknown;
    status: unknown;
    createdAt: unknown;
  },
  allowedStatuses: readonly UserStatus[] = USER_STATUSES,
): ValidUserData {
  const issues: string[] = [];

  if (typeof data.userId !== "string" || !/^\S+$/.test(data.userId)) {
    issues.push("userId is required and must not contain spaces");
  }
  const fullName = normalizeFullName(data.fullName, issues);
  const email = normalizeEmail(data.email, issues);
  const passwordHash = validatePasswordHash(data.passwordHash, issues);

  if (typeof data.roleId !== "string" || !/^\S+$/.test(data.roleId)) {
    issues.push("roleId is required and must not contain spaces");
  }
  if (typeof data.status !== "string" || !(allowedStatuses as readonly string[]).includes(data.status)) {
    issues.push(`status must be one of: ${allowedStatuses.join(", ")}`);
  }
  if (!(data.createdAt instanceof Date) || Number.isNaN(data.createdAt.getTime())) {
    issues.push("createdAt must be a valid date");
  }

  if (issues.length > 0) throw new InvalidUserDataException(issues);

  return {
    userId: data.userId as string,
    fullName,
    email,
    passwordHash,
    roleId: data.roleId as string,
    status: data.status as UserStatus,
    createdAt: new Date((data.createdAt as Date).getTime()),
  };
}
