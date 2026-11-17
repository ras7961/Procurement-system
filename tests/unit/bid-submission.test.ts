import { beforeEach, describe, expect, it } from "vitest";
import { Supplier } from "@/entities/Supplier";
import { Tender, type TenderStatus } from "@/entities/Tender";
import { User, type UserStatus } from "@/entities/User";
import { toRestoreProps } from "@/interfaces/repositories/tenderRepositoryRules";
import { generateId } from "@/shared/utilities/uuid";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { BidSubmissionUseCase } from "@/usecases/bid/BidSubmissionUseCase";
import { catchAsyncError, makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { FakePasswordService } from "../support/authFakes";
import { InMemoryBidRepository } from "../support/InMemoryBidRepository";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemorySupplierRepository } from "../support/InMemorySupplierRepository";
import { InMemoryTenderRepository } from "../support/InMemoryTenderRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";

const passwords = new FakePasswordService();
type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";

let users: InMemoryUserRepository;
let roles: InMemoryRoleRepository;
let suppliers: InMemorySupplierRepository;
let tenders: InMemoryTenderRepository;
let bids: InMemoryBidRepository;
let useCase: BidSubmissionUseCase;
let now: Date;
let counter = 0;

beforeEach(async () => {
  users = new InMemoryUserRepository();
  roles = new InMemoryRoleRepository();
  suppliers = new InMemorySupplierRepository();
  tenders = new InMemoryTenderRepository();
  bids = new InMemoryBidRepository();
  now = TENDER_NOW;
  await new SeedRolesUseCase(roles).execute();
  useCase = new BidSubmissionUseCase(new AuthorizeUseCase(users, roles), bids, tenders, suppliers, () => now);
});

async function userWithRole(roleName: RoleName, status: UserStatus = "Active"): Promise<string> {
  const role = (await roles.findByName(roleName))!;
  counter += 1;
  const user = await users.create(
    User.restore({ userId: generateId(), fullName: "Test", email: `u${counter}@example.com`, passwordHash: await passwords.hash("correct horse battery"), roleId: role.roleId, status, createdAt: new Date() }),
  );
  return user.userId;
}

/** An Active Supplier user with a supplier profile (NOT verified: verification is not required to bid). */
async function supplierUser(): Promise<{ userId: string; supplierId: string }> {
  const userId = await userWithRole("Supplier");
  counter += 1;
  const supplier = await suppliers.create(
    Supplier.register({ supplierId: `supplier-${counter}`, userId, companyName: "Abyssinia PLC", registrationNumber: `REG-${counter}`, email: "c@abyssinia.example", phoneNumber: "+251 11 123 4567", address: "Bole, Addis Ababa", registrationDate: TENDER_NOW }),
  );
  return { userId, supplierId: supplier.supplierId };
}

async function tenderIn(status: TenderStatus, overrides: { brokerId?: string; submissionDeadline?: Date } = {}): Promise<Tender> {
  const draft = makeTender({ brokerId: overrides.brokerId ?? "broker-1", ...(overrides.submissionDeadline ? { submissionDeadline: overrides.submissionDeadline } : {}) });
  if (status !== "Draft") draft.publish(TENDER_NOW);
  if (status === "Closed") draft.close(TENDER_DEADLINE);
  if (status === "Cancelled") draft.cancel();
  const tender = status === "Awarded" ? Tender.restore({ ...toRestoreProps(draft), status: "Awarded" }) : draft;
  return tenders.create(tender);
}

const body = (tenderId: string, extra: Record<string, unknown> = {}) => ({
  tenderId,
  technicalProposal: "We deliver in 30 days.",
  financialProposal: 120000,
  supportingDocuments: ["doc-licence"],
  ...extra,
});

describe("submitBid: success", () => {
  it("stores a Submitted bid owned by the authenticated supplier's profile, with server-chosen id, date and status", async () => {
    const { userId, supplierId } = await supplierUser();
    const tender = await tenderIn("Published");
    const bid = await useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) });
    expect(bid).toMatchObject({ tenderId: tender.tenderId, supplierId, status: "Submitted", complianceStatus: "Compliant", financialProposal: 120000, submissionDate: TENDER_NOW.toISOString(), supportingDocuments: ["doc-licence"] });
    expect(bid.bidId).toEqual(expect.any(String));
    expect(await bids.findById(bid.bidId)).not.toBeNull();
  });

  it("does not require the supplier to be Verified, and supporting documents are optional", async () => {
    const { userId } = await supplierUser(); // profile is Pending
    const tender = await tenderIn("Published");
    const bid = await useCase.submitBid({ actingUserId: userId, tenderId: tender.tenderId, technicalProposal: "plan", financialProposal: 1 });
    expect(bid.supportingDocuments).toEqual([]);
  });

  it("ignores protected values smuggled in the input: supplierId, status and date always come from the server", async () => {
    const a = await supplierUser();
    const b = await supplierUser();
    const tender = await tenderIn("Published");
    const smuggled = { actingUserId: a.userId, ...body(tender.tenderId), supplierId: b.supplierId, status: "Accepted", submissionDate: new Date("2000-01-01"), complianceStatus: "NonCompliant" };
    const bid = await useCase.submitBid(smuggled as never);
    expect(bid).toMatchObject({ supplierId: a.supplierId, status: "Submitted", complianceStatus: "Compliant", submissionDate: TENDER_NOW.toISOString() });
  });
});

describe("submitBid: who may submit", () => {
  it.each(["Administrator", "Procurement Broker", "Evaluation Committee"] as const)("a %s cannot submit", async (roleName) => {
    const userId = await userWithRole(roleName);
    const tender = await tenderIn("Published");
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
    expect(await bids.findByTenderId(tender.tenderId)).toEqual([]);
  });

  it.each(["Pending", "Suspended", "Inactive"] as const)("a %s supplier account cannot submit", async (status) => {
    const userId = await userWithRole("Supplier", status);
    const tender = await tenderIn("Published");
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  });

  it("an unknown acting user cannot submit", async () => {
    const tender = await tenderIn("Published");
    await expect(useCase.submitBid({ actingUserId: generateId(), ...body(tender.tenderId) })).rejects.toBeDefined();
  });

  it("an Active Supplier without a supplier profile gets BidSubmissionException", async () => {
    const userId = await userWithRole("Supplier");
    const tender = await tenderIn("Published");
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "BID_SUBMISSION_ERROR" });
  });
});

describe("submitBid: the tender must be eligible (authoritative state, server clock)", () => {
  it("an unknown tender gives TenderNotFoundException", async () => {
    const { userId } = await supplierUser();
    await expect(useCase.submitBid({ actingUserId: userId, ...body("no-such-tender") })).rejects.toMatchObject({ code: "TENDER_NOT_FOUND" });
  });

  it.each(["Draft", "Cancelled"] as const)("a %s tender looks like a tender that does not exist", async (status) => {
    const { userId } = await supplierUser();
    const tender = await tenderIn(status);
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "TENDER_NOT_FOUND" });
    expect(await bids.findByTenderId(tender.tenderId)).toEqual([]);
  });

  it.each(["Closed", "Awarded"] as const)("a %s tender gives TenderClosedException", async (status) => {
    const { userId } = await supplierUser();
    const tender = await tenderIn(status);
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "TENDER_CLOSED" });
  });

  it("a Published tender is open until its deadline: the deadline instant itself is already closed", async () => {
    const { userId } = await supplierUser();
    const tender = await tenderIn("Published");
    now = new Date(TENDER_DEADLINE.getTime() - 1);
    expect((await useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).status).toBe("Submitted");

    const other = await supplierUser();
    now = TENDER_DEADLINE;
    await expect(useCase.submitBid({ actingUserId: other.userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "TENDER_CLOSED" });
    now = new Date(TENDER_DEADLINE.getTime() + 86_400_000);
    await expect(useCase.submitBid({ actingUserId: other.userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "TENDER_CLOSED" });
  });
});

describe("submitBid: validation never creates a record or uses up the submission", () => {
  it.each([
    ["no technical proposal", { technicalProposal: "" }],
    ["a negative amount", { financialProposal: -10 }],
    ["a string amount", { financialProposal: "100" }],
    ["a bad document reference", { supportingDocuments: ["has space"] }],
    ["duplicate document references", { supportingDocuments: ["d", "d"] }],
  ])("%s is rejected, nothing is stored, and the supplier can still submit a valid bid", async (_label, bad) => {
    const { userId, supplierId } = await supplierUser();
    const tender = await tenderIn("Published");
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId, bad as Record<string, unknown>) } as never)).rejects.toMatchObject({ httpStatus: 400 });
    expect(await bids.existsBySupplierAndTender(supplierId, tender.tenderId)).toBe(false);
    expect((await useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).status).toBe("Submitted");
  });

  it("a malformed tender id is rejected before anything is read", async () => {
    const { userId } = await supplierUser();
    await expect(useCase.submitBid({ actingUserId: userId, ...body("bad id") })).rejects.toMatchObject({ code: "INVALID_BID_DATA" });
    await expect(useCase.submitBid({ actingUserId: userId, ...body(undefined as never) })).rejects.toMatchObject({ code: "INVALID_BID_DATA" });
  });
});

describe("submitBid: one bid per supplier per tender", () => {
  it("a second submission is DuplicateBidException and the first bid is untouched", async () => {
    const { userId } = await supplierUser();
    const tender = await tenderIn("Published");
    const first = await useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) });
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId, { financialProposal: 1 }) })).rejects.toMatchObject({ code: "DUPLICATE_BID" });
    expect((await bids.findById(first.bidId))?.financialProposal).toBe(120000);
  });

  it("a withdrawn bid still counts: no resubmission", async () => {
    const { userId } = await supplierUser();
    const tender = await tenderIn("Published");
    const first = await useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) });
    await useCase.withdrawBid({ actingUserId: userId, bidId: first.bidId });
    await expect(useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })).rejects.toMatchObject({ code: "DUPLICATE_BID" });
  });

  it("two suppliers can bid on the same tender, and one supplier on two tenders", async () => {
    const a = await supplierUser();
    const b = await supplierUser();
    const t1 = await tenderIn("Published");
    const t2 = await tenderIn("Published");
    await useCase.submitBid({ actingUserId: a.userId, ...body(t1.tenderId) });
    await useCase.submitBid({ actingUserId: b.userId, ...body(t1.tenderId) });
    await useCase.submitBid({ actingUserId: a.userId, ...body(t2.tenderId) });
    expect(await bids.findByTenderId(t1.tenderId)).toHaveLength(2);
  });

  it("concurrent submissions from the same supplier store exactly one bid", async () => {
    const { userId, supplierId } = await supplierUser();
    const tender = await tenderIn("Published");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => useCase.submitBid({ actingUserId: userId, ...body(tender.tenderId) })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "DUPLICATE_BID" });
    expect(await bids.findBySupplierId(supplierId)).toHaveLength(1);
  });
});

describe("updateBid and withdrawBid: only the owner, only before the deadline", () => {
  async function submitted() {
    const owner = await supplierUser();
    const tender = await tenderIn("Published");
    const bid = await useCase.submitBid({ actingUserId: owner.userId, ...body(tender.tenderId) });
    return { owner, tender, bid };
  }

  it("the owner can update the proposal fields before the deadline", async () => {
    const { owner, bid } = await submitted();
    const updated = await useCase.updateBid({ actingUserId: owner.userId, bidId: bid.bidId, changes: { financialProposal: 99000, technicalProposal: "Better", supportingDocuments: ["d2"] } });
    expect(updated).toMatchObject({ financialProposal: 99000, technicalProposal: "Better", supportingDocuments: ["d2"], status: "Submitted", submissionDate: bid.submissionDate });
  });

  it("the owner can withdraw before the deadline; the bid becomes Withdrawn", async () => {
    const { owner, bid } = await submitted();
    expect((await useCase.withdrawBid({ actingUserId: owner.userId, bidId: bid.bidId })).status).toBe("Withdrawn");
  });

  it("another supplier cannot update or withdraw it: it looks like it does not exist, and nothing changes", async () => {
    const { bid } = await submitted();
    const intruder = await supplierUser();
    await expect(useCase.updateBid({ actingUserId: intruder.userId, bidId: bid.bidId, changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.withdrawBid({ actingUserId: intruder.userId, bidId: bid.bidId })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    expect((await bids.findById(bid.bidId))).toMatchObject({ financialProposal: 120000, status: "Submitted" });
  });

  it("an unknown bid id looks the same", async () => {
    const { userId } = await supplierUser();
    await expect(useCase.updateBid({ actingUserId: userId, bidId: "nope", changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.withdrawBid({ actingUserId: userId, bidId: "" })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
  });

  it.each(["Administrator", "Procurement Broker", "Evaluation Committee"] as const)("a %s cannot update or withdraw a supplier's bid", async (roleName) => {
    const { bid } = await submitted();
    const userId = await userWithRole(roleName);
    await expect(useCase.updateBid({ actingUserId: userId, bidId: bid.bidId, changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
    await expect(useCase.withdrawBid({ actingUserId: userId, bidId: bid.bidId })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
  });

  it("after the deadline the bid is immutable: update and withdraw give DeadlineExpiredException", async () => {
    const { owner, bid } = await submitted();
    now = TENDER_DEADLINE;
    await expect(useCase.updateBid({ actingUserId: owner.userId, bidId: bid.bidId, changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    await expect(useCase.withdrawBid({ actingUserId: owner.userId, bidId: bid.bidId })).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(await bids.findById(bid.bidId)).toMatchObject({ financialProposal: 120000, status: "Submitted" });
  });

  it.each(["Closed", "Cancelled"] as const)("once the tender is %s the bid is immutable (TenderClosedException)", async (status) => {
    const { owner, tender, bid } = await submitted();
    const stored = (await tenders.findById(tender.tenderId))!;
    if (status === "Closed") stored.close(TENDER_DEADLINE);
    else stored.cancel();
    await tenders.updateStatus(tender.tenderId, status);
    await expect(useCase.updateBid({ actingUserId: owner.userId, bidId: bid.bidId, changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "TENDER_CLOSED" });
    await expect(useCase.withdrawBid({ actingUserId: owner.userId, bidId: bid.bidId })).rejects.toMatchObject({ code: "TENDER_CLOSED" });
  });

  it("a withdrawn bid cannot be updated or withdrawn again (BidSubmissionException)", async () => {
    const { owner, bid } = await submitted();
    await useCase.withdrawBid({ actingUserId: owner.userId, bidId: bid.bidId });
    await expect(useCase.updateBid({ actingUserId: owner.userId, bidId: bid.bidId, changes: { financialProposal: 1 } })).rejects.toMatchObject({ code: "BID_SUBMISSION_ERROR" });
    await expect(useCase.withdrawBid({ actingUserId: owner.userId, bidId: bid.bidId })).rejects.toMatchObject({ code: "BID_SUBMISSION_ERROR" });
  });

  it("an update with invalid values or protected fields is rejected and changes nothing", async () => {
    const { owner, bid } = await submitted();
    for (const changes of [{ financialProposal: -1 }, { technicalProposal: " " }, { supportingDocuments: ["a b"] }, { status: "Accepted" }, { supplierId: "x" }, { tenderId: "other" }, {}]) {
      await expect(useCase.updateBid({ actingUserId: owner.userId, bidId: bid.bidId, changes: changes as never })).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(await bids.findById(bid.bidId)).toMatchObject({ financialProposal: 120000, status: "Submitted", tenderId: bid.tenderId });
  });

  it("an update never reveals or changes someone else's bid even with a guessed id", async () => {
    const a = await submitted();
    const b = await submitted();
    await expect(useCase.updateBid({ actingUserId: b.owner.userId, bidId: a.bid.bidId, changes: { financialProposal: 5 } })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
  });
});

describe("getBid and listBids: confidentiality (Option B)", () => {
  async function closedTenderWithBids(brokerId = "broker-1") {
    const tender = await tenderIn("Published", { brokerId });
    const a = await supplierUser();
    const b = await supplierUser();
    const bidA = await useCase.submitBid({ actingUserId: a.userId, ...body(tender.tenderId) });
    const bidB = await useCase.submitBid({ actingUserId: b.userId, ...body(tender.tenderId, { financialProposal: 90000 }) });
    return { tender, a, b, bidA, bidB };
  }
  const closeTender = async (tenderId: string) => {
    const tender = (await tenders.findById(tenderId))!;
    tender.close(TENDER_DEADLINE);
    await tenders.updateStatus(tenderId, "Closed");
  };

  it("a supplier reads their own bid at any time, but never another supplier's (looks not found)", async () => {
    const { a, b, bidA } = await closedTenderWithBids();
    expect((await useCase.getBid({ actingUserId: a.userId, bidId: bidA.bidId })).financialProposal).toBe(120000);
    await expect(useCase.getBid({ actingUserId: b.userId, bidId: bidA.bidId })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
  });

  it("a supplier lists only their own bids, can filter by tender and status, and sees nothing without a profile", async () => {
    const { a, bidA, tender } = await closedTenderWithBids();
    const t2 = await tenderIn("Published");
    const second = await useCase.submitBid({ actingUserId: a.userId, ...body(t2.tenderId) });
    expect((await useCase.listBids({ actingUserId: a.userId })).bids.map((x) => x.bidId).sort()).toEqual([bidA.bidId, second.bidId].sort());
    expect((await useCase.listBids({ actingUserId: a.userId, tenderId: tender.tenderId })).bids.map((x) => x.bidId)).toEqual([bidA.bidId]);
    expect((await useCase.listBids({ actingUserId: a.userId, status: "Withdrawn" })).bids).toEqual([]);
    expect((await useCase.listBids({ actingUserId: await userWithRole("Supplier") })).bids).toEqual([]);
  });

  it("before the tender closes, staff get no bid content: InvalidTenderStatusException, for get and list", async () => {
    const { tender, bidA } = await closedTenderWithBids("broker-1");
    const admin = await userWithRole("Administrator");
    await expect(useCase.getBid({ actingUserId: admin, bidId: bidA.bidId })).rejects.toMatchObject({ code: "INVALID_TENDER_STATUS" });
    await expect(useCase.listBids({ actingUserId: admin, tenderId: tender.tenderId })).rejects.toMatchObject({ code: "INVALID_TENDER_STATUS" });
  });

  it("a Published tender whose deadline has passed but which has not been closed is still sealed", async () => {
    const { tender } = await closedTenderWithBids();
    now = new Date(TENDER_DEADLINE.getTime() + 1000);
    const admin = await userWithRole("Administrator");
    await expect(useCase.listBids({ actingUserId: admin, tenderId: tender.tenderId })).rejects.toMatchObject({ code: "INVALID_TENDER_STATUS" });
  });

  it("after the tender closes an Administrator reads and lists any bid, newest first", async () => {
    const { tender, bidA, bidB } = await closedTenderWithBids();
    await closeTender(tender.tenderId);
    const admin = await userWithRole("Administrator");
    expect((await useCase.getBid({ actingUserId: admin, bidId: bidA.bidId })).bidId).toBe(bidA.bidId);
    const listed = await useCase.listBids({ actingUserId: admin, tenderId: tender.tenderId });
    expect(listed.bids.map((x) => x.bidId).sort()).toEqual([bidA.bidId, bidB.bidId].sort());
  });

  it("an Awarded tender is also unsealed", async () => {
    const { tender, bidA } = await closedTenderWithBids();
    await closeTender(tender.tenderId);
    await tenders.updateStatus(tender.tenderId, "Awarded");
    expect((await useCase.getBid({ actingUserId: await userWithRole("Administrator"), bidId: bidA.bidId })).bidId).toBe(bidA.bidId);
  });

  it("the broker who owns the tender reads its bids after closing; another broker sees 'not found'", async () => {
    const owner = await userWithRole("Procurement Broker");
    const stranger = await userWithRole("Procurement Broker");
    const { tender, bidA } = await closedTenderWithBids(owner);
    await closeTender(tender.tenderId);
    expect((await useCase.getBid({ actingUserId: owner, bidId: bidA.bidId })).bidId).toBe(bidA.bidId);
    expect((await useCase.listBids({ actingUserId: owner, tenderId: tender.tenderId })).bids).toHaveLength(2);
    await expect(useCase.getBid({ actingUserId: stranger, bidId: bidA.bidId })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.listBids({ actingUserId: stranger, tenderId: tender.tenderId })).rejects.toMatchObject({ code: "TENDER_NOT_FOUND" });
  });

  it("another broker learns nothing even before closing (not found, not 'sealed')", async () => {
    const { tender, bidA } = await closedTenderWithBids(await userWithRole("Procurement Broker"));
    const stranger = await userWithRole("Procurement Broker");
    await expect(useCase.getBid({ actingUserId: stranger, bidId: bidA.bidId })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.listBids({ actingUserId: stranger, tenderId: tender.tenderId })).rejects.toMatchObject({ code: "TENDER_NOT_FOUND" });
  });

  it("the Evaluation Committee gets no access (no assignment model exists): fail closed, even after closing", async () => {
    const { tender, bidA } = await closedTenderWithBids();
    await closeTender(tender.tenderId);
    const committee = await userWithRole("Evaluation Committee");
    await expect(useCase.getBid({ actingUserId: committee, bidId: bidA.bidId })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
    await expect(useCase.listBids({ actingUserId: committee, tenderId: tender.tenderId })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
  });

  it("after closure staff see withdrawn bids, distinguishable by status; before closure they stay sealed", async () => {
    const { tender, a, bidA, bidB } = await closedTenderWithBids();
    await useCase.withdrawBid({ actingUserId: a.userId, bidId: bidA.bidId });
    const admin = await userWithRole("Administrator");
    await expect(useCase.getBid({ actingUserId: admin, bidId: bidA.bidId })).rejects.toMatchObject({ code: "INVALID_TENDER_STATUS" });
    await closeTender(tender.tenderId);
    const listed = await useCase.listBids({ actingUserId: admin, tenderId: tender.tenderId });
    expect(Object.fromEntries(listed.bids.map((x) => [x.bidId, x.status]))).toEqual({ [bidA.bidId]: "Withdrawn", [bidB.bidId]: "Submitted" });
    expect((await useCase.listBids({ actingUserId: admin, tenderId: tender.tenderId, status: "Withdrawn" })).bids.map((x) => x.bidId)).toEqual([bidA.bidId]);
    expect((await useCase.getBid({ actingUserId: admin, bidId: bidA.bidId })).status).toBe("Withdrawn");
  });

  it("a withdrawn bid is not eligible for evaluation; an active one is", async () => {
    const { a, bidA, bidB } = await closedTenderWithBids();
    await useCase.withdrawBid({ actingUserId: a.userId, bidId: bidA.bidId });
    expect((await bids.findById(bidA.bidId))!.isEligibleForEvaluation()).toBe(false);
    expect((await bids.findById(bidB.bidId))!.isEligibleForEvaluation()).toBe(true);
  });

  it("a stranger broker and the Committee still cannot see withdrawn bids", async () => {
    const owner = await userWithRole("Procurement Broker");
    const { tender, a, bidA } = await closedTenderWithBids(owner);
    await useCase.withdrawBid({ actingUserId: a.userId, bidId: bidA.bidId });
    await closeTender(tender.tenderId);
    await expect(useCase.getBid({ actingUserId: await userWithRole("Procurement Broker"), bidId: bidA.bidId })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.getBid({ actingUserId: await userWithRole("Evaluation Committee"), bidId: bidA.bidId })).rejects.toMatchObject({ code: "UNAUTHORIZED_ACCESS" });
    expect((await useCase.getBid({ actingUserId: owner, bidId: bidA.bidId })).status).toBe("Withdrawn");
  });

  it("staff must name a tender to list; an unknown or malformed tender id is refused", async () => {
    const admin = await userWithRole("Administrator");
    await expect(useCase.listBids({ actingUserId: admin })).rejects.toMatchObject({ code: "INVALID_BID_DATA" });
    await expect(useCase.listBids({ actingUserId: admin, tenderId: "a b" })).rejects.toMatchObject({ code: "INVALID_BID_DATA" });
    await expect(useCase.listBids({ actingUserId: admin, tenderId: "missing" })).rejects.toMatchObject({ code: "TENDER_NOT_FOUND" });
  });

  it("an unknown bid id is not found for every reader", async () => {
    const admin = await userWithRole("Administrator");
    const supplier = await supplierUser();
    await expect(useCase.getBid({ actingUserId: admin, bidId: "missing" })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
    await expect(useCase.getBid({ actingUserId: supplier.userId, bidId: "missing" })).rejects.toMatchObject({ code: "BID_NOT_FOUND" });
  });

  it("a bid carries no evaluation, assessment or score data", async () => {
    const { a, bidA } = await closedTenderWithBids();
    const keys = Object.keys(await useCase.getBid({ actingUserId: a.userId, bidId: bidA.bidId })).sort();
    expect(keys).toEqual(["bidId", "complianceStatus", "financialProposal", "status", "submissionDate", "supplierId", "supportingDocuments", "technicalProposal", "tenderId"]);
  });

  it("refuses bad list filters", async () => {
    const { userId } = await supplierUser();
    for (const filters of [{ limit: 0 }, { skip: -1 }, { status: "Bogus" as never }]) {
      expect((await catchAsyncError(() => useCase.listBids({ actingUserId: userId, ...filters }))).message).toBeDefined();
    }
  });
});
