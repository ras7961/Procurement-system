import { beforeEach, describe, expect, it } from "vitest";
import {
  BidNotFoundException,
  BidRepositoryException,
  BidSubmissionException,
  DuplicateBidException,
  InvalidBidDataException,
  InvalidDocumentException,
} from "@/entities/exceptions";
import type { BidRepositoryInterface } from "@/interfaces/repositories/BidRepositoryInterface";
import { catchAsyncError, makeBid, TENDER_NOW } from "./fixtures";

const minute = (n: number) => new Date(TENDER_NOW.getTime() + n * 60 * 1000);

/** Behaviour every BidRepositoryInterface implementation must have. */
export function runBidRepositoryContract(name: string, createRepository: () => Promise<BidRepositoryInterface> | BidRepositoryInterface) {
  describe(`BidRepositoryInterface contract: ${name}`, () => {
    let repository: BidRepositoryInterface;

    beforeEach(async () => {
      repository = await createRepository();
    });

    describe("create and findById", () => {
      it("stores a bid that findById() returns with every field", async () => {
        const bid = makeBid();
        await repository.create(bid);
        expect((await repository.findById(bid.bidId))?.toJSON()).toEqual(bid.toJSON());
      });

      it("findById returns null when nothing matches", async () => {
        expect(await repository.findById("missing")).toBeNull();
      });

      it("create() rejects an existing bidId with BidRepositoryException", async () => {
        const bid = makeBid();
        await repository.create(bid);
        const error = await catchAsyncError(() => repository.create(makeBid({ bidId: bid.bidId })));
        expect(error).toBeInstanceOf(BidRepositoryException);
      });

      it("returns copies: changing a returned bid does not change the stored one", async () => {
        const bid = makeBid();
        const created = await repository.create(bid);
        created.withdraw();
        expect((await repository.findById(bid.bidId))?.status).toBe("Submitted");
      });
    });

    describe("one bid per supplier per tender", () => {
      it("create() rejects a second bid for the same supplier and tender with DuplicateBidException", async () => {
        await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" }));
        expect(await catchAsyncError(() => repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" })))).toBeInstanceOf(DuplicateBidException);
      });

      it("a withdrawn bid still counts: the supplier cannot bid again on that tender", async () => {
        const first = await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" }));
        await repository.updateStatus(first.bidId, "Withdrawn");
        expect(await catchAsyncError(() => repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" })))).toBeInstanceOf(DuplicateBidException);
      });

      it("the same supplier can bid on another tender, and another supplier on the same tender", async () => {
        await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" }));
        await repository.create(makeBid({ tenderId: "t-2", supplierId: "s-1" }));
        await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-2" }));
        expect(await repository.findByTenderId("t-1")).toHaveLength(2);
      });

      it("only one of many concurrent submissions for the same supplier and tender is stored", async () => {
        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, () => repository.create(makeBid({ tenderId: "race-tender", supplierId: "race-supplier" }))),
        );
        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        for (const attempt of attempts) {
          if (attempt.status === "rejected") expect(attempt.reason).toBeInstanceOf(DuplicateBidException);
        }
        expect(await repository.findByTenderId("race-tender")).toHaveLength(1);
      });

      it("existsBySupplierAndTender() reflects the stored bids, in any status", async () => {
        expect(await repository.existsBySupplierAndTender("s-1", "t-1")).toBe(false);
        const bid = await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" }));
        expect(await repository.existsBySupplierAndTender("s-1", "t-1")).toBe(true);
        expect(await repository.existsBySupplierAndTender("s-1", "t-2")).toBe(false);
        expect(await repository.existsBySupplierAndTender("s-2", "t-1")).toBe(false);
        await repository.updateStatus(bid.bidId, "Withdrawn");
        expect(await repository.existsBySupplierAndTender("s-1", "t-1")).toBe(true);
      });
    });

    describe("findByTenderId and findBySupplierId", () => {
      it("return only the bids of that tender or supplier, newest first", async () => {
        const oldest = await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1", submissionDate: minute(1) }));
        const newest = await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-2", submissionDate: minute(9) }));
        await repository.create(makeBid({ tenderId: "t-2", supplierId: "s-3", submissionDate: minute(5) }));
        expect((await repository.findByTenderId("t-1")).map((bid) => bid.bidId)).toEqual([newest.bidId, oldest.bidId]);
        expect((await repository.findBySupplierId("s-1")).map((bid) => bid.bidId)).toEqual([oldest.bidId]);
      });

      it("return an empty list when nothing matches", async () => {
        expect(await repository.findByTenderId("none")).toEqual([]);
        expect(await repository.findBySupplierId("none")).toEqual([]);
      });

      it("filter by status (one or several) and, for a supplier, by tender", async () => {
        const submitted = await repository.create(makeBid({ tenderId: "t-1", supplierId: "s-1" }));
        const withdrawn = await repository.create(makeBid({ tenderId: "t-2", supplierId: "s-1" }));
        await repository.updateStatus(withdrawn.bidId, "Withdrawn");
        expect((await repository.findBySupplierId("s-1", { status: "Withdrawn" })).map((bid) => bid.bidId)).toEqual([withdrawn.bidId]);
        expect(await repository.findBySupplierId("s-1", { status: ["Submitted", "Withdrawn"] })).toHaveLength(2);
        expect((await repository.findBySupplierId("s-1", { tenderId: "t-1" })).map((bid) => bid.bidId)).toEqual([submitted.bidId]);
      });

      it("page with limit and skip", async () => {
        for (let i = 0; i < 5; i += 1) await repository.create(makeBid({ tenderId: "t-1", supplierId: `s-${i}`, submissionDate: minute(i) }));
        expect(await repository.findByTenderId("t-1", { limit: 2 })).toHaveLength(2);
        expect(await repository.findByTenderId("t-1", { limit: 2, skip: 4 })).toHaveLength(1);
      });

      it("reject bad filters with InvalidBidDataException", async () => {
        for (const filters of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { skip: -1 }, { status: "Bogus" as never }]) {
          expect(await catchAsyncError(() => repository.findByTenderId("t-1", filters))).toBeInstanceOf(InvalidBidDataException);
        }
      });
    });

    describe("update", () => {
      it("changes the proposal fields and nothing else", async () => {
        const bid = await repository.create(makeBid());
        const updated = await repository.update(bid.bidId, { technicalProposal: "A better plan.", financialProposal: 199999, supportingDocuments: ["doc-new"] });
        expect(updated.toJSON()).toEqual({
          ...bid.toJSON(),
          technicalProposal: "A better plan.",
          financialProposal: 199999,
          supportingDocuments: ["doc-new"],
        });
        expect((await repository.findById(bid.bidId))?.toJSON()).toEqual(updated.toJSON());
      });

      it("an empty update returns the bid unchanged", async () => {
        const bid = await repository.create(makeBid());
        expect((await repository.update(bid.bidId, {})).toJSON()).toEqual(bid.toJSON());
      });

      it("refuses protected fields and changes nothing", async () => {
        const bid = await repository.create(makeBid());
        for (const data of [{ status: "Accepted" }, { supplierId: "s-other" }, { tenderId: "t-other" }, { bidId: "x" }, { submissionDate: new Date() }, { complianceStatus: "NonCompliant" }]) {
          expect(await catchAsyncError(() => repository.update(bid.bidId, data as never))).toBeInstanceOf(InvalidBidDataException);
        }
        expect((await repository.findById(bid.bidId))?.toJSON()).toEqual(bid.toJSON());
      });

      it("refuses invalid values and changes nothing", async () => {
        const bid = await repository.create(makeBid());
        expect(await catchAsyncError(() => repository.update(bid.bidId, { financialProposal: -5 }))).toBeInstanceOf(InvalidBidDataException);
        expect(await catchAsyncError(() => repository.update(bid.bidId, { technicalProposal: "  " }))).toBeInstanceOf(InvalidBidDataException);
        expect(await catchAsyncError(() => repository.update(bid.bidId, { supportingDocuments: ["has space"] }))).toBeInstanceOf(InvalidDocumentException);
        expect((await repository.findById(bid.bidId))?.toJSON()).toEqual(bid.toJSON());
      });

      it("refuses to change a bid that is no longer Submitted (BidSubmissionException)", async () => {
        const bid = await repository.create(makeBid());
        await repository.updateStatus(bid.bidId, "Withdrawn");
        expect(await catchAsyncError(() => repository.update(bid.bidId, { financialProposal: 1 }))).toBeInstanceOf(BidSubmissionException);
      });

      it("an unknown bid gives BidNotFoundException", async () => {
        expect(await catchAsyncError(() => repository.update("missing", { financialProposal: 1 }))).toBeInstanceOf(BidNotFoundException);
      });

      it("with expectedStatus it refuses when the status differs", async () => {
        const bid = await repository.create(makeBid());
        await repository.updateStatus(bid.bidId, "Under Evaluation");
        expect(await catchAsyncError(() => repository.update(bid.bidId, { financialProposal: 1 }, { expectedStatus: "Submitted" }))).toBeInstanceOf(BidSubmissionException);
      });
    });

    describe("updateStatus", () => {
      it("withdraws a Submitted bid", async () => {
        const bid = await repository.create(makeBid());
        expect((await repository.updateStatus(bid.bidId, "Withdrawn", { expectedStatus: "Submitted" })).status).toBe("Withdrawn");
        expect((await repository.findById(bid.bidId))?.status).toBe("Withdrawn");
      });

      it("refuses a transition the bid does not allow, and a final status", async () => {
        const bid = await repository.create(makeBid());
        expect(await catchAsyncError(() => repository.updateStatus(bid.bidId, "Accepted"))).toBeInstanceOf(BidSubmissionException);
        await repository.updateStatus(bid.bidId, "Withdrawn");
        expect(await catchAsyncError(() => repository.updateStatus(bid.bidId, "Submitted"))).toBeInstanceOf(BidSubmissionException);
        expect((await repository.findById(bid.bidId))?.status).toBe("Withdrawn");
      });

      it("refuses an invalid status value with InvalidBidDataException", async () => {
        const bid = await repository.create(makeBid());
        expect(await catchAsyncError(() => repository.updateStatus(bid.bidId, "Bogus" as never))).toBeInstanceOf(InvalidBidDataException);
      });

      it("an unknown bid gives BidNotFoundException", async () => {
        expect(await catchAsyncError(() => repository.updateStatus("missing", "Withdrawn"))).toBeInstanceOf(BidNotFoundException);
      });

      it("with expectedStatus, only one of two concurrent withdrawals succeeds", async () => {
        const bid = await repository.create(makeBid());
        const results = await Promise.allSettled([
          repository.updateStatus(bid.bidId, "Withdrawn", { expectedStatus: "Submitted" }),
          repository.updateStatus(bid.bidId, "Withdrawn", { expectedStatus: "Submitted" }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
        for (const result of results) {
          if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BidSubmissionException);
        }
        expect((await repository.findById(bid.bidId))?.status).toBe("Withdrawn");
      });
    });
  });
}
