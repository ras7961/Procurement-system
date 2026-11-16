import { InvalidSupplierDataException, SupplierVerificationException } from "@/entities/exceptions";
import {
  REVIEW_OUTCOMES,
  Supplier,
  isVerificationStatus,
  type RestoreSupplierProps,
  type VerificationStatus,
} from "@/entities/Supplier";
import type { SupplierUpdateData, SupplierVerificationChange } from "./SupplierRepositoryInterface";

/**
 * The rules of SupplierRepositoryInterface.update() and updateVerificationStatus() as pure functions, so that every
 * implementation (MongoSupplierRepository, test doubles) accepts and rejects exactly the same input. An implementation
 * reads the stored supplier, calls one of these, and writes the result atomically. No database types here.
 */

const UPDATABLE = ["companyName", "registrationNumber", "email", "phoneNumber", "address", "verificationStatus"] as const;

export function toSupplierRestoreProps(supplier: Supplier): RestoreSupplierProps {
  return {
    supplierId: supplier.supplierId,
    userId: supplier.userId,
    companyName: supplier.companyName,
    registrationNumber: supplier.registrationNumber,
    email: supplier.email,
    phoneNumber: supplier.phoneNumber,
    address: supplier.address,
    verificationStatus: supplier.verificationStatus,
    registrationDate: supplier.registrationDate,
  };
}

/** The supplier after update(): validated, or an error. Returns `current` itself when `data` changes nothing. */
export function applySupplierUpdate(current: Supplier, data: SupplierUpdateData): Supplier {
  const input = (data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !(UPDATABLE as readonly string[]).includes(key));
  if (unknown.length > 0) throw new InvalidSupplierDataException(unknown.map((key) => `${key} cannot be changed`));

  const changes: Record<string, unknown> = {};
  for (const field of UPDATABLE) if (input[field] !== undefined) changes[field] = input[field];
  if (Object.keys(changes).length === 0) return current;
  if (changes.verificationStatus !== undefined && !isVerificationStatus(changes.verificationStatus)) {
    throw new InvalidSupplierDataException(["verificationStatus is not a valid status"]);
  }

  // Restore validates every value (an invalid one throws InvalidSupplierDataException).
  return Supplier.restore({ ...toSupplierRestoreProps(current), ...changes } as RestoreSupplierProps);
}

/** The supplier after updateVerificationStatus(): validated, or an error. */
export function applyVerificationChange(current: Supplier, status: VerificationStatus, change: SupplierVerificationChange = {}): Supplier {
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(status)) {
    throw new InvalidSupplierDataException([`status must be one of: ${REVIEW_OUTCOMES.join(", ")}`]);
  }
  if (change.expectedStatus !== undefined && current.verificationStatus !== change.expectedStatus) {
    throw new SupplierVerificationException(current.verificationStatus, `set status to ${status}`);
  }
  if (current.verificationStatus === status) throw new SupplierVerificationException(current.verificationStatus, `set status to ${status}`);
  return Supplier.restore({ ...toSupplierRestoreProps(current), verificationStatus: status });
}
