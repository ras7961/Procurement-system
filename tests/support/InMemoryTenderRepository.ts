import { TenderNotFoundException, TenderRepositoryException } from "@/entities/exceptions";
import { Tender, normalizeTenderQuery, type RestoreTenderProps, type TenderStatus } from "@/entities/Tender";
import type {
  OpenTenderCriteria,
  TenderFilters,
  TenderRepositoryInterface,
  TenderStatusChange,
  TenderUpdateData,
} from "@/interfaces/repositories/TenderRepositoryInterface";
import {
  applyTenderStatusChange,
  applyTenderUpdate,
  resolveReferenceDate,
  toRestoreProps,
} from "@/interfaces/repositories/tenderRepositoryRules";

/** Test double that implements TenderRepositoryInterface in memory, using the same shared rules as the real repository. */
export class InMemoryTenderRepository implements TenderRepositoryInterface {
  private readonly rows = new Map<string, RestoreTenderProps>();

  async create(tender: Tender): Promise<Tender> {
    if (this.rows.has(tender.tenderId)) throw new TenderRepositoryException();
    this.rows.set(tender.tenderId, toRestoreProps(tender));
    return this.load(tender.tenderId);
  }

  async findById(tenderId: string): Promise<Tender | null> {
    return this.rows.has(tenderId) ? this.load(tenderId) : null;
  }

  async findAll(filters: TenderFilters = {}): Promise<Tender[]> {
    const query = normalizeTenderQuery(filters);
    return [...this.rows.keys()]
      .map((id) => this.load(id))
      .filter((tender) => !query.statuses || query.statuses.includes(tender.status))
      .filter((tender) => !query.brokerId || tender.brokerId === query.brokerId)
      .filter((tender) => !query.category || tender.category === query.category)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.tenderId.localeCompare(b.tenderId))
      .slice(query.skip, query.skip + query.limit);
  }

  async findOpenTenders(criteria: OpenTenderCriteria = {}): Promise<Tender[]> {
    const query = normalizeTenderQuery({ category: criteria.category, limit: criteria.limit, skip: criteria.skip });
    const reference = resolveReferenceDate(criteria);
    return [...this.rows.keys()]
      .map((id) => this.load(id))
      .filter((tender) => tender.status === "Published" && tender.submissionDeadline.getTime() > reference.getTime())
      .filter((tender) => !query.category || tender.category === query.category)
      .sort((a, b) => a.submissionDeadline.getTime() - b.submissionDeadline.getTime() || a.tenderId.localeCompare(b.tenderId))
      .slice(query.skip, query.skip + query.limit);
  }

  async update(tenderId: string, tenderData: TenderUpdateData): Promise<Tender> {
    const current = this.load(tenderId);
    const next = applyTenderUpdate(current, tenderData);
    this.rows.set(tenderId, toRestoreProps(next));
    return this.load(tenderId);
  }

  async updateStatus(tenderId: string, status: TenderStatus, change?: TenderStatusChange): Promise<Tender> {
    const current = this.load(tenderId);
    const next = applyTenderStatusChange(current, status, change);
    this.rows.set(tenderId, toRestoreProps(next));
    return this.load(tenderId);
  }

  async delete(tenderId: string): Promise<void> {
    this.load(tenderId).assertDeletable();
    this.rows.delete(tenderId);
  }

  private load(tenderId: string): Tender {
    const row = this.rows.get(tenderId);
    if (!row) throw new TenderNotFoundException();
    return Tender.restore(row);
  }
}
