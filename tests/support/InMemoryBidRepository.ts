import { Bid, normalizeBidQuery, type BidStatus } from "@/entities/Bid";
import { BidNotFoundException, BidRepositoryException, DuplicateBidException } from "@/entities/exceptions";
import type {
  BidFilters,
  BidRepositoryInterface,
  BidUpdateData,
  BidWriteCondition,
} from "@/interfaces/repositories/BidRepositoryInterface";
import { applyBidStatusChange, applyBidUpdate, toBidRestoreProps } from "@/interfaces/repositories/bidRepositoryRules";

/** Test double that implements BidRepositoryInterface in memory, using the same shared rules as the real repository. */
export class InMemoryBidRepository implements BidRepositoryInterface {
  private readonly rows = new Map<string, Bid>();

  async create(bid: Bid): Promise<Bid> {
    // No await between the check and the write: like a unique index, the pair is claimed atomically.
    if (this.rows.has(bid.bidId)) throw new BidRepositoryException();
    if ([...this.rows.values()].some((row) => row.supplierId === bid.supplierId && row.tenderId === bid.tenderId)) throw new DuplicateBidException();
    this.rows.set(bid.bidId, Bid.restore(toBidRestoreProps(bid)));
    return this.copy(bid.bidId);
  }

  async findById(bidId: string): Promise<Bid | null> {
    return this.rows.has(bidId) ? this.copy(bidId) : null;
  }

  async findByTenderId(tenderId: string, filters: BidFilters = {}): Promise<Bid[]> {
    return this.list((bid) => bid.tenderId === tenderId, { ...filters, tenderId: undefined });
  }

  async findBySupplierId(supplierId: string, filters: BidFilters = {}): Promise<Bid[]> {
    return this.list((bid) => bid.supplierId === supplierId, filters);
  }

  async existsBySupplierAndTender(supplierId: string, tenderId: string): Promise<boolean> {
    return [...this.rows.values()].some((bid) => bid.supplierId === supplierId && bid.tenderId === tenderId);
  }

  async update(bidId: string, data: BidUpdateData, condition: BidWriteCondition = {}): Promise<Bid> {
    const current = this.rows.get(bidId);
    if (!current) throw new BidNotFoundException();
    this.rows.set(bidId, applyBidUpdate(current, data, condition));
    return this.copy(bidId);
  }

  async updateStatus(bidId: string, status: BidStatus, condition: BidWriteCondition = {}): Promise<Bid> {
    const current = this.rows.get(bidId);
    if (!current) throw new BidNotFoundException();
    this.rows.set(bidId, applyBidStatusChange(current, status, condition));
    return this.copy(bidId);
  }

  private list(predicate: (bid: Bid) => boolean, filters: BidFilters): Bid[] {
    const query = normalizeBidQuery(filters);
    return [...this.rows.values()]
      .filter(predicate)
      .filter((bid) => !query.statuses || query.statuses.includes(bid.status))
      .filter((bid) => !query.tenderId || bid.tenderId === query.tenderId)
      .sort((a, b) => b.submissionDate.getTime() - a.submissionDate.getTime() || a.bidId.localeCompare(b.bidId))
      .slice(query.skip, query.skip + query.limit)
      .map((bid) => Bid.restore(toBidRestoreProps(bid)));
  }

  private copy(bidId: string): Bid {
    return Bid.restore(toBidRestoreProps(this.rows.get(bidId)!));
  }
}
