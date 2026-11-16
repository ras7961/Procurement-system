import type { Supplier, SupplierQueryInput, UpdateSupplierProfileProps, VerificationStatus } from "@/entities/Supplier";

/**
 * Fields update() can change: the profile fields, plus `verificationStatus` so that a use case can store, in the SAME
 * write, the reset to Pending that Supplier.updateProfile() decided on. Values should already have been validated by the entity.
 * Who may change what is decided by the use case, never by the repository.
 */
export type SupplierUpdateData = UpdateSupplierProfileProps & { verificationStatus?: VerificationStatus };

export type SupplierFilters = SupplierQueryInput;

export interface SupplierVerificationChange {
  /** The change is applied only if the supplier currently has this status; otherwise SupplierVerificationException. Guards against two reviewers acting at once. */
  expectedStatus?: VerificationStatus;
}

/**
 * ODD: interfaces.SupplierRepositoryInterface
 *
 * Stores and retrieves supplier profiles. MongoSupplierRepository (src/repositories) implements it; use cases depend on
 * this interface only. `findByUserId` is added to the ODD's list: ownership needs the profile of an account.
 * The ODD's generic `delete` is not offered: supplier records are kept (bids, contracts and performance will refer to them).
 *
 * Contract (tests/support/supplierRepositoryContract.ts checks every implementation):
 *  - findById, findByUserId, findByRegistrationNumber and findByEmail return null when nothing matches. They do not throw.
 *    findByRegistrationNumber ignores case and surrounding spaces. findByEmail ignores case and returns the first match
 *    (a contact email is not unique).
 *  - create() stores a new profile. A registration number (ignoring case) or a userId that is already stored throws
 *    DuplicateRegistrationException; a supplierId that already exists throws SupplierRepositoryException.
 *  - update() and updateVerificationStatus() throw SupplierNotFoundException for an unknown supplierId.
 *  - update() changes only the fields in SupplierUpdateData. supplierId, userId and registrationDate never change.
 *    Invalid values throw InvalidSupplierDataException; a registration number owned by another supplier throws
 *    DuplicateRegistrationException.
 *  - updateVerificationStatus() sets Verified or Rejected (Pending is refused with InvalidSupplierDataException) and refuses
 *    the status the supplier already has (SupplierVerificationException). With `expectedStatus` it is also safe against
 *    concurrent changes.
 *  - findAll(filters) filters by verificationStatus (one or several), newest registration first, at most 100 results unless
 *    `limit` (1 to 500) says otherwise; `skip` pages. Bad filters throw InvalidSupplierDataException.
 *  - Unexpected storage failures throw SupplierRepositoryException or DatabaseOperationException, never a raw driver error
 *    and never a message containing credentials.
 *  - Returned suppliers are new Supplier instances; changing one does not change stored data.
 */
export interface SupplierRepositoryInterface {
  create(supplier: Supplier): Promise<Supplier>;

  findById(supplierId: string): Promise<Supplier | null>;

  findByUserId(userId: string): Promise<Supplier | null>;

  findByRegistrationNumber(registrationNumber: string): Promise<Supplier | null>;

  findByEmail(email: string): Promise<Supplier | null>;

  update(supplierId: string, supplierData: SupplierUpdateData): Promise<Supplier>;

  updateVerificationStatus(supplierId: string, status: VerificationStatus, change?: SupplierVerificationChange): Promise<Supplier>;

  findAll(filters?: SupplierFilters): Promise<Supplier[]>;
}
