import { TenderRepositoryException } from "@/entities/exceptions";
import { Tender, type TenderStatus } from "@/entities/Tender";
import { describeDriverError } from "./mongoErrors";
import { toDomainDate, toDomainId } from "./userDocumentMapper";

/** How a tender is stored in the "tenders" collection. `_id` holds the domain tenderId. */
export interface TenderDocument {
  _id: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements: string[];
  evaluationCriteria: string[];
  /** null until the tender is published. */
  publicationDate: Date | null;
  submissionDeadline: Date;
  status: TenderStatus;
  brokerId: string;
  createdAt: Date;
}

export type StoredTenderDocument = Omit<TenderDocument, "_id" | "publicationDate" | "submissionDeadline" | "createdAt"> & {
  _id: unknown;
  publicationDate?: Date | string | number | null;
  submissionDeadline: Date | string | number;
  createdAt: Date | string | number;
};

export function toTenderDocument(tender: Tender): TenderDocument {
  return {
    _id: tender.tenderId,
    title: tender.title,
    description: tender.description,
    category: tender.category,
    estimatedBudget: tender.estimatedBudget,
    requirements: tender.requirements,
    evaluationCriteria: tender.evaluationCriteria,
    publicationDate: tender.publicationDate,
    submissionDeadline: tender.submissionDeadline,
    status: tender.status,
    brokerId: tender.brokerId,
    createdAt: tender.createdAt,
  };
}

/** Converts a stored document to a validated Tender. A corrupt document is a storage problem. */
export function toTender(document: StoredTenderDocument): Tender {
  try {
    return Tender.restore({
      tenderId: toDomainId(document._id),
      title: document.title,
      description: document.description,
      category: document.category,
      estimatedBudget: document.estimatedBudget,
      requirements: Array.isArray(document.requirements) ? document.requirements : [],
      evaluationCriteria: Array.isArray(document.evaluationCriteria) ? document.evaluationCriteria : [],
      publicationDate: document.publicationDate === null || document.publicationDate === undefined ? null : toDomainDate(document.publicationDate),
      submissionDeadline: toDomainDate(document.submissionDeadline),
      status: document.status,
      brokerId: document.brokerId,
      createdAt: toDomainDate(document.createdAt),
    });
  } catch (error) {
    throw new TenderRepositoryException({
      cause: error,
      details: { reason: "stored tender document is invalid", ...describeDriverError(error) },
    });
  }
}
