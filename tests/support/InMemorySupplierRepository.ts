import { DuplicateRegistrationException, SupplierNotFoundException, SupplierRepositoryException } from "@/entities/exceptions";
import { Supplier, normalizeSupplierQuery, registrationNumberKey, type RestoreSupplierProps, type VerificationStatus } from "@/entities/Supplier";
import type {
  SupplierFilters,
  SupplierRepositoryInterface,
  SupplierUpdateData,
  SupplierVerificationChange,
} from "@/interfaces/repositories/SupplierRepositoryInterface";
import { applySupplierUpdate, applyVerificationChange, toSupplierRestoreProps } from "@/interfaces/repositories/supplierRepositoryRules";

/** Test double that implements SupplierRepositoryInterface in memory, using the same shared rules as the real repository. */
export class InMemorySupplierRepository implements SupplierRepositoryInterface {
  private readonly rows = new Map<string, RestoreSupplierProps>();

  async create(supplier: Supplier): Promise<Supplier> {
    if (this.rows.has(supplier.supplierId)) throw new SupplierRepositoryException();
    const key = registrationNumberKey(supplier.registrationNumber);
    for (const row of this.rows.values()) {
      if (registrationNumberKey(row.registrationNumber) === key || row.userId === supplier.userId) throw new DuplicateRegistrationException();
    }
    this.rows.set(supplier.supplierId, toSupplierRestoreProps(supplier));
    return this.load(supplier.supplierId);
  }

  async findById(supplierId: string): Promise<Supplier | null> {
    return this.rows.has(supplierId) ? this.load(supplierId) : null;
  }

  async findByUserId(userId: string): Promise<Supplier | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.userId === userId);
    return row ? Supplier.restore(row) : null;
  }

  async findByRegistrationNumber(registrationNumber: string): Promise<Supplier | null> {
    const key = registrationNumberKey(registrationNumber);
    const row = [...this.rows.values()].find((candidate) => registrationNumberKey(candidate.registrationNumber) === key);
    return row ? Supplier.restore(row) : null;
  }

  async findByEmail(email: string): Promise<Supplier | null> {
    const wanted = email.trim().toLowerCase();
    const row = [...this.rows.values()]
      .sort((a, b) => a.registrationDate.getTime() - b.registrationDate.getTime() || a.supplierId.localeCompare(b.supplierId))
      .find((candidate) => candidate.email.toLowerCase() === wanted);
    return row ? Supplier.restore(row) : null;
  }

  async findAll(filters: SupplierFilters = {}): Promise<Supplier[]> {
    const query = normalizeSupplierQuery(filters);
    return [...this.rows.keys()]
      .map((id) => this.load(id))
      .filter((supplier) => !query.statuses || query.statuses.includes(supplier.verificationStatus))
      .sort((a, b) => b.registrationDate.getTime() - a.registrationDate.getTime() || a.supplierId.localeCompare(b.supplierId))
      .slice(query.skip, query.skip + query.limit);
  }

  async update(supplierId: string, supplierData: SupplierUpdateData): Promise<Supplier> {
    const current = this.load(supplierId);
    const next = applySupplierUpdate(current, supplierData);
    const key = registrationNumberKey(next.registrationNumber);
    for (const row of this.rows.values()) {
      if (row.supplierId !== supplierId && registrationNumberKey(row.registrationNumber) === key) throw new DuplicateRegistrationException();
    }
    this.rows.set(supplierId, toSupplierRestoreProps(next));
    return this.load(supplierId);
  }

  async updateVerificationStatus(supplierId: string, status: VerificationStatus, change?: SupplierVerificationChange): Promise<Supplier> {
    const current = this.load(supplierId);
    const next = applyVerificationChange(current, status, change);
    this.rows.set(supplierId, toSupplierRestoreProps(next));
    return this.load(supplierId);
  }

  private load(supplierId: string): Supplier {
    const row = this.rows.get(supplierId);
    if (!row) throw new SupplierNotFoundException();
    return Supplier.restore(row);
  }
}
