import {
  InvalidSupplierDataException,
  SupplierNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import type { Permission } from "@/entities/RolePermissionMatrix";
import { Supplier, normalizeSupplierQuery, type UpdateSupplierProfileProps } from "@/entities/Supplier";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { SupplierRepositoryInterface, SupplierUpdateData } from "@/interfaces/repositories/SupplierRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { generateId } from "@/shared/utilities/uuid";
import type { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import type { AuthorizedUserDto } from "@/usecases/authorization/dtos";
import {
  toSupplierDto,
  type ListSuppliersInput,
  type OwnSupplierInput,
  type RegisterSupplierProfileInput,
  type SupplierActionInput,
  type SupplierDto,
  type SupplierListDto,
  type UpdateSupplierProfileInput,
  type VerifySupplierInput,
} from "./dtos";

/**
 * Which existing permissions each operation accepts, in the order they are tried. The approved matrix has
 * supplier:manage and supplier:read (Administrator, Procurement Broker) and supplier:read_own and supplier:update_own
 * (Supplier); no permission is added. THE MAPPING OF THE OPERATIONS THE MATRIX DOES NOT NAME IS A DECISION FOR THE PROJECT TO CONFIRM.
 */
export const SUPPLIER_OPERATION_PERMISSIONS = {
  /** SRS: "Suppliers register and maintain their profiles"; the Broker "manages suppliers". */
  register: ["supplier:manage", "supplier:update_own"],
  update: ["supplier:manage", "supplier:update_own"],
  get: ["supplier:read", "supplier:read_own"],
  getOwn: ["supplier:read_own"],
  /** Listing every supplier is for authorized staff only. */
  list: ["supplier:read"],
  /** No supplier:verify permission exists; a review is managing supplier records. */
  verify: ["supplier:manage"],
} as const satisfies Record<string, readonly Permission[]>;

type Operation = keyof typeof SUPPLIER_OPERATION_PERMISSIONS;

/** What the caller is, once authorized. */
interface Caller {
  userId: string;
  /** "staff": Administrator or Procurement Broker (supplier:manage / supplier:read). "supplier": a Supplier acting on their own profile. */
  kind: "staff" | "supplier";
  roleName: string;
}

/**
 * ODD: usecases.SupplierManagementUseCase (SRS: Supplier Management, UC-04).
 *
 * Application operations for supplier profiles: register, update, get, get own, list and verify. It orchestrates the
 * Supplier entity (which owns the rules) and SupplierRepositoryInterface (which stores the result and keeps registration
 * numbers unique). It contains no database, HTTP or framework code. The User entity keeps passwords, roles and account
 * status; this module never reads or changes them (it only looks a user up to link a profile to an account).
 *
 * Authorization, for every operation and before anything else is read:
 *   AuthorizeUseCase reads the acting user and the user's role from storage, requires an Active account and requires the
 *   STORED role to hold one of the operation's permissions. Nothing from the client or from a token is used. A storage
 *   failure fails the request; it never grants access.
 *
 * Decisions that are NOT in the documents. Each is the most restrictive reading and each needs the project's confirmation:
 *   1. Operation -> permission mapping (see SUPPLIER_OPERATION_PERMISSIONS).
 *   2. Ownership (enforced): a Supplier may register, read and update ONLY the profile whose userId is their own authenticated
 *      user id. Another supplier's profile is reported as not found, so its existence is not revealed. Staff (Administrator,
 *      Procurement Broker) may register, read, update and verify any profile. A permission is honoured only for the role that
 *      the matrix gives it to; any other role (a custom role, Evaluation Committee) is refused, even if its stored permissions
 *      were customized.
 *   3. Registration: a Supplier registers their own profile (they must already have an Active account: an administrator
 *      approves the account first, see RegisterSupplierUseCase). Staff may register a profile for an existing user whose role
 *      is Supplier, whatever that account's status. Each account has at most one profile and each registration number
 *      (ignoring case) one profile.
 *   4. Protected fields: userId, verificationStatus and registrationDate can never be set through register or update. Only
 *      verify() changes the verification status (staff only), plus the automatic reset described in Supplier.
 *   5. A Supplier editing their own company name or registration number resets a Verified profile to Pending; staff edits do not.
 *   6. Verification is decided by Administrators and Procurement Brokers (both hold supplier:manage). The documents name no verifier.
 *   7. Listing: staff only, filtered by verification status and paged. Free-text search is not documented and is not offered.
 *   8. Not implemented in Stage 2D: document submission, performance history, bid history, deleting a supplier.
 */
export class SupplierManagementUseCase {
  constructor(
    private readonly authorization: AuthorizeUseCase,
    private readonly suppliers: SupplierRepositoryInterface,
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = generateId,
  ) {}

  /** ODD register(). The profile starts Pending. */
  async registerSupplier(input: RegisterSupplierProfileInput): Promise<SupplierDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "register");
    const userId = await this.resolveOwnerId(caller, input.userId);

    const supplier = Supplier.register({
      supplierId: this.newId(),
      userId,
      companyName: input.companyName,
      registrationNumber: input.registrationNumber,
      email: input.email,
      phoneNumber: input.phoneNumber,
      address: input.address,
      registrationDate: now,
    });
    // The repository reports a taken registration number or an account that has a profile already (DuplicateRegistrationException).
    return toSupplierDto(await this.suppliers.create(supplier));
  }

  /** ODD updateProfile(). Profile fields only. */
  async updateSupplier(input: UpdateSupplierProfileInput): Promise<SupplierDto> {
    const caller = await this.authorize(input?.actingUserId, "update");
    const current = await this.loadInScope(caller, input.supplierId);

    // Validates every value and decides about the verification reset; throws before any write.
    const draft = Supplier.restore({ ...current.toJSON(), registrationDate: current.registrationDate });
    draft.updateProfile(input.changes as UpdateSupplierProfileProps, { resetVerification: caller.kind === "supplier" });

    const data: Record<string, unknown> = {};
    for (const field of Object.keys(input.changes) as Array<keyof UpdateSupplierProfileProps>) {
      if (input.changes[field] !== undefined) data[field] = draft[field];
    }
    if (draft.verificationStatus !== current.verificationStatus) data.verificationStatus = draft.verificationStatus;

    return toSupplierDto(await this.suppliers.update(current.supplierId, data as SupplierUpdateData));
  }

  /** ODD verifySupplier(). Staff only. Sets Verified or Rejected. */
  async verifySupplier(input: VerifySupplierInput): Promise<SupplierDto> {
    const caller = await this.authorize(input?.actingUserId, "verify");
    const current = await this.loadInScope(caller, input.supplierId);

    const before = current.verificationStatus;
    current.verify(input.status); // validates the outcome and refuses a no-op, before any write
    // `expectedStatus` makes the write fail if another reviewer changed the status since it was read.
    return toSupplierDto(await this.suppliers.updateVerificationStatus(current.supplierId, input.status, { expectedStatus: before }));
  }

  /** ODD SupplierController.getSupplier. A Supplier can read only their own profile. */
  async getSupplier(input: SupplierActionInput): Promise<SupplierDto> {
    const caller = await this.authorize(input?.actingUserId, "get");
    return toSupplierDto(await this.loadInScope(caller, input.supplierId));
  }

  /** The caller's own profile (for a Supplier to learn their supplierId). */
  async getOwnSupplier(input: OwnSupplierInput): Promise<SupplierDto> {
    const caller = await this.authorize(input?.actingUserId, "getOwn");
    const supplier = await this.suppliers.findByUserId(caller.userId);
    if (supplier === null) throw new SupplierNotFoundException();
    return toSupplierDto(supplier);
  }

  /** ODD SupplierController.listSuppliers. Staff only. Newest registration first. */
  async listSuppliers(input: ListSuppliersInput): Promise<SupplierListDto> {
    const caller = await this.authorize(input?.actingUserId, "list");
    if (caller.kind !== "staff") throw new UnauthorizedAccessException();

    const query = normalizeSupplierQuery({ verificationStatus: input.verificationStatus, limit: input.limit, skip: input.skip });
    const found = await this.suppliers.findAll({
      verificationStatus: query.statuses ?? undefined,
      limit: query.limit,
      skip: query.skip,
    });
    return { suppliers: found.map(toSupplierDto), limit: query.limit, skip: query.skip };
  }

  /**
   * Tries the operation's permissions in order. Only "not allowed" moves on to the next one; every other failure
   * (no session user, inactive account, storage error) stops the request. The role then decides what the grant means (decision 2).
   */
  private async authorize(actingUserId: string, operation: Operation): Promise<Caller> {
    let granted: AuthorizedUserDto | null = null;
    let refusal: unknown = null;
    for (const permission of SUPPLIER_OPERATION_PERMISSIONS[operation]) {
      try {
        granted = await this.authorization.execute({ userId: actingUserId, permission });
        break;
      } catch (error) {
        if (!(error instanceof UnauthorizedAccessException)) throw error;
        refusal = error;
      }
    }
    if (granted === null) throw refusal ?? new UnauthorizedAccessException();

    const { userId, roleName } = granted.user;
    const own = granted.permission === "supplier:read_own" || granted.permission === "supplier:update_own";
    if (own && roleName === "Supplier") return { userId, roleName, kind: "supplier" };
    if (!own && (roleName === "Administrator" || roleName === "Procurement Broker")) return { userId, roleName, kind: "staff" };
    throw new UnauthorizedAccessException(); // any other role: fail closed
  }

  /** Loads a supplier the caller may see. Out of scope looks exactly like "does not exist". */
  private async loadInScope(caller: Caller, supplierId: unknown): Promise<Supplier> {
    if (typeof supplierId !== "string" || supplierId.trim() === "") throw new SupplierNotFoundException();
    const supplier = await this.suppliers.findById(supplierId);
    if (supplier === null) throw new SupplierNotFoundException();
    if (caller.kind === "supplier" && supplier.userId !== caller.userId) throw new SupplierNotFoundException();
    return supplier;
  }

  /** Which account a new profile belongs to: a Supplier's own, or (staff) an existing Supplier user. */
  private async resolveOwnerId(caller: Caller, requested: unknown): Promise<string> {
    if (caller.kind === "supplier") {
      if (requested !== undefined && requested !== caller.userId) {
        throw new InvalidSupplierDataException(["userId can only be set to another user by an Administrator or Procurement Broker"]);
      }
      return caller.userId;
    }

    if (typeof requested !== "string" || requested.trim() === "") {
      throw new InvalidSupplierDataException(["userId is required: name the Supplier user the profile belongs to"]);
    }
    const user = await this.users.findById(requested);
    const role = user ? await this.roles.findById(user.roleId) : null;
    if (!user || role?.roleName !== "Supplier") {
      throw new InvalidSupplierDataException(["userId must identify a user with the Supplier role"]);
    }
    return user.userId;
  }
}
