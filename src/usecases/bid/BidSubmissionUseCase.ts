import { Bid, normalizeBidQuery } from "@/entities/Bid";
import {
  BidNotFoundException,
  BidSubmissionException,
  DeadlineExpiredException,
  DuplicateBidException,
  InvalidBidDataException,
  InvalidTenderStatusException,
  TenderClosedException,
  TenderNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import type { Permission } from "@/entities/RolePermissionMatrix";
import type { Tender } from "@/entities/Tender";
import type { BidRepositoryInterface } from "@/interfaces/repositories/BidRepositoryInterface";
import type { SupplierRepositoryInterface } from "@/interfaces/repositories/SupplierRepositoryInterface";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import { generateId } from "@/shared/utilities/uuid";
import type { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import type { AuthorizedUserDto } from "@/usecases/authorization/dtos";
import {
  toBidDto,
  type BidActionInput,
  type BidDto,
  type BidListDto,
  type ListBidsInput,
  type SubmitBidInput,
  type UpdateBidInput,
} from "./dtos";

/**
 * Which existing permissions each operation accepts, in the order they are tried. The approved matrix has bid:submit
 * (Supplier) and bid:read (Administrator, Procurement Broker, and Evaluation Committee "restricted"); NO permission is added
 * and the matrix is unchanged. THE MAPPING OF THE OPERATIONS THE MATRIX DOES NOT NAME IS A DECISION FOR THE PROJECT TO CONFIRM:
 * a Supplier has no bid:read, so a Supplier's access to their OWN bids (read, update, withdraw) rides on bid:submit.
 */
export const BID_OPERATION_PERMISSIONS = {
  submit: ["bid:submit"],
  /** SRS/ODD updateBid(): a supplier changes their own bid before the deadline. */
  update: ["bid:submit"],
  /** ODD withdraw(): a supplier withdraws their own bid before the deadline. */
  withdraw: ["bid:submit"],
  get: ["bid:submit", "bid:read"],
  list: ["bid:submit", "bid:read"],
} as const satisfies Record<string, readonly Permission[]>;

type Operation = keyof typeof BID_OPERATION_PERMISSIONS;

/** What the caller is, once authorized. */
interface Caller {
  userId: string;
  /** "supplier": a Supplier acting on their own bids (bid:submit). "staff": Administrator or Procurement Broker (bid:read). */
  kind: "supplier" | "staff";
  roleName: string;
}

/** Tender statuses in which sealed bids are opened to staff: the tender has closed (or has gone on to be awarded). */
const UNSEALED_TENDER_STATUSES = ["Closed", "Awarded"] as const;

/**
 * ODD: usecases.BidSubmissionUseCase (SRS: Bid Management and Evaluation, UC-05 Bid Submission).
 *
 * Application operations for bids: submit, update, withdraw, get and list. It orchestrates the Bid entity (which owns the bid's
 * own rules) with TenderRepositoryInterface, SupplierRepositoryInterface and BidRepositoryInterface (which stores the result and
 * enforces one bid per supplier per tender). It contains no database, HTTP or framework code. It performs NO evaluation: no
 * scoring, no status change other than withdrawal, and nothing from the AI module.
 *
 * Authorization, for every operation and before anything else is read:
 *   AuthorizeUseCase reads the acting user and the user's role from storage, requires an Active account and requires the STORED
 *   role to hold one of the operation's permissions. Nothing from the client or from a token is used. A storage failure fails the
 *   request; it never grants access. Supplier eligibility is exactly that: an authenticated, Active Supplier account. Supplier
 *   VERIFICATION is not required (no document requires it).
 *
 * Rules implemented (from your Stage 2E decisions, the ODD and the SRS):
 *   1. Ownership: a bid's supplierId is the id of the profile linked to the authenticated user (SupplierRepositoryInterface
 *      .findByUserId). It is never taken from the client. A Supplier with no profile cannot bid (BidSubmissionException).
 *   2. Eligible tender (authoritative database state, server clock): the tender must exist and be Published with a deadline still
 *      in the future. Draft and Cancelled tenders are reported as not found (a Supplier cannot see them). Closed, Awarded, or
 *      Published-but-past-the-deadline tenders give TenderClosedException.
 *   3. One bid per supplier per tender, in any status (a withdrawn bid still counts): checked here, and enforced by a unique
 *      index so concurrent requests cannot both succeed. Validation happens before anything is stored, so a rejected request
 *      creates no record and does not use up the supplier's submission.
 *   4. Update and withdraw: own bid only, status Submitted only, and only while the tender is Published and before its deadline
 *      (DeadlineExpiredException after the deadline; TenderClosedException if the tender is no longer Published). After the
 *      deadline a bid is immutable through this use case. Withdrawal is final: a withdrawn bid cannot be resubmitted.
 *   5. Confidentiality, Option B (RBAC with tender-level visibility and data isolation):
 *        Supplier              only their own bids, always (their own content).
 *        Administrator         any tender's bids, but only once the tender is Closed or Awarded.
 *        Procurement Broker    only bids of tenders whose brokerId is their own user id (another broker's tender looks like
 *                              "not found"), and only once the tender is Closed or Awarded.
 *        Evaluation Committee  nothing yet: access is limited to ASSIGNED tenders and no assignment model exists, so it is denied.
 *        Any other role        denied (fail closed), whatever permissions its stored role holds.
 *      Before closure, staff asking for a bid or a tender's bid list get InvalidTenderStatusException and no bid content.
 *      Withdrawn bids are shown to authorized staff after closure, marked by status "Withdrawn", and are never eligible for
 *      evaluation (Bid.isEligibleForEvaluation). A bid carries no evaluation or financial-assessment data.
 *
 * Decisions that are NOT in the documents. Each is the most restrictive reading and needs the project's confirmation:
 *   a. The operation -> permission mapping (BID_OPERATION_PERMISSIONS).
 *   b. (Approved) Withdrawal is final and still counts toward "one bid per supplier per tender".
 *   c. (Approved) Withdrawn bids are visible to authorized staff after closure but excluded from evaluation.
 *   d. "Closed" means the tender's STATUS is Closed or Awarded (a broker closes a tender after its deadline); a Published tender
 *      whose deadline has passed but which has not been closed yet is still sealed.
 *   e. Supplier eligibility is the Active account plus an existing supplier profile.
 *   f. There is no notification on submission yet (the notification module is not built), and document references are not
 *      checked against stored documents (the document module is not built).
 *   g. A cancel/close racing with a submission is not coordinated by a transaction: a bid accepted a moment before a tender is
 *      cancelled stays stored (and sealed).
 */
export class BidSubmissionUseCase {
  constructor(
    private readonly authorization: AuthorizeUseCase,
    private readonly bids: BidRepositoryInterface,
    private readonly tenders: TenderRepositoryInterface,
    private readonly suppliers: SupplierRepositoryInterface,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = generateId,
  ) {}

  /** ODD createBid() + submit() + validateSubmission(). The bid is stored as Submitted. */
  async submitBid(input: SubmitBidInput): Promise<BidDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "submit");
    const supplierId = await this.requireOwnSupplierId(caller);

    // Build (and so fully validate) the bid before reading anything else: a rejected request touches no storage.
    const tenderId = input.tenderId;
    if (typeof tenderId !== "string" || !/^\S+$/.test(tenderId)) throw new InvalidBidDataException(["tenderId is required and must not contain spaces"]);
    const bid = Bid.submit({
      bidId: this.newId(),
      tenderId,
      supplierId,
      technicalProposal: input.technicalProposal,
      financialProposal: input.financialProposal,
      supportingDocuments: input.supportingDocuments,
      submissionDate: now,
    });

    const tender = await this.tenders.findById(tenderId);
    if (tender === null || tender.status === "Draft" || tender.status === "Cancelled") throw new TenderNotFoundException();
    if (!tender.isOpenForSubmissions(now)) throw new TenderClosedException();

    if (await this.bids.existsBySupplierAndTender(supplierId, tenderId)) throw new DuplicateBidException();
    // The unique index turns a race that slips past the check above into the same DuplicateBidException.
    return toBidDto(await this.bids.create(bid));
  }

  /** ODD updateBid(). Own bid, Submitted, tender open for bids. */
  async updateBid(input: UpdateBidInput): Promise<BidDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "update");
    const supplierId = await this.requireOwnSupplierId(caller);
    const current = await this.loadOwnBid(supplierId, input.bidId);

    // Validates every value and refuses a bid that is no longer Submitted; throws before any write.
    const draft = Bid.restore({ ...current.toJSON(), submissionDate: current.submissionDate });
    draft.updateBid(input.changes);
    await this.assertTenderAcceptsChanges(current.tenderId, now, "update bid");

    const values: Record<string, unknown> = {};
    for (const field of Object.keys(input.changes) as Array<keyof UpdateBidInput["changes"]>) {
      if (input.changes[field] !== undefined) values[field] = draft[field];
    }
    return toBidDto(await this.bids.update(current.bidId, values, { expectedStatus: "Submitted" }));
  }

  /** ODD withdraw(). Own bid, Submitted, tender open for bids. Final. */
  async withdrawBid(input: BidActionInput): Promise<BidDto> {
    const now = this.clock();
    const caller = await this.authorize(input?.actingUserId, "withdraw");
    const supplierId = await this.requireOwnSupplierId(caller);
    const current = await this.loadOwnBid(supplierId, input.bidId);

    const draft = Bid.restore({ ...current.toJSON(), submissionDate: current.submissionDate });
    draft.withdraw(); // refuses a bid that is not Submitted
    await this.assertTenderAcceptsChanges(current.tenderId, now, "withdraw bid");

    return toBidDto(await this.bids.updateStatus(current.bidId, "Withdrawn", { expectedStatus: "Submitted" }));
  }

  /** ODD getBidDetails() / BidController.getBid. Subject to the visibility rules of decision 5. */
  async getBid(input: BidActionInput): Promise<BidDto> {
    const caller = await this.authorize(input?.actingUserId, "get");
    const bid = await this.loadBid(input.bidId);

    if (caller.kind === "supplier") {
      const own = await this.suppliers.findByUserId(caller.userId);
      if (own === null || bid.supplierId !== own.supplierId) throw new BidNotFoundException();
      return toBidDto(bid);
    }

    // Staff: out of scope looks exactly like "does not exist". Scope first, then sealing, so a foreign bid reveals nothing.
    const tender = await this.tenders.findById(bid.tenderId);
    if (tender === null || !staffMayReadTender(caller, tender)) throw new BidNotFoundException();
    assertUnsealed(tender, "read bid");
    return toBidDto(bid);
  }

  /** ODD BidController.listBids(tenderId, filters). A Supplier gets their own bids; staff get one tender's bids after it closed. Newest first. */
  async listBids(input: ListBidsInput): Promise<BidListDto> {
    const caller = await this.authorize(input?.actingUserId, "list");

    if (caller.kind === "supplier") {
      const query = normalizeBidQuery({ status: input.status, tenderId: input.tenderId, limit: input.limit, skip: input.skip });
      const own = await this.suppliers.findByUserId(caller.userId);
      if (own === null) return { bids: [], limit: query.limit, skip: query.skip };
      const found = await this.bids.findBySupplierId(own.supplierId, {
        status: query.statuses ?? undefined,
        tenderId: query.tenderId ?? undefined,
        limit: query.limit,
        skip: query.skip,
      });
      return { bids: found.map(toBidDto), limit: query.limit, skip: query.skip };
    }

    const tenderId = input.tenderId;
    if (typeof tenderId !== "string" || !/^\S+$/.test(tenderId)) throw new InvalidBidDataException(["tenderId is required to list the bids of a tender"]);
    const query = normalizeBidQuery({ status: input.status, limit: input.limit, skip: input.skip });

    const tender = await this.tenders.findById(tenderId);
    if (tender === null || !staffMayReadTender(caller, tender)) throw new TenderNotFoundException();
    assertUnsealed(tender, "list bids");

    // Withdrawn bids are listed too (distinguished by status); they are excluded from evaluation by Bid.isEligibleForEvaluation().
    const found = await this.bids.findByTenderId(tenderId, { status: query.statuses ?? undefined, limit: query.limit, skip: query.skip });
    return { bids: found.map(toBidDto), limit: query.limit, skip: query.skip };
  }

  /**
   * Tries the operation's permissions in order. Only "not allowed" moves on to the next one; every other failure (no session
   * user, inactive account, storage error) stops the request. The role then decides what the grant means (decision 5).
   */
  private async authorize(actingUserId: string, operation: Operation): Promise<Caller> {
    let granted: AuthorizedUserDto | null = null;
    let refusal: unknown = null;
    for (const permission of BID_OPERATION_PERMISSIONS[operation]) {
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
    if (granted.permission === "bid:submit" && roleName === "Supplier") return { userId, roleName, kind: "supplier" };
    if (granted.permission === "bid:read" && (roleName === "Administrator" || roleName === "Procurement Broker")) {
      return { userId, roleName, kind: "staff" };
    }
    throw new UnauthorizedAccessException(); // any other role (Evaluation Committee included): fail closed
  }

  /** The supplier profile id of the authenticated Supplier. Never read from the client. */
  private async requireOwnSupplierId(caller: Caller): Promise<string> {
    const supplier = await this.suppliers.findByUserId(caller.userId);
    if (supplier === null) throw new BidSubmissionException("a supplier profile is required before bidding");
    return supplier.supplierId;
  }

  private async loadBid(bidId: unknown): Promise<Bid> {
    if (typeof bidId !== "string" || bidId.trim() === "") throw new BidNotFoundException();
    const bid = await this.bids.findById(bidId);
    if (bid === null) throw new BidNotFoundException();
    return bid;
  }

  /** Loads a bid that belongs to the caller. Another supplier's bid looks exactly like a bid that does not exist. */
  private async loadOwnBid(supplierId: string, bidId: unknown): Promise<Bid> {
    const bid = await this.loadBid(bidId);
    if (bid.supplierId !== supplierId) throw new BidNotFoundException();
    return bid;
  }

  /** Authoritative, server-clock check that the bid's tender still accepts changes. */
  private async assertTenderAcceptsChanges(tenderId: string, now: Date, operation: string): Promise<void> {
    const tender = await this.tenders.findById(tenderId);
    if (tender === null) throw new BidNotFoundException();
    if (tender.status !== "Published") throw new TenderClosedException();
    if (!tender.isOpenForSubmissions(now)) throw new DeadlineExpiredException(operation);
  }
}

/** Administrators read any tender's bids; a Procurement Broker only those of tenders they own (brokerId is their own user id). */
function staffMayReadTender(caller: Caller, tender: Tender): boolean {
  if (caller.roleName === "Administrator") return true;
  return caller.roleName === "Procurement Broker" && tender.brokerId === caller.userId;
}

/** Bid contents stay sealed until the tender has closed. */
function assertUnsealed(tender: Tender, operation: string): void {
  if (!(UNSEALED_TENDER_STATUSES as readonly string[]).includes(tender.status)) {
    throw new InvalidTenderStatusException(tender.status, operation);
  }
}
