import { BidSubmissionException, InvalidBidDataException } from "@/entities/exceptions";
import { Bid, isBidStatus, type BidStatus, type RestoreBidProps } from "@/entities/Bid";
import type { BidUpdateData, BidWriteCondition } from "./BidRepositoryInterface";

/**
 * The rules of BidRepositoryInterface.update() and updateStatus() as pure functions, so that every implementation
 * (MongoBidRepository, test doubles) accepts and rejects exactly the same input. An implementation reads the stored bid,
 * calls one of these, and writes the result atomically (conditional on the status it read). No database types here.
 */

const UPDATABLE = ["technicalProposal", "financialProposal", "supportingDocuments"] as const;

export function toBidRestoreProps(bid: Bid): RestoreBidProps {
  return {
    bidId: bid.bidId,
    tenderId: bid.tenderId,
    supplierId: bid.supplierId,
    technicalProposal: bid.technicalProposal,
    financialProposal: bid.financialProposal,
    supportingDocuments: bid.supportingDocuments,
    submissionDate: bid.submissionDate,
    status: bid.status,
    complianceStatus: bid.complianceStatus,
  };
}

/**
 * The bid after update(): validated, or an error. Returns `current` itself when `data` changes nothing.
 * Unknown or protected keys are refused; the bid must still be Submitted (and, with `expectedStatus`, still have that status).
 */
export function applyBidUpdate(current: Bid, data: BidUpdateData, condition: BidWriteCondition = {}): Bid {
  const input = (data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !(UPDATABLE as readonly string[]).includes(key));
  if (unknown.length > 0) throw new InvalidBidDataException(unknown.map((key) => `${key} cannot be changed`));

  assertExpected(current, condition);
  const draft = Bid.restore(toBidRestoreProps(current));
  const provided = UPDATABLE.filter((field) => input[field] !== undefined);
  if (provided.length === 0) return current;

  draft.updateBid(Object.fromEntries(provided.map((field) => [field, input[field]])) as BidUpdateData); // validates; refuses a non-Submitted bid
  return draft;
}

/** The bid after updateStatus(): validated, or an error. */
export function applyBidStatusChange(current: Bid, status: BidStatus, condition: BidWriteCondition = {}): Bid {
  if (!isBidStatus(status)) throw new InvalidBidDataException(["status is not a valid status"]);
  assertExpected(current, condition);
  const draft = Bid.restore(toBidRestoreProps(current));
  draft.changeStatus(status); // refuses a transition the bid does not allow
  return draft;
}

function assertExpected(current: Bid, condition: BidWriteCondition): void {
  if (condition.expectedStatus !== undefined && current.status !== condition.expectedStatus) {
    throw new BidSubmissionException(`the bid is ${current.status}, not ${condition.expectedStatus}`);
  }
}
