import { BidSubmissionException, InvalidBidDataException, InvalidDocumentException } from "./exceptions";

/**
 * ODD: entities.Bid (SRS: Bid Management and Evaluation, UC-05 Bid Submission).
 *
 * A supplier's formal response to a published tender: a technical proposal, one financial offer, references to supporting
 * documents, and a status. The entity owns the bid's own rules (what a valid bid looks like, which status changes are
 * allowed, that only a Submitted bid can be changed). Rules that need other records (the tender is open, the supplier may
 * bid, one bid per supplier per tender) belong to BidSubmissionUseCase and BidRepositoryInterface.
 *
 * ODD operation mapping:
 *   createBid() / submit() / validateSubmission() -> Bid.submit(): validates everything and returns a Submitted bid, or
 *                                  throws. There is no Draft status in the ODD, so a bid never exists in an unsubmitted
 *                                  state and a failed validation creates nothing.
 *   updateBid()                  -> updateBid() (Submitted bids only)
 *   withdraw()                   -> withdraw() (Submitted bids only)
 *   uploadDocuments()            -> NOT a separate operation: document REFERENCES are given to submit() / updateBid().
 *                                  Stage 2E stores references only; there is no file upload.
 *   updateStatus()               -> changeStatus() (the transition table below). Only withdraw() is used in Stage 2E.
 *   getBidDetails()              -> toJSON()
 *
 * Documented differences from, and gaps in, the ODD (each needs the project's confirmation):
 *   1. Statuses are the ODD's five: Submitted, Under Evaluation, Accepted, Rejected, Withdrawn. The ODD gives no transition
 *      rules. The table below is the most restrictive reading: only Submitted can be withdrawn or moved on; Accepted,
 *      Rejected and Withdrawn are final. Moving a bid to Under Evaluation / Accepted / Rejected belongs to the Bid
 *      Evaluation stage; nothing in Stage 2E calls it.
 *   2. `complianceStatus` has no values in the ODD ("whether the bid satisfies the mandatory submission requirements").
 *      Two values are used: "Compliant" and "NonCompliant". A bid that is stored has passed every mandatory submission
 *      check, so submit() always sets "Compliant". "NonCompliant" can only be set by a later evaluation stage.
 *   3. `supportingDocuments` holds document ids (references). Whether a referenced document exists, or belongs to the
 *      supplier, cannot be checked yet because the document module is not built. Only the format is validated.
 *   4. `financialProposal` is the single numeric financial offer (ODD). It must be a finite number greater than zero.
 *   5. Limits (the documents define none): technical proposal at most 5000 characters (a request body is limited to
 *      16 KiB), at most 20 document references of at most 100 characters each, financial proposal at most 1e15.
 *
 * Saving, loading and uniqueness are NOT done here. No framework or database types.
 */

export const BID_STATUSES = ["Submitted", "Under Evaluation", "Accepted", "Rejected", "Withdrawn"] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export function isBidStatus(value: unknown): value is BidStatus {
  return typeof value === "string" && (BID_STATUSES as readonly string[]).includes(value);
}

export const COMPLIANCE_STATUSES = ["Compliant", "NonCompliant"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export function isComplianceStatus(value: unknown): value is ComplianceStatus {
  return typeof value === "string" && (COMPLIANCE_STATUSES as readonly string[]).includes(value);
}

/** Which status a bid may move to from each status. Final statuses have no exit. */
export const BID_STATUS_TRANSITIONS: Readonly<Record<BidStatus, readonly BidStatus[]>> = {
  Submitted: ["Under Evaluation", "Rejected", "Withdrawn"],
  "Under Evaluation": ["Accepted", "Rejected"],
  Accepted: [],
  Rejected: [],
  Withdrawn: [],
};

/** Statuses in which a supplier may still change or withdraw the bid. */
export const MODIFIABLE_BID_STATUSES: readonly BidStatus[] = ["Submitted"];

// Implementation limits (the documents define none): they keep records and requests a sane size.
export const BID_TECHNICAL_PROPOSAL_MAX_LENGTH = 5000;
export const BID_FINANCIAL_PROPOSAL_MAX = 1e15;
export const BID_DOCUMENTS_MAX_ITEMS = 20;
export const BID_DOCUMENT_REFERENCE_MAX_LENGTH = 100;

export interface SubmitBidProps {
  bidId: string;
  tenderId: string;
  supplierId: string;
  technicalProposal: string;
  financialProposal: number;
  /** References (ids) of already stored documents. Optional: the documents do not define which documents a tender requires. */
  supportingDocuments?: string[];
  /** Defaults to now. */
  submissionDate?: Date;
}

export interface RestoreBidProps {
  bidId: string;
  tenderId: string;
  supplierId: string;
  technicalProposal: string;
  financialProposal: number;
  supportingDocuments: string[];
  submissionDate: Date;
  status: BidStatus;
  complianceStatus: ComplianceStatus;
}

/** The fields updateBid() can change. bidId, tenderId, supplierId, submissionDate, status and complianceStatus cannot. */
export interface UpdateBidProps {
  technicalProposal?: string;
  financialProposal?: number;
  supportingDocuments?: string[];
}

const UPDATABLE_FIELDS = ["technicalProposal", "financialProposal", "supportingDocuments"] as const;

type ValidBidData = RestoreBidProps;

export class Bid {
  readonly #bidId: string;
  readonly #tenderId: string;
  readonly #supplierId: string;
  #technicalProposal: string;
  #financialProposal: number;
  #supportingDocuments: string[];
  readonly #submissionDate: Date;
  #status: BidStatus;
  #complianceStatus: ComplianceStatus;

  private constructor(data: ValidBidData) {
    this.#bidId = data.bidId;
    this.#tenderId = data.tenderId;
    this.#supplierId = data.supplierId;
    this.#technicalProposal = data.technicalProposal;
    this.#financialProposal = data.financialProposal;
    this.#supportingDocuments = [...data.supportingDocuments];
    this.#submissionDate = data.submissionDate;
    this.#status = data.status;
    this.#complianceStatus = data.complianceStatus;
  }

  /**
   * ODD createBid() + submit() + validateSubmission(). Validates every value; returns a Submitted, Compliant bid or throws
   * (InvalidBidDataException, or InvalidDocumentException when only the document references are wrong). Nothing is created on failure.
   */
  static submit(props: SubmitBidProps): Bid {
    return Bid.restore({
      bidId: props?.bidId,
      tenderId: props?.tenderId,
      supplierId: props?.supplierId,
      technicalProposal: props?.technicalProposal,
      financialProposal: props?.financialProposal,
      supportingDocuments: props?.supportingDocuments ?? [],
      submissionDate: props?.submissionDate ?? new Date(),
      status: "Submitted",
      complianceStatus: "Compliant",
    });
  }

  /** Rebuilds a bid from stored data (used by repository implementations). Validates everything. */
  static restore(props: RestoreBidProps): Bid {
    const issues: string[] = [];
    const documentIssues: string[] = [];
    const data = readBidData({ ...props }, issues, documentIssues);
    if (issues.length > 0 || data === null) throw new InvalidBidDataException([...issues, ...documentIssues]);
    if (documentIssues.length > 0) throw new InvalidDocumentException(documentIssues);
    return new Bid(data);
  }

  get bidId(): string {
    return this.#bidId;
  }
  get tenderId(): string {
    return this.#tenderId;
  }
  get supplierId(): string {
    return this.#supplierId;
  }
  get technicalProposal(): string {
    return this.#technicalProposal;
  }
  get financialProposal(): number {
    return this.#financialProposal;
  }
  get supportingDocuments(): string[] {
    return [...this.#supportingDocuments];
  }
  get submissionDate(): Date {
    return new Date(this.#submissionDate.getTime());
  }
  get status(): BidStatus {
    return this.#status;
  }
  get complianceStatus(): ComplianceStatus {
    return this.#complianceStatus;
  }

  /** True while the supplier may still change or withdraw the bid (status Submitted). The tender's deadline is checked by the use case. */
  isModifiable(): boolean {
    return MODIFIABLE_BID_STATUSES.includes(this.#status);
  }

  canTransitionTo(next: BidStatus): boolean {
    return BID_STATUS_TRANSITIONS[this.#status].includes(next);
  }

  /**
   * ODD updateBid(). Only a Submitted bid can change, and only the three proposal fields. Changes nothing when it throws.
   * Whether the tender still accepts changes (deadline) is decided by the use case.
   */
  updateBid(changes: UpdateBidProps): void {
    this.#assertModifiable("update");
    const issues: string[] = [];
    const input = (changes ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!(UPDATABLE_FIELDS as readonly string[]).includes(key)) issues.push(`${key} cannot be changed`);
    }
    const provided = UPDATABLE_FIELDS.filter((field) => input[field] !== undefined);
    if (provided.length === 0 && issues.length === 0) issues.push("at least one field to update is required");
    if (issues.length > 0) throw new InvalidBidDataException(issues);

    const next = Bid.restore({
      ...this.#snapshot(),
      ...(Object.fromEntries(provided.map((field) => [field, input[field]])) as Partial<RestoreBidProps>),
    });
    this.#technicalProposal = next.technicalProposal;
    this.#financialProposal = next.financialProposal;
    this.#supportingDocuments = next.supportingDocuments;
  }

  /** ODD withdraw(). Only a Submitted bid can be withdrawn; a withdrawn bid is final. */
  withdraw(): void {
    this.#assertModifiable("withdraw");
    this.#status = "Withdrawn";
  }

  /** A withdrawn bid is void for evaluation, scoring, ranking and award recommendations. Later stages must filter with this. */
  isEligibleForEvaluation(): boolean {
    return this.#status !== "Withdrawn";
  }

  /** ODD updateStatus(). Follows BID_STATUS_TRANSITIONS; anything else throws BidSubmissionException. Not used by Stage 2E except through withdraw(). */
  changeStatus(next: BidStatus): void {
    if (!isBidStatus(next)) throw new InvalidBidDataException([`status must be one of: ${BID_STATUSES.join(", ")}`]);
    if (!this.canTransitionTo(next)) throw new BidSubmissionException(`the bid cannot move from ${this.#status} to ${next}`);
    this.#status = next;
  }

  /** ODD getBidDetails(): plain data with ISO dates. This is the only representation handed to other layers. */
  toJSON(): {
    bidId: string;
    tenderId: string;
    supplierId: string;
    technicalProposal: string;
    financialProposal: number;
    supportingDocuments: string[];
    submissionDate: string;
    status: BidStatus;
    complianceStatus: ComplianceStatus;
  } {
    return {
      bidId: this.#bidId,
      tenderId: this.#tenderId,
      supplierId: this.#supplierId,
      technicalProposal: this.#technicalProposal,
      financialProposal: this.#financialProposal,
      supportingDocuments: [...this.#supportingDocuments],
      submissionDate: this.#submissionDate.toISOString(),
      status: this.#status,
      complianceStatus: this.#complianceStatus,
    };
  }

  #assertModifiable(operation: string): void {
    if (!this.isModifiable()) throw new BidSubmissionException(`the bid cannot be changed because it is ${this.#status} (operation: ${operation})`);
  }

  #snapshot(): RestoreBidProps {
    return {
      bidId: this.#bidId,
      tenderId: this.#tenderId,
      supplierId: this.#supplierId,
      technicalProposal: this.#technicalProposal,
      financialProposal: this.#financialProposal,
      supportingDocuments: [...this.#supportingDocuments],
      submissionDate: this.#submissionDate,
      status: this.#status,
      complianceStatus: this.#complianceStatus,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// List filters, validated once so every repository treats the same input the same way.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_BID_PAGE_SIZE = 100;
export const MAX_BID_PAGE_SIZE = 500;

export interface BidQueryInput {
  status?: BidStatus | readonly BidStatus[];
  /** Only used when listing a supplier's bids. */
  tenderId?: string;
  limit?: number;
  skip?: number;
}

export interface NormalizedBidQuery {
  statuses: BidStatus[] | null;
  tenderId: string | null;
  limit: number;
  skip: number;
}

export function normalizeBidQuery(input: BidQueryInput = {}): NormalizedBidQuery {
  const issues: string[] = [];

  let statuses: BidStatus[] | null = null;
  if (input.status !== undefined) {
    const list = Array.isArray(input.status) ? input.status : [input.status];
    if (list.length === 0 || !list.every(isBidStatus)) issues.push(`status must be one or more of: ${BID_STATUSES.join(", ")}`);
    else statuses = [...new Set(list)] as BidStatus[];
  }

  let tenderId: string | null = null;
  if (input.tenderId !== undefined) {
    if (typeof input.tenderId !== "string" || !/^\S+$/.test(input.tenderId)) issues.push("tenderId must be a text without spaces");
    else tenderId = input.tenderId;
  }

  let limit = DEFAULT_BID_PAGE_SIZE;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_BID_PAGE_SIZE) {
      issues.push(`limit must be a whole number from 1 to ${MAX_BID_PAGE_SIZE}`);
    } else limit = input.limit;
  }
  let skip = 0;
  if (input.skip !== undefined) {
    if (!Number.isInteger(input.skip) || input.skip < 0) issues.push("skip must be a whole number of 0 or more");
    else skip = input.skip;
  }

  if (issues.length > 0) throw new InvalidBidDataException(issues);
  return { statuses, tenderId, limit, skip };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers. Each one collects problems into `issues` and returns a usable value.
// ---------------------------------------------------------------------------------------------

function readBidData(raw: Record<string, unknown>, issues: string[], documentIssues: string[]): ValidBidData | null {
  const bidId = readId(raw.bidId, "bidId", issues);
  const tenderId = readId(raw.tenderId, "tenderId", issues);
  const supplierId = readId(raw.supplierId, "supplierId", issues);

  let technicalProposal = "";
  if (typeof raw.technicalProposal !== "string" || raw.technicalProposal.trim() === "") issues.push("technicalProposal is required");
  else {
    technicalProposal = raw.technicalProposal.trim();
    if (technicalProposal.length > BID_TECHNICAL_PROPOSAL_MAX_LENGTH) {
      issues.push(`technicalProposal must be at most ${BID_TECHNICAL_PROPOSAL_MAX_LENGTH} characters`);
    }
  }

  let financialProposal = 0;
  const amount = raw.financialProposal;
  if (typeof amount !== "number" || !Number.isFinite(amount)) issues.push("financialProposal is required and must be a number");
  else if (amount <= 0) issues.push("financialProposal must be greater than zero");
  else if (amount > BID_FINANCIAL_PROPOSAL_MAX) issues.push(`financialProposal must be at most ${BID_FINANCIAL_PROPOSAL_MAX}`);
  else financialProposal = amount;

  const supportingDocuments = readDocumentReferences(raw.supportingDocuments, documentIssues);

  if (!isBidStatus(raw.status)) issues.push(`status must be one of: ${BID_STATUSES.join(", ")}`);
  if (!isComplianceStatus(raw.complianceStatus)) issues.push(`complianceStatus must be one of: ${COMPLIANCE_STATUSES.join(", ")}`);

  const date = raw.submissionDate;
  let submissionDate = new Date(Number.NaN);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) issues.push("submissionDate must be a valid date");
  else submissionDate = new Date(date.getTime());

  if (issues.length > 0) return null;
  return {
    bidId,
    tenderId,
    supplierId,
    technicalProposal,
    financialProposal,
    supportingDocuments,
    submissionDate,
    status: raw.status as BidStatus,
    complianceStatus: raw.complianceStatus as ComplianceStatus,
  };
}

function readId(value: unknown, field: string, issues: string[]): string {
  if (typeof value !== "string" || !/^\S+$/.test(value)) {
    issues.push(`${field} is required and must not contain spaces`);
    return "";
  }
  return value;
}

function readDocumentReferences(value: unknown, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push("supportingDocuments must be a list of document references");
    return [];
  }
  if (value.length > BID_DOCUMENTS_MAX_ITEMS) issues.push(`supportingDocuments must have at most ${BID_DOCUMENTS_MAX_ITEMS} items`);

  const references: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push(`supportingDocuments[${index}] must be a non-empty text`);
      return;
    }
    const reference = item.trim();
    if (!/^\S+$/.test(reference)) issues.push(`supportingDocuments[${index}] must not contain spaces`);
    else if (reference.length > BID_DOCUMENT_REFERENCE_MAX_LENGTH) {
      issues.push(`supportingDocuments[${index}] must be at most ${BID_DOCUMENT_REFERENCE_MAX_LENGTH} characters`);
    } else if (references.includes(reference)) issues.push(`supportingDocuments[${index}] is a duplicate reference`);
    else references.push(reference);
  });
  return references;
}
