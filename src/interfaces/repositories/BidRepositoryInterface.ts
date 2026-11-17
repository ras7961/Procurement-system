import type { Bid, BidQueryInput, BidStatus, UpdateBidProps } from "@/entities/Bid";

/** Fields update() can change: the three proposal fields only. Who may change them, and when, is decided by the use case. */
export type BidUpdateData = UpdateBidProps;

/** List filters for findByTenderId / findBySupplierId. `tenderId` is only meaningful for findBySupplierId. */
export type BidFilters = BidQueryInput;

export interface BidWriteCondition {
  /**
   * The write is applied only if the bid currently has this status; otherwise BidSubmissionException (or BidNotFoundException
   * when the bid is gone). Guards against two requests (an update and a withdrawal, or two withdrawals) acting at once.
   */
  expectedStatus?: BidStatus;
}

/**
 * ODD: interfaces.BidRepositoryInterface
 *
 * Stores and retrieves bids. MongoBidRepository (src/repositories) implements it; use cases depend on this interface only.
 * The ODD's operations are kept (create, findById, findByTenderId, findBySupplierId, update, updateStatus,
 * existsBySupplierAndTender); `findByTenderId` and `findBySupplierId` accept the optional filters above, and `update` and
 * `updateStatus` accept a write condition. There is no `delete`: bids are kept as procurement records.
 *
 * Contract (tests/support/bidRepositoryContract.ts checks every implementation):
 *  - findById returns null when nothing matches. It does not throw.
 *  - create() stores a new bid. A second bid for the same supplier and tender (any status, a withdrawn bid included) throws
 *    DuplicateBidException, even when two requests arrive at the same moment: the database enforces it with a unique index.
 *    A bidId that already exists throws BidRepositoryException.
 *  - existsBySupplierAndTender() is true when any bid, in any status, exists for that pair.
 *  - findByTenderId(tenderId, filters) and findBySupplierId(supplierId, filters) return the bids of that tender or supplier,
 *    newest submission first (ties by bidId), at most 100 unless `limit` (1 to 500) says otherwise; `skip` pages; `status`
 *    filters (one or several). Bad filters throw InvalidBidDataException. findBySupplierId also accepts `tenderId`.
 *  - update() and updateStatus() throw BidNotFoundException for an unknown bidId.
 *  - update() changes only the proposal fields and only while the bid is Submitted (BidSubmissionException otherwise); invalid
 *    values throw InvalidBidDataException / InvalidDocumentException and change nothing. bidId, tenderId, supplierId,
 *    submissionDate and status never change through update().
 *  - updateStatus() follows the bid's status transitions (BidSubmissionException for a refused one). With `expectedStatus` both
 *    writes are safe against concurrent changes: only one of two competing requests succeeds.
 *  - Unexpected storage failures throw BidRepositoryException or DatabaseOperationException, never a raw driver error and never
 *    a message containing credentials.
 *  - Returned bids are new Bid instances; changing one does not change stored data.
 */
export interface BidRepositoryInterface {
  create(bid: Bid): Promise<Bid>;

  findById(bidId: string): Promise<Bid | null>;

  findByTenderId(tenderId: string, filters?: BidFilters): Promise<Bid[]>;

  findBySupplierId(supplierId: string, filters?: BidFilters): Promise<Bid[]>;

  update(bidId: string, bidData: BidUpdateData, condition?: BidWriteCondition): Promise<Bid>;

  updateStatus(bidId: string, status: BidStatus, condition?: BidWriteCondition): Promise<Bid>;

  existsBySupplierAndTender(supplierId: string, tenderId: string): Promise<boolean>;
}
