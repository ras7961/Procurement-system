import { InvalidTenderDataException, InvalidTenderStatusException } from "@/entities/exceptions";
import {
  EDITABLE_TENDER_STATUSES,
  Tender,
  TENDER_STATUSES,
  TENDER_STATUS_TRANSITIONS,
  isTenderStatus,
  type RestoreTenderProps,
  type TenderStatus,
} from "@/entities/Tender";
import type { OpenTenderCriteria, TenderStatusChange, TenderUpdateData } from "./TenderRepositoryInterface";

/**
 * The rules of TenderRepositoryInterface.update() and updateStatus() as pure functions, so that every
 * implementation (MongoTenderRepository, test doubles) accepts and rejects exactly the same input. An
 * implementation reads the stored tender, calls one of these, and writes the result atomically.
 * No database types here.
 */

const UPDATABLE = [
  "title",
  "description",
  "category",
  "estimatedBudget",
  "requirements",
  "evaluationCriteria",
  "submissionDeadline",
] as const;

export function toRestoreProps(tender: Tender): RestoreTenderProps {
  return {
    tenderId: tender.tenderId,
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

/** The tender after update(): validated, or an error. Returns `current` itself when `data` changes nothing. */
export function applyTenderUpdate(current: Tender, data: TenderUpdateData): Tender {
  if (!EDITABLE_TENDER_STATUSES.includes(current.status)) throw new InvalidTenderStatusException(current.status, "update tender");

  const input = (data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !(UPDATABLE as readonly string[]).includes(key));
  if (unknown.length > 0) throw new InvalidTenderDataException(unknown.map((key) => `${key} cannot be changed`));

  const changes: Record<string, unknown> = {};
  for (const field of UPDATABLE) if (input[field] !== undefined) changes[field] = input[field];
  if (Object.keys(changes).length === 0) return current;

  return Tender.restore({ ...toRestoreProps(current), ...changes } as RestoreTenderProps);
}

/** The tender after updateStatus(): validated, or an error. Returns `current` itself for a no-op. */
export function applyTenderStatusChange(current: Tender, status: TenderStatus, change: TenderStatusChange = {}): Tender {
  if (!isTenderStatus(status)) throw new InvalidTenderDataException([`status must be one of: ${TENDER_STATUSES.join(", ")}`]);
  if (change.expectedStatus !== undefined && current.status !== change.expectedStatus) {
    throw new InvalidTenderStatusException(current.status, `change status to ${status}`);
  }
  if (status === current.status) return current;
  if (!TENDER_STATUS_TRANSITIONS[current.status].includes(status)) {
    throw new InvalidTenderStatusException(current.status, `change status to ${status}`);
  }
  if (change.publicationDate !== undefined && status !== "Published") {
    throw new InvalidTenderDataException(["publicationDate can only be set when publishing"]);
  }

  const props = toRestoreProps(current);
  return Tender.restore({
    ...props,
    status,
    publicationDate: status === "Published" ? (change.publicationDate ?? null) : props.publicationDate,
  });
}

/** Validates the reference date of findOpenTenders(). */
export function resolveReferenceDate(criteria: OpenTenderCriteria): Date {
  const date = criteria.referenceDate ?? new Date();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new InvalidTenderDataException(["referenceDate must be a valid date"]);
  }
  return date;
}
