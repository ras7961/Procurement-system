import { InvalidSupplierDataException, SupplierVerificationException } from "./exceptions";

/**
 * ODD: entities.Supplier (SRS: Supplier Management, UC-04).
 *
 * The business profile of a supplier company. It is NOT an account: the User entity keeps the password, the role and
 * the account status. The profile points to its account with `userId` and holds none of those.
 *
 * ODD operation mapping:
 *   register()                  -> Supplier.register()  (and Supplier.restore() when loading stored data)
 *   updateProfile()             -> updateProfile()
 *   verifySupplier()            -> verify()
 *   updateQualificationStatus() -> verify() (see decision 2)
 *   submitDocuments()           -> NOT in Stage 2D: it needs the document module and file storage.
 *   getSubmittedBids() / getPerformanceHistory() -> NOT here: they need the Bid and Evaluation modules, and an entity
 *                                  must not depend on repositories.
 *
 * Documented differences from the ODD (the documents conflict or are silent; each needs the project's confirmation):
 *   1. `userId` is added. The ODD says the profile is associated with the registered user account but lists no attribute
 *      for it; ownership ("a supplier maintains only its own profile") cannot be enforced without it. One account has at
 *      most one profile.
 *   2. The ODD lists both `qualificationStatus` (Pending, Verified, Rejected) and `verificationStatus` (no values) for what
 *      is the same idea. Only `verificationStatus` exists here, with the ODD's three values. A separate qualification
 *      outcome needs qualification documents and criteria, which no document defines.
 *   3. `email` is the company's CONTACT email. It is independent of the login email held by User and never used to sign in.
 *   4. The ODD `registrationDate` is kept; it also orders lists.
 *
 * Verification rules (assumption, the documents define none): a new profile is Pending. A reviewer sets it to Verified or
 * Rejected; either can later be changed to the other. Setting the status it already has, or Pending, is refused.
 * A supplier editing its own company name or registration number resets a Verified profile to Pending (the reviewed identity
 * changed); this is requested by the use case through `resetVerification`.
 *
 * Saving, loading and uniqueness are NOT done here: use cases do that through SupplierRepositoryInterface.
 * No framework or database types.
 */

export const VERIFICATION_STATUSES = ["Pending", "Verified", "Rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/** Statuses a reviewer may set. */
export const REVIEW_OUTCOMES = ["Verified", "Rejected"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

// Implementation limits (the documents define none): they keep records and requests a sane size.
export const SUPPLIER_COMPANY_NAME_MAX_LENGTH = 200;
export const SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH = 100;
export const SUPPLIER_EMAIL_MAX_LENGTH = 254;
export const SUPPLIER_PHONE_MAX_LENGTH = 30;
export const SUPPLIER_ADDRESS_MAX_LENGTH = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{3,}$/;

export interface RegisterSupplierProfileProps {
  supplierId: string;
  userId: string;
  companyName: string;
  registrationNumber: string;
  email: string;
  phoneNumber: string;
  address: string;
  /** Defaults to now. */
  registrationDate?: Date;
}

export interface RestoreSupplierProps {
  supplierId: string;
  userId: string;
  companyName: string;
  registrationNumber: string;
  email: string;
  phoneNumber: string;
  address: string;
  verificationStatus: VerificationStatus;
  registrationDate: Date;
}

/** The fields updateProfile() can change. supplierId, userId, verificationStatus and registrationDate cannot. */
export interface UpdateSupplierProfileProps {
  companyName?: string;
  registrationNumber?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
}

const PROFILE_FIELDS = ["companyName", "registrationNumber", "email", "phoneNumber", "address"] as const;
/** Changing either of these changes the identity a reviewer verified. */
const IDENTITY_FIELDS = ["companyName", "registrationNumber"] as const;

/** Compares registration numbers the way uniqueness is decided: ignoring case and surrounding spaces. */
export function registrationNumberKey(registrationNumber: string): string {
  return registrationNumber.trim().toLowerCase();
}

type ValidSupplierData = RestoreSupplierProps;

export class Supplier {
  readonly #supplierId: string;
  readonly #userId: string;
  #companyName: string;
  #registrationNumber: string;
  #email: string;
  #phoneNumber: string;
  #address: string;
  #verificationStatus: VerificationStatus;
  readonly #registrationDate: Date;

  private constructor(data: ValidSupplierData) {
    this.#supplierId = data.supplierId;
    this.#userId = data.userId;
    this.#companyName = data.companyName;
    this.#registrationNumber = data.registrationNumber;
    this.#email = data.email;
    this.#phoneNumber = data.phoneNumber;
    this.#address = data.address;
    this.#verificationStatus = data.verificationStatus;
    this.#registrationDate = data.registrationDate;
  }

  /** ODD register(): builds a new profile. It always starts Pending. */
  static register(props: RegisterSupplierProfileProps): Supplier {
    return Supplier.restore({
      supplierId: props?.supplierId,
      userId: props?.userId,
      companyName: props?.companyName,
      registrationNumber: props?.registrationNumber,
      email: props?.email,
      phoneNumber: props?.phoneNumber,
      address: props?.address,
      verificationStatus: "Pending",
      registrationDate: props?.registrationDate ?? new Date(),
    });
  }

  /** Rebuilds a profile from stored data (used by repository implementations). Validates everything. */
  static restore(props: RestoreSupplierProps): Supplier {
    const issues: string[] = [];
    const data = readSupplierData({ ...props }, issues);
    if (issues.length > 0 || data === null) throw new InvalidSupplierDataException(issues);
    return new Supplier(data);
  }

  get supplierId(): string {
    return this.#supplierId;
  }
  get userId(): string {
    return this.#userId;
  }
  get companyName(): string {
    return this.#companyName;
  }
  get registrationNumber(): string {
    return this.#registrationNumber;
  }
  get email(): string {
    return this.#email;
  }
  get phoneNumber(): string {
    return this.#phoneNumber;
  }
  get address(): string {
    return this.#address;
  }
  get verificationStatus(): VerificationStatus {
    return this.#verificationStatus;
  }
  get registrationDate(): Date {
    return new Date(this.#registrationDate.getTime());
  }

  /**
   * ODD updateProfile(). Changes nothing when it throws.
   * With `resetVerification`, a Verified profile whose company name or registration number actually changes goes back to Pending.
   */
  updateProfile(changes: UpdateSupplierProfileProps, options: { resetVerification?: boolean } = {}): void {
    const issues: string[] = [];
    const input = (changes ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!(PROFILE_FIELDS as readonly string[]).includes(key)) issues.push(`${key} cannot be changed`);
    }
    const provided = PROFILE_FIELDS.filter((field) => input[field] !== undefined);
    if (provided.length === 0 && issues.length === 0) issues.push("at least one field to update is required");

    const next = {
      companyName: this.#companyName,
      registrationNumber: this.#registrationNumber,
      email: this.#email,
      phoneNumber: this.#phoneNumber,
      address: this.#address,
    };
    if (input.companyName !== undefined) next.companyName = readText(input.companyName, "companyName", SUPPLIER_COMPANY_NAME_MAX_LENGTH, issues);
    if (input.registrationNumber !== undefined) {
      next.registrationNumber = readText(input.registrationNumber, "registrationNumber", SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH, issues);
    }
    if (input.email !== undefined) next.email = readEmail(input.email, issues);
    if (input.phoneNumber !== undefined) next.phoneNumber = readPhone(input.phoneNumber, issues);
    if (input.address !== undefined) next.address = readText(input.address, "address", SUPPLIER_ADDRESS_MAX_LENGTH, issues);
    if (issues.length > 0) throw new InvalidSupplierDataException(issues);

    const identityChanged = IDENTITY_FIELDS.some(
      (field) => input[field] !== undefined && (field === "registrationNumber" ? registrationNumberKey(next[field]) !== registrationNumberKey(this[field]) : next[field] !== this[field]),
    );
    this.#companyName = next.companyName;
    this.#registrationNumber = next.registrationNumber;
    this.#email = next.email;
    this.#phoneNumber = next.phoneNumber;
    this.#address = next.address;
    if (options.resetVerification === true && identityChanged && this.#verificationStatus === "Verified") {
      this.#verificationStatus = "Pending";
    }
  }

  /** ODD verifySupplier(): a reviewer's decision. Refused when it would not change the status. */
  verify(outcome: ReviewOutcome): void {
    if (!(REVIEW_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new InvalidSupplierDataException([`status must be one of: ${REVIEW_OUTCOMES.join(", ")}`]);
    }
    if (this.#verificationStatus === outcome) throw new SupplierVerificationException(this.#verificationStatus, `set status to ${outcome}`);
    this.#verificationStatus = outcome;
  }

  toJSON(): {
    supplierId: string;
    userId: string;
    companyName: string;
    registrationNumber: string;
    email: string;
    phoneNumber: string;
    address: string;
    verificationStatus: VerificationStatus;
    registrationDate: string;
  } {
    return {
      supplierId: this.#supplierId,
      userId: this.#userId,
      companyName: this.#companyName,
      registrationNumber: this.#registrationNumber,
      email: this.#email,
      phoneNumber: this.#phoneNumber,
      address: this.#address,
      verificationStatus: this.#verificationStatus,
      registrationDate: this.#registrationDate.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Query options shared by every SupplierRepositoryInterface implementation.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SUPPLIER_PAGE_SIZE = 100;
export const MAX_SUPPLIER_PAGE_SIZE = 500;

export interface SupplierQueryInput {
  verificationStatus?: VerificationStatus | readonly VerificationStatus[];
  limit?: number;
  skip?: number;
}

export interface NormalizedSupplierQuery {
  statuses: VerificationStatus[] | null;
  limit: number;
  skip: number;
}

/** Validates list filters and paging once, so every repository treats the same input the same way. */
export function normalizeSupplierQuery(input: SupplierQueryInput = {}): NormalizedSupplierQuery {
  const issues: string[] = [];

  let statuses: VerificationStatus[] | null = null;
  if (input.verificationStatus !== undefined) {
    const list = Array.isArray(input.verificationStatus) ? input.verificationStatus : [input.verificationStatus];
    if (list.length === 0 || !list.every(isVerificationStatus)) {
      issues.push(`verificationStatus must be one or more of: ${VERIFICATION_STATUSES.join(", ")}`);
    } else statuses = [...new Set(list)] as VerificationStatus[];
  }

  let limit = DEFAULT_SUPPLIER_PAGE_SIZE;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SUPPLIER_PAGE_SIZE) {
      issues.push(`limit must be a whole number from 1 to ${MAX_SUPPLIER_PAGE_SIZE}`);
    } else limit = input.limit;
  }
  let skip = 0;
  if (input.skip !== undefined) {
    if (!Number.isInteger(input.skip) || input.skip < 0) issues.push("skip must be a whole number of 0 or more");
    else skip = input.skip;
  }

  if (issues.length > 0) throw new InvalidSupplierDataException(issues);
  return { statuses, limit, skip };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers. Each one collects problems into `issues` and returns a usable value.
// ---------------------------------------------------------------------------------------------

function readSupplierData(raw: Record<string, unknown>, issues: string[]): ValidSupplierData | null {
  const supplierId = readId(raw.supplierId, "supplierId", issues);
  const userId = readId(raw.userId, "userId", issues);
  const companyName = readText(raw.companyName, "companyName", SUPPLIER_COMPANY_NAME_MAX_LENGTH, issues);
  const registrationNumber = readText(raw.registrationNumber, "registrationNumber", SUPPLIER_REGISTRATION_NUMBER_MAX_LENGTH, issues);
  const email = readEmail(raw.email, issues);
  const phoneNumber = readPhone(raw.phoneNumber, issues);
  const address = readText(raw.address, "address", SUPPLIER_ADDRESS_MAX_LENGTH, issues);
  if (!isVerificationStatus(raw.verificationStatus)) issues.push(`verificationStatus must be one of: ${VERIFICATION_STATUSES.join(", ")}`);

  const date = raw.registrationDate;
  let registrationDate = new Date(Number.NaN);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) issues.push("registrationDate must be a valid date");
  else registrationDate = new Date(date.getTime());

  if (issues.length > 0) return null;
  return {
    supplierId,
    userId,
    companyName,
    registrationNumber,
    email,
    phoneNumber,
    address,
    verificationStatus: raw.verificationStatus as VerificationStatus,
    registrationDate,
  };
}

function readId(value: unknown, field: string, issues: string[]): string {
  if (typeof value !== "string" || !/^\S+$/.test(value)) {
    issues.push(`${field} is required and must not contain spaces`);
    return "";
  }
  return value;
}

function readText(value: unknown, field: string, maxLength: number, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field} is required`);
    return "";
  }
  const text = value.trim();
  if (text.length > maxLength) issues.push(`${field} must be at most ${maxLength} characters`);
  return text;
}

function readEmail(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("email is required");
    return "";
  }
  const email = value.trim();
  if (email.length > SUPPLIER_EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) issues.push("email must be a valid email address");
  return email;
}

function readPhone(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("phoneNumber is required");
    return "";
  }
  const phone = value.trim();
  if (phone.length > SUPPLIER_PHONE_MAX_LENGTH || !PHONE_PATTERN.test(phone)) issues.push("phoneNumber must be a valid phone number");
  return phone;
}
