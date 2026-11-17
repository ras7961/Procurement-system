import { Bid, type BidStatus, type ComplianceStatus } from "@/entities/Bid";
import { BidRepositoryException } from "@/entities/exceptions";
import { describeDriverError } from "./mongoErrors";
import { toDomainDate, toDomainId } from "./userDocumentMapper";

/**
 * How a bid is stored in the "bids" collection. `_id` holds the domain bidId. `supportingDocuments` holds document ids
 * only (references): no file content is ever stored here.
 */
export interface BidDocument {
  _id: string;
  tenderId: string;
  supplierId: string;
  technicalProposal: string;
  financialProposal: number;
  supportingDocuments: string[];
  submissionDate: Date;
  status: BidStatus;
  complianceStatus: ComplianceStatus;
}

export type StoredBidDocument = Omit<BidDocument, "_id" | "submissionDate"> & {
  _id: unknown;
  submissionDate: Date | string | number;
};

export function toBidDocument(bid: Bid): BidDocument {
  return {
    _id: bid.bidId,
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

/** Converts a stored document to a validated Bid. A corrupt document is a storage problem and never echoes its content. */
export function toBid(document: StoredBidDocument): Bid {
  try {
    return Bid.restore({
      bidId: toDomainId(document._id),
      tenderId: document.tenderId,
      supplierId: document.supplierId,
      technicalProposal: document.technicalProposal,
      financialProposal: document.financialProposal,
      supportingDocuments: document.supportingDocuments,
      submissionDate: toDomainDate(document.submissionDate),
      status: document.status,
      complianceStatus: document.complianceStatus,
    });
  } catch (error) {
    throw new BidRepositoryException({
      cause: error,
      details: { reason: "stored bid document is invalid", ...describeDriverError(error) },
    });
  }
}
