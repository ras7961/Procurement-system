import { SupplierRepositoryException } from "@/entities/exceptions";
import { Supplier, registrationNumberKey, type VerificationStatus } from "@/entities/Supplier";
import { describeDriverError } from "./mongoErrors";
import { toDomainDate, toDomainId } from "./userDocumentMapper";

/**
 * How a supplier profile is stored in the "suppliers" collection. `_id` holds the domain supplierId.
 * `registrationNumberKey` is the registration number lower-cased and trimmed: a unique index on it makes
 * "ACME-1" and "acme-1" the same registration. It is derived data and never leaves the repository.
 */
export interface SupplierDocument {
  _id: string;
  userId: string;
  companyName: string;
  registrationNumber: string;
  registrationNumberKey: string;
  email: string;
  phoneNumber: string;
  address: string;
  verificationStatus: VerificationStatus;
  registrationDate: Date;
}

export type StoredSupplierDocument = Omit<SupplierDocument, "_id" | "registrationDate" | "registrationNumberKey"> & {
  _id: unknown;
  registrationNumberKey?: string;
  registrationDate: Date | string | number;
};

export function toSupplierDocument(supplier: Supplier): SupplierDocument {
  return {
    _id: supplier.supplierId,
    userId: supplier.userId,
    companyName: supplier.companyName,
    registrationNumber: supplier.registrationNumber,
    registrationNumberKey: registrationNumberKey(supplier.registrationNumber),
    email: supplier.email,
    phoneNumber: supplier.phoneNumber,
    address: supplier.address,
    verificationStatus: supplier.verificationStatus,
    registrationDate: supplier.registrationDate,
  };
}

/** Converts a stored document to a validated Supplier. A corrupt document is a storage problem. */
export function toSupplier(document: StoredSupplierDocument): Supplier {
  try {
    return Supplier.restore({
      supplierId: toDomainId(document._id),
      userId: document.userId,
      companyName: document.companyName,
      registrationNumber: document.registrationNumber,
      email: document.email,
      phoneNumber: document.phoneNumber,
      address: document.address,
      verificationStatus: document.verificationStatus,
      registrationDate: toDomainDate(document.registrationDate),
    });
  } catch (error) {
    throw new SupplierRepositoryException({
      cause: error,
      details: { reason: "stored supplier document is invalid", ...describeDriverError(error) },
    });
  }
}
