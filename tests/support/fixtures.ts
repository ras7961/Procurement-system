import { Bid, type SubmitBidProps } from "@/entities/Bid";
import { Role, type CreateRoleProps } from "@/entities/Role";
import { Supplier, type RegisterSupplierProfileProps } from "@/entities/Supplier";
import { Tender, type CreateTenderProps } from "@/entities/Tender";
import { User, type RegisterUserProps } from "@/entities/User";

/** Looks like a bcrypt hash. A made-up test value, not a real credential. */
export const VALID_PASSWORD_HASH = `$2b$12$${"x".repeat(53)}`;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeRole(overrides: Partial<CreateRoleProps> = {}): Role {
  return Role.create({
    roleId: nextId("role"),
    roleName: "Supplier",
    description: "Submits bids and manages its own company profile.",
    ...overrides,
  });
}

export function makeUser(overrides: Partial<RegisterUserProps> = {}): User {
  const id = nextId("user");
  return User.register({
    userId: id,
    fullName: "Abebe Kebede",
    email: `${id}@example.com`,
    passwordHash: VALID_PASSWORD_HASH,
    role: makeRole(),
    ...overrides,
  });
}

/** A fixed reference time, so tender tests do not depend on the real clock. */
export const TENDER_NOW = new Date("2030-01-10T09:00:00.000Z");
export const TENDER_DEADLINE = new Date("2030-02-10T09:00:00.000Z");

/** A valid Draft tender created at TENDER_NOW with a deadline a month later. Pass overrides to change fields. */
export function makeTender(overrides: Partial<CreateTenderProps> = {}): Tender {
  return Tender.create({
    tenderId: nextId("tender"),
    title: "Supply of office furniture",
    description: "Desks, chairs and cabinets for the regional office.",
    category: "Goods",
    estimatedBudget: 250000,
    requirements: ["Valid trade licence", "Two years of similar supply experience"],
    evaluationCriteria: ["Technical compliance", "Price"],
    submissionDeadline: TENDER_DEADLINE,
    brokerId: "broker-1",
    createdAt: TENDER_NOW,
    ...overrides,
  });
}

/** A valid Pending supplier profile registered at TENDER_NOW. Each call gets its own id, user and registration number. */
export function makeSupplier(overrides: Partial<RegisterSupplierProfileProps> = {}): Supplier {
  const id = nextId("supplier");
  return Supplier.register({
    supplierId: id,
    userId: nextId("supplier-user"),
    companyName: "Abyssinia Office Supplies PLC",
    registrationNumber: `REG-${id}`,
    email: "contact@abyssinia-supplies.example",
    phoneNumber: "+251 11 123 4567",
    address: "Bole Road, Addis Ababa",
    registrationDate: TENDER_NOW,
    ...overrides,
  });
}

/** A valid Submitted bid submitted at TENDER_NOW. Each call gets its own id, tender and supplier unless overridden. */
export function makeBid(overrides: Partial<SubmitBidProps> = {}): Bid {
  const id = nextId("bid");
  return Bid.submit({
    bidId: id,
    tenderId: nextId("bid-tender"),
    supplierId: nextId("bid-supplier"),
    technicalProposal: "We will deliver 40 desks and 80 chairs within 30 days of the contract.",
    financialProposal: 240000,
    supportingDocuments: ["doc-trade-licence", "doc-experience-letter"],
    submissionDate: TENDER_NOW,
    ...overrides,
  });
}

/** Returns the error thrown by `action`, or fails the test if nothing was thrown. */
export function catchError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the action to throw, but it did not.");
}

export async function catchAsyncError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the action to throw, but it did not.");
}
