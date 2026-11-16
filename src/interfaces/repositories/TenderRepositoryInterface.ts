import type { Tender, TenderQueryInput, TenderStatus, UpdateTenderProps } from "@/entities/Tender";

/** Fields of a tender that can be changed through update(). Values should already have been validated by Tender.updateTender(). */
export type TenderUpdateData = UpdateTenderProps;

export type TenderFilters = TenderQueryInput;

/** Selects tenders that are open for bids: Published and with a submission deadline after `referenceDate`. */
export interface OpenTenderCriteria {
  /** Defaults to now. */
  referenceDate?: Date;
  category?: string;
  limit?: number;
  skip?: number;
}

export interface TenderStatusChange {
  /** The change is applied only if the tender currently has this status; otherwise InvalidTenderStatusException. Guards against two users acting at once. */
  expectedStatus?: TenderStatus;
  /** Required when moving to Published, and allowed only then. */
  publicationDate?: Date;
}

/**
 * ODD: interfaces.TenderRepositoryInterface
 *
 * Stores and retrieves tenders. MongoTenderRepository (src/repositories) implements it; use cases depend on
 * this interface only. Use cases change the Tender entity first (publish(), close(), ...) and then store the result.
 *
 * Contract (tests/support/tenderRepositoryContract.ts checks every implementation):
 *  - findById returns null when nothing matches. It does not throw.
 *  - create() stores a new tender. A tenderId that already exists throws TenderRepositoryException.
 *  - update(), updateStatus() and delete() throw TenderNotFoundException for an unknown tenderId.
 *  - update() changes only the fields in TenderUpdateData and only while the tender is Draft or Published
 *    (otherwise InvalidTenderStatusException). tenderId, brokerId, status, publicationDate and createdAt never change.
 *    Invalid values throw InvalidTenderDataException.
 *  - updateStatus() follows the allowed transitions of TENDER_STATUS_TRANSITIONS (otherwise InvalidTenderStatusException);
 *    asking for the current status changes nothing. With `expectedStatus` it is also safe against concurrent changes.
 *  - delete() ("deletes or archives subject to business rules") removes only a Draft tender. Any other tender is
 *    kept as a record and throws InvalidTenderStatusException. Archiving is not modelled.
 *  - findAll(filters) filters by status (one or several), brokerId and category (exact match), newest first,
 *    at most 100 results unless `limit` (1 to 500) says otherwise; `skip` pages. Bad filters throw InvalidTenderDataException.
 *  - findOpenTenders(criteria) returns Published tenders whose deadline is after the reference date, soonest deadline first.
 *    A Published tender whose deadline has passed but which nobody has closed yet is NOT returned.
 *  - Unexpected storage failures throw TenderRepositoryException or DatabaseOperationException, never a raw driver error
 *    and never a message containing credentials.
 *  - Returned tenders are new Tender instances; changing one does not change stored data.
 */
export interface TenderRepositoryInterface {
  create(tender: Tender): Promise<Tender>;

  findById(tenderId: string): Promise<Tender | null>;

  findAll(filters?: TenderFilters): Promise<Tender[]>;

  update(tenderId: string, tenderData: TenderUpdateData): Promise<Tender>;

  delete(tenderId: string): Promise<void>;

  updateStatus(tenderId: string, status: TenderStatus, change?: TenderStatusChange): Promise<Tender>;

  findOpenTenders(criteria?: OpenTenderCriteria): Promise<Tender[]>;
}
