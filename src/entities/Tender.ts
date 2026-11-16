import {
  DeadlineExpiredException,
  InvalidTenderDataException,
  InvalidTenderStatusException,
  TenderDeadlineNotReachedException,
} from "./exceptions";

/**
 * ODD: entities.Tender
 *
 * A procurement opportunity managed by a procurement broker (SRS: Tender Management; ODD class C).
 *
 * ODD operation mapping:
 *   createTender()           -> Tender.create()  (and Tender.restore() when loading stored data)
 *   updateTender()           -> updateTender()   (Draft, or Published before the deadline)
 *   publish()                -> publish()
 *   close()                  -> close()          (deadline reached, or explicitly authorized early closure)
 *   cancel()                 -> cancel()
 *   addRequirement()         -> addRequirement()
 *   setEvaluationCriteria()  -> setEvaluationCriteria()
 *   getSubmittedBids()       -> NOT here: reading bids needs BidRepositoryInterface, which an entity must
 *                               not depend on. It belongs to the Bid module / TenderManagementUseCase.
 *
 * Saving and loading is done through TenderRepositoryInterface by use cases. No framework or database types here.
 *
 * Attributes are the ODD's, with these documented differences:
 *   - `createdAt` is added (the ODD has none) so lists have a stable order. It never changes.
 *   - `publicationDate` is null until the tender is published.
 *   - `requirements` and `evaluationCriteria` are lists of text items. The ODD says "Array" and defines no
 *     item structure; weights, technical/financial split and per-criterion scores are NOT modelled and must be
 *     decided together with the Evaluation module.
 *   - No currency is modelled (the ODD defines none): `estimatedBudget` is a plain positive number.
 *
 * Status rules (ODD statuses; the transitions are a documented assumption, see TENDER_STATUS_TRANSITIONS):
 *   Draft -> Published | Cancelled;  Published -> Closed | Cancelled;  Closed -> Awarded;  Awarded and Cancelled are final.
 *   Nothing here awards a tender: awarding is a human decision whose role and permission are still undecided, so
 *   no operation performs Closed -> Awarded yet. The AI never changes a tender.
 *
 * Open points (not decided by the documents):
 *   - Evaluation Committee assignment: the ODD Tender has no committee attribute and no document defines how
 *     members are assigned. It is NOT modelled here. It should become its own record that references `tenderId`
 *     (decided in a later stage), because the matrix grants committee members tender access only for assigned tenders.
 *   - Whether a broker may edit another broker's tender: the matrix grants tender:update to every broker without
 *     "restricted", so the entity applies no ownership rule. `brokerId` is the responsible broker, not an access check.
 *   - Whether Closed tenders may be cancelled, and which fields may change after publication, are not documented.
 *     The ODD only says updates are allowed "before the applicable deadline", which is what is implemented.
 */

export const TENDER_STATUSES = ["Draft", "Published", "Closed", "Awarded", "Cancelled"] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export function isTenderStatus(value: unknown): value is TenderStatus {
  return typeof value === "string" && (TENDER_STATUSES as readonly string[]).includes(value);
}

/** Allowed status changes. Staying in the same status is always a harmless no-op. */
export const TENDER_STATUS_TRANSITIONS: Readonly<Record<TenderStatus, readonly TenderStatus[]>> = {
  Draft: ["Published", "Cancelled"],
  Published: ["Closed", "Cancelled"],
  Closed: ["Awarded"],
  Awarded: [],
  Cancelled: [],
};

/** Statuses in which tender information may still be changed (ODD updateTender). */
export const EDITABLE_TENDER_STATUSES: readonly TenderStatus[] = ["Draft", "Published"];
/** Only a tender that was never published can be deleted; every other tender is kept as a record. */
export const DELETABLE_TENDER_STATUSES: readonly TenderStatus[] = ["Draft"];

// Implementation limits (the documents define none): they keep records and requests a sane size.
export const TENDER_TITLE_MAX_LENGTH = 200;
export const TENDER_DESCRIPTION_MAX_LENGTH = 5000;
export const TENDER_CATEGORY_MAX_LENGTH = 100;
export const TENDER_ITEM_MAX_LENGTH = 1000;
export const TENDER_LIST_MAX_ITEMS = 100;

export interface CreateTenderProps {
  tenderId: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements?: readonly string[];
  evaluationCriteria?: readonly string[];
  submissionDeadline: Date;
  brokerId: string;
  /** Defaults to now. The submission deadline must be later than this. */
  createdAt?: Date;
}

export interface RestoreTenderProps {
  tenderId: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements: readonly string[];
  evaluationCriteria: readonly string[];
  publicationDate: Date | null;
  submissionDeadline: Date;
  status: TenderStatus;
  brokerId: string;
  createdAt: Date;
}

/** The fields updateTender() can change. tenderId, brokerId, status, publicationDate and createdAt cannot. */
export interface UpdateTenderProps {
  title?: string;
  description?: string;
  category?: string;
  estimatedBudget?: number;
  requirements?: readonly string[];
  evaluationCriteria?: readonly string[];
  submissionDeadline?: Date;
}

const UPDATABLE_FIELDS = [
  "title",
  "description",
  "category",
  "estimatedBudget",
  "requirements",
  "evaluationCriteria",
  "submissionDeadline",
] as const;

interface ValidTenderData {
  tenderId: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements: string[];
  evaluationCriteria: string[];
  publicationDate: Date | null;
  submissionDeadline: Date;
  status: TenderStatus;
  brokerId: string;
  createdAt: Date;
}

export class Tender {
  readonly #tenderId: string;
  #title: string;
  #description: string;
  #category: string;
  #estimatedBudget: number;
  #requirements: string[];
  #evaluationCriteria: string[];
  #publicationDate: Date | null;
  #submissionDeadline: Date;
  #status: TenderStatus;
  readonly #brokerId: string;
  readonly #createdAt: Date;

  private constructor(data: ValidTenderData) {
    this.#tenderId = data.tenderId;
    this.#title = data.title;
    this.#description = data.description;
    this.#category = data.category;
    this.#estimatedBudget = data.estimatedBudget;
    this.#requirements = data.requirements;
    this.#evaluationCriteria = data.evaluationCriteria;
    this.#publicationDate = data.publicationDate;
    this.#submissionDeadline = data.submissionDeadline;
    this.#status = data.status;
    this.#brokerId = data.brokerId;
    this.#createdAt = data.createdAt;
  }

  /** ODD createTender(): builds a new Draft tender. The deadline must be in the future. */
  static create(props: CreateTenderProps): Tender {
    const createdAt = props.createdAt ?? new Date();
    const issues: string[] = [];
    const data = readTenderData(
      {
        tenderId: props.tenderId,
        title: props.title,
        description: props.description,
        category: props.category,
        estimatedBudget: props.estimatedBudget,
        requirements: props.requirements ?? [],
        evaluationCriteria: props.evaluationCriteria ?? [],
        publicationDate: null,
        submissionDeadline: props.submissionDeadline,
        status: "Draft",
        brokerId: props.brokerId,
        createdAt,
      },
      issues,
    );
    if (data && data.submissionDeadline.getTime() <= createdAt.getTime()) {
      issues.push("submissionDeadline must be in the future");
    }
    return Tender.#build(data, issues);
  }

  /** Rebuilds a tender from stored data (used by repository implementations). Validates, but does not require a future deadline. */
  static restore(props: RestoreTenderProps): Tender {
    const issues: string[] = [];
    const data = readTenderData({ ...props }, issues);
    if (data) {
      // A stored tender must be consistent: only a Draft has no publication date (a Cancelled one may or may not).
      if (data.status === "Draft" && data.publicationDate !== null) issues.push("a Draft tender cannot have a publicationDate");
      if (["Published", "Closed", "Awarded"].includes(data.status) && data.publicationDate === null) {
        issues.push(`a ${data.status} tender must have a publicationDate`);
      }
    }
    return Tender.#build(data, issues);
  }

  static #build(data: ValidTenderData | null, issues: string[]): Tender {
    if (issues.length > 0 || data === null) throw new InvalidTenderDataException(issues);
    return new Tender(data);
  }

  get tenderId(): string {
    return this.#tenderId;
  }
  get title(): string {
    return this.#title;
  }
  get description(): string {
    return this.#description;
  }
  get category(): string {
    return this.#category;
  }
  get estimatedBudget(): number {
    return this.#estimatedBudget;
  }
  get requirements(): string[] {
    return [...this.#requirements];
  }
  get evaluationCriteria(): string[] {
    return [...this.#evaluationCriteria];
  }
  get publicationDate(): Date | null {
    return this.#publicationDate ? new Date(this.#publicationDate.getTime()) : null;
  }
  get submissionDeadline(): Date {
    return new Date(this.#submissionDeadline.getTime());
  }
  get status(): TenderStatus {
    return this.#status;
  }
  get brokerId(): string {
    return this.#brokerId;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  canTransitionTo(next: TenderStatus): boolean {
    return next === this.#status || TENDER_STATUS_TRANSITIONS[this.#status].includes(next);
  }

  /** True while suppliers may submit bids: Published and the deadline has not been reached. */
  isOpenForSubmissions(now: Date = new Date()): boolean {
    return this.#status === "Published" && now.getTime() < this.#submissionDeadline.getTime();
  }

  /** ODD updateTender(). Draft, or Published before the deadline. Changes nothing when it throws. */
  updateTender(changes: UpdateTenderProps, now: Date = new Date()): void {
    this.#assertEditable("update tender", now);

    const issues: string[] = [];
    const provided = UPDATABLE_FIELDS.filter((field) => changes?.[field] !== undefined);
    for (const key of Object.keys(changes ?? {})) {
      if (!(UPDATABLE_FIELDS as readonly string[]).includes(key)) issues.push(`${key} cannot be changed`);
    }
    if (provided.length === 0 && issues.length === 0) issues.push("at least one field to update is required");

    const next = {
      title: this.#title,
      description: this.#description,
      category: this.#category,
      estimatedBudget: this.#estimatedBudget,
      requirements: this.#requirements,
      evaluationCriteria: this.#evaluationCriteria,
      submissionDeadline: this.#submissionDeadline,
    };
    if (changes?.title !== undefined) next.title = readText(changes.title, "title", TENDER_TITLE_MAX_LENGTH, issues);
    if (changes?.description !== undefined) {
      next.description = readText(changes.description, "description", TENDER_DESCRIPTION_MAX_LENGTH, issues);
    }
    if (changes?.category !== undefined) next.category = readText(changes.category, "category", TENDER_CATEGORY_MAX_LENGTH, issues);
    if (changes?.estimatedBudget !== undefined) next.estimatedBudget = readBudget(changes.estimatedBudget, issues);
    if (changes?.requirements !== undefined) next.requirements = readList(changes.requirements, "requirements", issues);
    if (changes?.evaluationCriteria !== undefined) {
      next.evaluationCriteria = readList(changes.evaluationCriteria, "evaluationCriteria", issues);
    }
    if (changes?.submissionDeadline !== undefined) {
      next.submissionDeadline = readDate(changes.submissionDeadline, "submissionDeadline", issues);
      if (!Number.isNaN(next.submissionDeadline.getTime()) && next.submissionDeadline.getTime() <= now.getTime()) {
        issues.push("submissionDeadline must be in the future");
      }
    }
    // A published tender must stay complete: suppliers are already looking at it.
    if (this.#status === "Published") issues.push(...completenessIssues(next.requirements, next.evaluationCriteria));
    if (issues.length > 0) throw new InvalidTenderDataException(issues);

    this.#title = next.title;
    this.#description = next.description;
    this.#category = next.category;
    this.#estimatedBudget = next.estimatedBudget;
    this.#requirements = [...next.requirements];
    this.#evaluationCriteria = [...next.evaluationCriteria];
    this.#submissionDeadline = new Date(next.submissionDeadline.getTime());
  }

  /** ODD addRequirement(). Same status and deadline rules as updateTender(). */
  addRequirement(requirement: string, now: Date = new Date()): void {
    this.#assertEditable("add requirement", now);
    const issues: string[] = [];
    const next = readList([...this.#requirements, requirement], "requirements", issues);
    if (issues.length > 0) throw new InvalidTenderDataException(issues);
    this.#requirements = next;
  }

  /** ODD setEvaluationCriteria(). Replaces the whole list. Same rules as updateTender(). */
  setEvaluationCriteria(criteria: readonly string[], now: Date = new Date()): void {
    this.#assertEditable("set evaluation criteria", now);
    const issues: string[] = [];
    const next = readList(criteria, "evaluationCriteria", issues);
    if (this.#status === "Published" && next.length === 0) issues.push("a published tender needs at least one evaluation criterion");
    if (issues.length > 0) throw new InvalidTenderDataException(issues);
    this.#evaluationCriteria = next;
  }

  /**
   * ODD publish(). Draft only. Needs a future deadline, at least one requirement and at least one
   * evaluation criterion (the SRS activity "Validate Information -> Publish Tender"; the exact completeness
   * rule is an assumption). Sets the publication date to `now`.
   */
  publish(now: Date = new Date()): void {
    if (this.#status !== "Draft") throw new InvalidTenderStatusException(this.#status, "publish");
    if (this.#submissionDeadline.getTime() <= now.getTime()) throw new DeadlineExpiredException("publish");
    const issues = completenessIssues(this.#requirements, this.#evaluationCriteria);
    if (issues.length > 0) throw new InvalidTenderDataException(issues);

    this.#status = "Published";
    this.#publicationDate = new Date(now.getTime());
  }

  /**
   * ODD close(). Published only. Allowed once the deadline is reached; before that only when the caller
   * passes `early: true`, which the use case may do only for an authorized user.
   */
  close(now: Date = new Date(), options: { early?: boolean } = {}): void {
    if (this.#status !== "Published") throw new InvalidTenderStatusException(this.#status, "close");
    if (now.getTime() < this.#submissionDeadline.getTime() && options.early !== true) {
      throw new TenderDeadlineNotReachedException();
    }
    this.#status = "Closed";
  }

  /** ODD cancel(). Draft or Published only (cancelling a Closed tender is not documented, so it is refused). */
  cancel(): void {
    if (!this.canTransitionTo("Cancelled") || this.#status === "Cancelled") {
      throw new InvalidTenderStatusException(this.#status, "cancel");
    }
    this.#status = "Cancelled";
  }

  /** Throws InvalidTenderStatusException unless the tender may be deleted (only a Draft). */
  assertDeletable(): void {
    if (!DELETABLE_TENDER_STATUSES.includes(this.#status)) throw new InvalidTenderStatusException(this.#status, "delete");
  }

  toJSON(): {
    tenderId: string;
    title: string;
    description: string;
    category: string;
    estimatedBudget: number;
    requirements: string[];
    evaluationCriteria: string[];
    publicationDate: string | null;
    submissionDeadline: string;
    status: TenderStatus;
    brokerId: string;
    createdAt: string;
  } {
    return {
      tenderId: this.#tenderId,
      title: this.#title,
      description: this.#description,
      category: this.#category,
      estimatedBudget: this.#estimatedBudget,
      requirements: [...this.#requirements],
      evaluationCriteria: [...this.#evaluationCriteria],
      publicationDate: this.#publicationDate ? this.#publicationDate.toISOString() : null,
      submissionDeadline: this.#submissionDeadline.toISOString(),
      status: this.#status,
      brokerId: this.#brokerId,
      createdAt: this.#createdAt.toISOString(),
    };
  }

  #assertEditable(operation: string, now: Date): void {
    if (!EDITABLE_TENDER_STATUSES.includes(this.#status)) throw new InvalidTenderStatusException(this.#status, operation);
    // A Draft can always be fixed (including a deadline that has already passed); a Published tender cannot after its deadline.
    if (this.#status === "Published" && now.getTime() >= this.#submissionDeadline.getTime()) {
      throw new DeadlineExpiredException(operation);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Query options shared by every TenderRepositoryInterface implementation.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_TENDER_PAGE_SIZE = 100;
export const MAX_TENDER_PAGE_SIZE = 500;

export interface TenderQueryInput {
  status?: TenderStatus | readonly TenderStatus[];
  brokerId?: string;
  category?: string;
  limit?: number;
  skip?: number;
}

export interface NormalizedTenderQuery {
  statuses: TenderStatus[] | null;
  brokerId: string | null;
  category: string | null;
  limit: number;
  skip: number;
}

/** Validates list filters and paging once, so every repository treats the same input the same way. */
export function normalizeTenderQuery(input: TenderQueryInput = {}): NormalizedTenderQuery {
  const issues: string[] = [];

  let statuses: TenderStatus[] | null = null;
  if (input.status !== undefined) {
    const list = Array.isArray(input.status) ? input.status : [input.status];
    if (list.length === 0 || !list.every(isTenderStatus)) issues.push(`status must be one or more of: ${TENDER_STATUSES.join(", ")}`);
    else statuses = [...new Set(list)] as TenderStatus[];
  }
  const brokerId = readOptionalFilter(input.brokerId, "brokerId", issues);
  const category = readOptionalFilter(input.category, "category", issues);

  let limit = DEFAULT_TENDER_PAGE_SIZE;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_TENDER_PAGE_SIZE) {
      issues.push(`limit must be a whole number from 1 to ${MAX_TENDER_PAGE_SIZE}`);
    } else limit = input.limit;
  }
  let skip = 0;
  if (input.skip !== undefined) {
    if (!Number.isInteger(input.skip) || input.skip < 0) issues.push("skip must be a whole number of 0 or more");
    else skip = input.skip;
  }

  if (issues.length > 0) throw new InvalidTenderDataException(issues);
  return { statuses, brokerId, category, limit, skip };
}

function readOptionalFilter(value: unknown, field: string, issues: string[]): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field} must be a non-empty text`);
    return null;
  }
  return value.trim();
}

// ---------------------------------------------------------------------------------------------
// Validation helpers. Each one collects problems into `issues` and returns a usable value.
// ---------------------------------------------------------------------------------------------

function readTenderData(raw: Record<string, unknown>, issues: string[]): ValidTenderData | null {
  const tenderId = readId(raw.tenderId, "tenderId", issues);
  const brokerId = readId(raw.brokerId, "brokerId", issues);
  const title = readText(raw.title, "title", TENDER_TITLE_MAX_LENGTH, issues);
  const description = readText(raw.description, "description", TENDER_DESCRIPTION_MAX_LENGTH, issues);
  const category = readText(raw.category, "category", TENDER_CATEGORY_MAX_LENGTH, issues);
  const estimatedBudget = readBudget(raw.estimatedBudget, issues);
  const requirements = readList(raw.requirements, "requirements", issues);
  const evaluationCriteria = readList(raw.evaluationCriteria, "evaluationCriteria", issues);
  const submissionDeadline = readDate(raw.submissionDeadline, "submissionDeadline", issues);
  const createdAt = readDate(raw.createdAt, "createdAt", issues);

  let publicationDate: Date | null = null;
  if (raw.publicationDate !== null && raw.publicationDate !== undefined) {
    publicationDate = readDate(raw.publicationDate, "publicationDate", issues);
  }

  if (!isTenderStatus(raw.status)) issues.push(`status must be one of: ${TENDER_STATUSES.join(", ")}`);

  if (issues.length > 0) return null;
  return {
    tenderId,
    title,
    description,
    category,
    estimatedBudget,
    requirements,
    evaluationCriteria,
    publicationDate,
    submissionDeadline,
    status: raw.status as TenderStatus,
    brokerId,
    createdAt,
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

function readBudget(value: unknown, issues: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push("estimatedBudget must be a number greater than 0");
    return 0;
  }
  return value;
}

function readDate(value: unknown, field: string, issues: string[]): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    issues.push(`${field} must be a valid date`);
    return new Date(Number.NaN);
  }
  return new Date(value.getTime());
}

/** A list of non-empty, unique (ignoring case) text items. Returns a cleaned copy. */
function readList(value: unknown, field: string, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be a list`);
    return [];
  }
  if (value.length > TENDER_LIST_MAX_ITEMS) issues.push(`${field} can have at most ${TENDER_LIST_MAX_ITEMS} items`);

  const items: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push(`every item of ${field} must be a non-empty text`);
      continue;
    }
    const item = entry.trim();
    if (item.length > TENDER_ITEM_MAX_LENGTH) {
      issues.push(`every item of ${field} must be at most ${TENDER_ITEM_MAX_LENGTH} characters`);
      continue;
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      issues.push(`${field} must not contain the same item twice`);
      continue;
    }
    seen.add(key);
    items.push(item);
  }
  return items;
}

function completenessIssues(requirements: readonly string[], criteria: readonly string[]): string[] {
  const issues: string[] = [];
  if (requirements.length === 0) issues.push("at least one requirement is required to publish");
  if (criteria.length === 0) issues.push("at least one evaluation criterion is required to publish");
  return issues;
}
