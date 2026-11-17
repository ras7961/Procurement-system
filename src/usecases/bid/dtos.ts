import type { Bid, BidStatus, ComplianceStatus } from "@/entities/Bid";

/**
 * Input and output shapes of the bid use cases. Plain data: no entities.
 * Every input carries `actingUserId`, the id of the authenticated user taken from a verified session by the HTTP adapter.
 * No role, permission, supplier id, bid status or ownership value is ever part of an input: the use case reads them from storage.
 */

export interface SubmitBidInput {
  actingUserId: string;
  tenderId: string;
  technicalProposal: string;
  financialProposal: number;
  /** Document ids (references). Optional. */
  supportingDocuments?: string[];
}

export interface UpdateBidInput {
  actingUserId: string;
  bidId: string;
  /** Only the three proposal fields can change; anything else is rejected. */
  changes: {
    technicalProposal?: string;
    financialProposal?: number;
    supportingDocuments?: string[];
  };
}

export interface BidActionInput {
  actingUserId: string;
  bidId: string;
}

export interface ListBidsInput {
  actingUserId: string;
  /** Required for staff (the tender whose bids are listed). Optional for a Supplier, who only ever sees their own bids. */
  tenderId?: string;
  status?: BidStatus | readonly BidStatus[];
  limit?: number;
  skip?: number;
}

export interface BidDto {
  bidId: string;
  tenderId: string;
  supplierId: string;
  technicalProposal: string;
  financialProposal: number;
  supportingDocuments: string[];
  submissionDate: string;
  status: BidStatus;
  complianceStatus: ComplianceStatus;
}

export interface BidListDto {
  bids: BidDto[];
  limit: number;
  skip: number;
}

/** The only representation of a bid handed to the HTTP layer. It holds no evaluation or assessment data. */
export function toBidDto(bid: Bid): BidDto {
  return bid.toJSON();
}
