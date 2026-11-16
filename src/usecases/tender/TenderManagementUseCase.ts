import {
  InvalidTenderDataException,
  TenderNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import type { Permission } from "@/entities/RolePermissionMatrix";
import { Tender, normalizeTenderQuery, type TenderStatus, type UpdateTenderProps } from "@/entities/Tender";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { generateId } from "@/shared/utilities/uuid";
import type { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import {
  toTenderDto,
  type CreateTenderInput,
  type ListTendersInput,
  type TenderActionInput,
  type TenderDto,
  type TenderListDto,
  type UpdateTenderInput,
} from "./dtos";

/**
 * Which existing permission each operation needs. The approved matrix has only tender:create, tender:update,
 * tender:publish and tender:read, and no new permission may be invented, so the operations the matrix does not
 * name are mapped onto the closest one. THIS MAPPING IS A DECISION FOR THE PROJECT TO CONFIRM (see below).
 * Administrators and Procurement Brokers hold all four, so today it makes no difference between them; it matters
 * only if an administrator customizes a role's stored permissions.
 */
export const TENDER_OPERATION_PERMISSIONS = {
  create: "tender:create",
  update: "tender:update",
  /** SRS: "authorized users [may] publish and close tenders"; ODD TenderController lists publish and close together. */
  publish: "tender:publish",
  /** Closing is a lifecycle change like publishing. No tender:close permission exists. */
  close: "tender:publish",
  /** Cancelling is a lifecycle change like publishing. No tender:cancel permission exists. */
  cancel: "tender:publish",
  /** Deleting a Draft is managing its content, like editing it. No tender:delete permission exists. */
  delete: "tender:update",
  get: "tender:read",
  list: "tender:read",
} as const satisfies Record<string, Permission>;

/**
 * ODD: usecases.TenderManagementUseCase (SRS: Tender Management, UC-03).
 *
 * Application operations for tenders: create, update, publish, get, list, close, cancel and delete a Draft.
 * It orchestrates the Tender entity (which owns the rules and the status transitions) and
 * TenderRepositoryInterface (which stores the result and protects against concurrent changes). It contains no
 * database, HTTP or framework code.
 *
 * Authorization, for every operation and before anything else is read:
 *   AuthorizeUseCase reads the acting user and the user's role from storage, requires an Active account and requires the
 *   STORED role to hold the permission. Nothing from the client or from a token is used, so unauthorized callers learn
 *   nothing about whether a tender exists. A storage failure fails the request; it never grants access.
 *
 * Rules taken from the documents and implemented here:
 *   - Status changes go through the entity (publish, close, cancel) and are stored with `expectedStatus`, so two
 *     users acting at the same moment cannot both succeed (the loser gets InvalidTenderStatusException).
 *   - Only a Draft can be deleted. Other tenders are kept.
 *   - A Published tender can be closed only once its deadline is reached.
 *
 * Decisions that are NOT in the documents. Each is the most restrictive reading, and each needs the project's confirmation:
 *   1. Operation -> permission mapping (see TENDER_OPERATION_PERMISSIONS).
 *   2. Broker ownership (SECURITY CORRECTION, enforced): update, publish, close, cancel and delete require the caller to be an
 *      Administrator, or a Procurement Broker whose authenticated user id equals the tender's `brokerId`. The role comes from
 *      storage (AuthorizeUseCase), never from the client. Any other role is refused (fail closed), even if an administrator
 *      customized its stored permissions. A refused broker gets UnauthorizedAccessException, after the permission check.
 *      Reading is limited the same way (decision 6).
 *   3. Who is the responsible broker: see CreateTenderInput.brokerId.
 *   4. Closing: only after the deadline. The ODD also mentions "authorized closure" before the deadline, but nothing says who
 *      may authorize it, so early closure is not offered by this use case (the entity supports it, nothing calls it).
 *   5. Edits of a Published tender before its deadline are allowed (ODD: "before the applicable deadline"), including budget,
 *      requirements and criteria, even though suppliers may already be preparing bids. Which fields may change after
 *      publication, and whether bidders must be told, is undecided.
 *   6. Read scope (Option B, enforced for get and list; the matrix itself is unchanged and says "yes" to brokers):
 *        Administrator         all tenders.
 *        Procurement Broker    only tenders whose brokerId is their own user id. Another broker's tender is reported as not
 *                              found; a list is always limited to the caller's own tenders (asking for another broker's finds nothing).
 *        Supplier              only Published tenders (SRS: suppliers view tenders once they are published). Any other status is
 *                              reported as not found. Closed or Awarded tenders a supplier bid on are not shown (needs the Bid module).
 *        Evaluation Committee  nothing yet: access is limited to assigned tenders and assignment is not modelled, so it is denied.
 *        Any other role        denied (fail closed), whatever permissions its stored role holds.
 *   7. List filters are those of TenderRepositoryInterface (status, broker, category, paging). Free-text search is not documented
 *      and is not offered.
 */
export class TenderManagementUseCase {
  constructor(
    private readonly authorization: AuthorizeUseCase,
    private readonly tenders: TenderRepositoryInterface,
    private readonly users: UserRepositoryInterface,
    private readonly roles: RoleRepositoryInterface,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = generateId,
  ) {}

  /** ODD createTender(). The tender starts as a Draft. */
  async createTender(input: CreateTenderInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "create");

    const brokerId = await this.resolveBrokerId(caller.user.userId, caller.user.roleName, input.brokerId);
    const tender = Tender.create({
      tenderId: this.newId(),
      title: input.title,
      description: input.description,
      category: input.category,
      estimatedBudget: input.estimatedBudget,
      requirements: input.requirements,
      evaluationCriteria: input.evaluationCriteria,
      submissionDeadline: input.submissionDeadline,
      brokerId,
      createdAt: now,
    });
    return toTenderDto(await this.tenders.create(tender), now);
  }

  /** ODD updateTender(). Draft, or Published before the deadline (the entity enforces both). */
  async updateTender(input: UpdateTenderInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "update");
    const current = await this.load(input.tenderId);
    assertMayManage(caller.user, current);

    current.updateTender(input.changes, now); // validates everything, throws before any write
    const stored = await this.tenders.update(current.tenderId, valuesOf(current, input.changes));
    return toTenderDto(stored, now);
  }

  /** ODD publish(). Draft only, with a future deadline, at least one requirement and at least one criterion. */
  async publishTender(input: TenderActionInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "publish");
    const tender = await this.load(input.tenderId);
    assertMayManage(caller.user, tender);

    const before = tender.status;
    tender.publish(now);
    const stored = await this.tenders.updateStatus(tender.tenderId, "Published", {
      publicationDate: tender.publicationDate ?? now,
      expectedStatus: before,
    });
    return toTenderDto(stored, now);
  }

  /** ODD close(). Published only, and only once the submission deadline has been reached. */
  async closeTender(input: TenderActionInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "close");
    const tender = await this.load(input.tenderId);
    assertMayManage(caller.user, tender);

    const before = tender.status;
    tender.close(now); // no early closure: see decision 4
    return toTenderDto(await this.tenders.updateStatus(tender.tenderId, "Closed", { expectedStatus: before }), now);
  }

  /** ODD cancel(). Draft or Published only. */
  async cancelTender(input: TenderActionInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "cancel");
    const tender = await this.load(input.tenderId);
    assertMayManage(caller.user, tender);

    const before = tender.status;
    tender.cancel();
    return toTenderDto(await this.tenders.updateStatus(tender.tenderId, "Cancelled", { expectedStatus: before }), now);
  }

  /** Deletes a tender that was never published. Any other tender is kept (InvalidTenderStatusException). */
  async deleteDraftTender(input: TenderActionInput): Promise<void> {
    const caller = await this.authorize(input?.actingUserId, "delete");
    const tender = await this.load(input.tenderId);
    assertMayManage(caller.user, tender);

    tender.assertDeletable();
    await this.tenders.delete(tender.tenderId);
  }

  /** ODD TenderController.getTender. Subject to the read scope of decision 6. */
  async getTender(input: TenderActionInput): Promise<TenderDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "get");
    const scope = readScope(caller.user);

    const tender = await this.load(input.tenderId);
    // Out of scope looks exactly like "does not exist", so a tender's existence is not revealed.
    if (scope.statuses && !scope.statuses.includes(tender.status)) throw new TenderNotFoundException();
    if (scope.brokerId !== null && tender.brokerId !== scope.brokerId) throw new TenderNotFoundException();
    return toTenderDto(tender, now);
  }

  /** ODD TenderController.listTenders. Newest first. Subject to the read scope of decision 6. */
  async listTenders(input: ListTendersInput): Promise<TenderListDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "list");
    const scope = readScope(caller.user);

    const query = normalizeTenderQuery({
      status: input.status,
      brokerId: input.brokerId,
      category: input.category,
      limit: input.limit,
      skip: input.skip,
    });

    const empty = { tenders: [], limit: query.limit, skip: query.skip };
    let statuses = query.statuses;
    if (scope.statuses) {
      const allowed = scope.statuses;
      statuses = statuses ? statuses.filter((status) => allowed.includes(status)) : [...allowed];
      if (statuses.length === 0) return empty;
    }
    // A broker is always limited to their own tenders; asking for another broker's tenders finds nothing.
    let brokerId = query.brokerId;
    if (scope.brokerId !== null) {
      if (brokerId !== null && brokerId !== scope.brokerId) return empty;
      brokerId = scope.brokerId;
    }

    const found = await this.tenders.findAll({
      status: statuses ?? undefined,
      brokerId: brokerId ?? undefined,
      category: query.category ?? undefined,
      limit: query.limit,
      skip: query.skip,
    });
    return { tenders: found.map((tender) => toTenderDto(tender, now)), limit: query.limit, skip: query.skip };
  }

  private authorize(actingUserId: string, operation: keyof typeof TENDER_OPERATION_PERMISSIONS) {
    return this.authorization.execute({ userId: actingUserId, permission: TENDER_OPERATION_PERMISSIONS[operation] });
  }

  /** Loads a tender. An id that is not a non-empty text can never match, so it is not passed to storage at all. */
  private async load(tenderId: unknown): Promise<Tender> {
    if (typeof tenderId !== "string" || tenderId.trim() === "") throw new TenderNotFoundException();
    const tender = await this.tenders.findById(tenderId);
    if (tender === null) throw new TenderNotFoundException();
    return tender;
  }

  private async resolveBrokerId(actingUserId: string, actingRoleName: string, requested: unknown): Promise<string> {
    if (actingRoleName === "Procurement Broker") {
      if (requested !== undefined && requested !== actingUserId) {
        throw new InvalidTenderDataException(["brokerId can only be set to another broker by an Administrator"]);
      }
      return actingUserId;
    }

    // An Administrator (or any other role holding tender:create) must name the responsible broker.
    if (typeof requested !== "string" || requested.trim() === "") {
      throw new InvalidTenderDataException(["brokerId is required: name the responsible Procurement Broker"]);
    }
    const user = await this.users.findById(requested);
    const role = user ? await this.roles.findById(user.roleId) : null;
    if (!user || user.status !== "Active" || role?.roleName !== "Procurement Broker") {
      throw new InvalidTenderDataException(["brokerId must identify an active Procurement Broker"]);
    }
    return user.userId;
  }
}

/** What one caller may read. `null` means no limit on that dimension. */
interface ReadScope {
  statuses: readonly TenderStatus[] | null;
  brokerId: string | null;
}

/**
 * Read scope from the STORED role and user id (via AuthorizeUseCase), never from client input:
 * Administrator all tenders; Procurement Broker only tenders whose brokerId is their own user id; Supplier only Published
 * tenders; every other role (Evaluation Committee until assignment exists, or any custom role) is refused.
 */
function readScope(user: { userId: string; roleName: string }): ReadScope {
  switch (user.roleName) {
    case "Administrator":
      return { statuses: null, brokerId: null };
    case "Procurement Broker":
      return { statuses: null, brokerId: user.userId };
    case "Supplier":
      return { statuses: ["Published"], brokerId: null };
    default:
      throw new UnauthorizedAccessException();
  }
}

/** The entity's validated values for exactly the fields the caller asked to change. */
function valuesOf(tender: Tender, changes: UpdateTenderProps): UpdateTenderProps {
  const values: Record<string, unknown> = {};
  for (const field of Object.keys(changes) as Array<keyof UpdateTenderProps>) {
    if (changes[field] !== undefined) values[field] = tender[field];
  }
  return values as UpdateTenderProps;
}

/**
 * Ownership rule for every change to an existing tender. The role name comes from the stored user (via AuthorizeUseCase).
 * Administrators manage all tenders; a Procurement Broker manages only tenders whose brokerId is their own user id.
 */
function assertMayManage(user: { userId: string; roleName: string }, tender: Tender): void {
  if (user.roleName === "Administrator") return;
  if (user.roleName === "Procurement Broker" && tender.brokerId === user.userId) return;
  throw new UnauthorizedAccessException();
}
