import type { ReviewOutcome, Supplier, VerificationStatus } from "@/entities/Supplier";

/**
 * Input and output shapes of the supplier use cases. Plain data: no entities.
 * Every input carries `actingUserId`, the id of the authenticated user taken from a verified session by the
 * HTTP adapter. No role, permission or ownership value is ever part of an input: the use case reads them from storage.
 */

export interface SupplierProfileInput {
  companyName: string;
  registrationNumber: string;
  email: string;
  phoneNumber: string;
  address: string;
}

export interface RegisterSupplierProfileInput extends SupplierProfileInput {
  actingUserId: string;
  /**
   * The account the profile belongs to. A Supplier registering their own profile must leave it out (or give their own id).
   * An Administrator or Procurement Broker must name an existing user whose role is Supplier.
   */
  userId?: string;
}

export interface UpdateSupplierProfileInput {
  actingUserId: string;
  supplierId: string;
  /** Only the five profile fields can change; anything else is rejected. */
  changes: Partial<SupplierProfileInput>;
}

export interface SupplierActionInput {
  actingUserId: string;
  supplierId: string;
}

export interface OwnSupplierInput {
  actingUserId: string;
}

export interface VerifySupplierInput {
  actingUserId: string;
  supplierId: string;
  status: ReviewOutcome;
}

export interface ListSuppliersInput {
  actingUserId: string;
  verificationStatus?: VerificationStatus | readonly VerificationStatus[];
  limit?: number;
  skip?: number;
}

export interface SupplierDto {
  supplierId: string;
  userId: string;
  companyName: string;
  registrationNumber: string;
  email: string;
  phoneNumber: string;
  address: string;
  verificationStatus: VerificationStatus;
  registrationDate: string;
}

export interface SupplierListDto {
  suppliers: SupplierDto[];
  limit: number;
  skip: number;
}

export function toSupplierDto(supplier: Supplier): SupplierDto {
  return supplier.toJSON();
}
