import { describe, expect, it } from "vitest";
import { Bid, BID_STATUS_TRANSITIONS, BID_STATUSES, normalizeBidQuery } from "@/entities/Bid";
import { BidSubmissionException, InvalidBidDataException, InvalidDocumentException } from "@/entities/exceptions";
import { catchError, makeBid, TENDER_NOW } from "../support/fixtures";

const valid = {
  bidId: "bid-1",
  tenderId: "tender-1",
  supplierId: "supplier-1",
  technicalProposal: "We deliver in 30 days.",
  financialProposal: 1000,
};

describe("Bid.submit (ODD createBid / submit / validateSubmission)", () => {
  it("creates a Submitted, Compliant bid with the given values", () => {
    const bid = Bid.submit({ ...valid, supportingDocuments: ["doc-1"], submissionDate: TENDER_NOW });
    expect(bid.toJSON()).toEqual({
      ...valid,
      supportingDocuments: ["doc-1"],
      submissionDate: TENDER_NOW.toISOString(),
      status: "Submitted",
      complianceStatus: "Compliant",
    });
  });

  it("supporting documents are optional and default to none; the date defaults to now", () => {
    const bid = Bid.submit(valid);
    expect(bid.supportingDocuments).toEqual([]);
    expect(Math.abs(bid.submissionDate.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("trims the technical proposal and document references", () => {
    const bid = Bid.submit({ ...valid, technicalProposal: "  plan  ", supportingDocuments: ["  doc-1  "] });
    expect(bid.technicalProposal).toBe("plan");
    expect(bid.supportingDocuments).toEqual(["doc-1"]);
  });

  it.each([
    ["missing technical proposal", { technicalProposal: undefined }],
    ["blank technical proposal", { technicalProposal: "   " }],
    ["non-string technical proposal", { technicalProposal: 5 }],
    ["too long technical proposal", { technicalProposal: "x".repeat(5001) }],
    ["missing financial proposal", { financialProposal: undefined }],
    ["string financial proposal", { financialProposal: "1000" }],
    ["zero financial proposal", { financialProposal: 0 }],
    ["negative financial proposal", { financialProposal: -1 }],
    ["NaN financial proposal", { financialProposal: Number.NaN }],
    ["Infinity financial proposal", { financialProposal: Number.POSITIVE_INFINITY }],
    ["huge financial proposal", { financialProposal: 1e16 }],
    ["missing tender id", { tenderId: undefined }],
    ["tender id with spaces", { tenderId: "a b" }],
    ["missing supplier id", { supplierId: "" }],
    ["invalid date", { submissionDate: new Date("nope") }],
  ])("rejects %s with InvalidBidDataException", (_label, override) => {
    expect(catchError(() => Bid.submit({ ...valid, ...override } as never))).toBeInstanceOf(InvalidBidDataException);
  });

  it("lists every problem at once", () => {
    const error = catchError(() => Bid.submit({ ...valid, technicalProposal: "", financialProposal: -1 })) as InvalidBidDataException;
    expect(error.issues).toHaveLength(2);
  });

  it.each([
    ["a non-list", "doc-1"],
    ["a blank item", [" "]],
    ["an item with spaces", ["a b"]],
    ["a non-string item", [5]],
    ["a duplicate", ["d1", "d1"]],
    ["a too long item", ["d".repeat(101)]],
    ["too many items", Array.from({ length: 21 }, (_, i) => `d${i}`)],
  ])("rejects supporting documents that are %s with InvalidDocumentException", (_label, supportingDocuments) => {
    expect(catchError(() => Bid.submit({ ...valid, supportingDocuments } as never))).toBeInstanceOf(InvalidDocumentException);
  });

  it("returns copies of its lists and dates so callers cannot change it", () => {
    const bid = makeBid();
    bid.supportingDocuments.push("sneaky");
    bid.submissionDate.setFullYear(1999);
    expect(bid.supportingDocuments).not.toContain("sneaky");
    expect(bid.submissionDate.getFullYear()).toBe(TENDER_NOW.getFullYear());
  });
});

describe("Bid.restore", () => {
  it("rejects an unknown status or compliance status", () => {
    const stored = { ...makeBid().toJSON(), submissionDate: TENDER_NOW };
    expect(catchError(() => Bid.restore({ ...stored, status: "Accepted!" as never }))).toBeInstanceOf(InvalidBidDataException);
    expect(catchError(() => Bid.restore({ ...stored, complianceStatus: "Maybe" as never }))).toBeInstanceOf(InvalidBidDataException);
  });
});

describe("Bid.updateBid", () => {
  it("changes the proposal fields only", () => {
    const bid = makeBid();
    bid.updateBid({ technicalProposal: "New plan", financialProposal: 5, supportingDocuments: ["d9"] });
    expect(bid).toMatchObject({ technicalProposal: "New plan", financialProposal: 5, status: "Submitted" });
    expect(bid.supportingDocuments).toEqual(["d9"]);
  });

  it("changes nothing when a value is invalid", () => {
    const bid = makeBid();
    const before = bid.toJSON();
    expect(catchError(() => bid.updateBid({ technicalProposal: "ok", financialProposal: -1 }))).toBeInstanceOf(InvalidBidDataException);
    expect(bid.toJSON()).toEqual(before);
  });

  it("rejects protected fields and an empty change", () => {
    const bid = makeBid();
    for (const changes of [{ status: "Accepted" }, { supplierId: "x" }, { tenderId: "x" }, { submissionDate: new Date() }, {}]) {
      expect(catchError(() => bid.updateBid(changes as never))).toBeInstanceOf(InvalidBidDataException);
    }
  });

  it("refuses to change a bid that is not Submitted", () => {
    const bid = makeBid();
    bid.withdraw();
    expect(catchError(() => bid.updateBid({ financialProposal: 1 }))).toBeInstanceOf(BidSubmissionException);
  });
});

describe("Bid status rules", () => {
  it("withdraw() makes a Submitted bid Withdrawn, and a withdrawn bid is final", () => {
    const bid = makeBid();
    bid.withdraw();
    expect(bid.status).toBe("Withdrawn");
    expect(bid.isModifiable()).toBe(false);
    expect(catchError(() => bid.withdraw())).toBeInstanceOf(BidSubmissionException);
    expect(catchError(() => bid.changeStatus("Submitted"))).toBeInstanceOf(BidSubmissionException);
  });

  it("follows the transition table", () => {
    for (const from of BID_STATUSES) {
      for (const to of BID_STATUSES) {
        const bid = Bid.restore({ ...makeBid().toJSON(), submissionDate: TENDER_NOW, status: from });
        const allowed = BID_STATUS_TRANSITIONS[from].includes(to);
        if (allowed) {
          bid.changeStatus(to);
          expect(bid.status).toBe(to);
        } else {
          expect(catchError(() => bid.changeStatus(to))).toBeInstanceOf(BidSubmissionException);
        }
      }
    }
  });

  it("rejects an invalid status value", () => {
    expect(catchError(() => makeBid().changeStatus("Bogus" as never))).toBeInstanceOf(InvalidBidDataException);
  });
});

describe("normalizeBidQuery", () => {
  it("uses defaults, accepts valid filters, and rejects bad ones", () => {
    expect(normalizeBidQuery()).toEqual({ statuses: null, tenderId: null, limit: 100, skip: 0 });
    expect(normalizeBidQuery({ status: ["Submitted", "Submitted"], tenderId: "t", limit: 5, skip: 2 })).toEqual({ statuses: ["Submitted"], tenderId: "t", limit: 5, skip: 2 });
    for (const bad of [{ status: [] }, { status: "Nope" }, { tenderId: "a b" }, { limit: 0 }, { limit: 501 }, { skip: -1 }, { skip: 1.5 }]) {
      expect(catchError(() => normalizeBidQuery(bad as never))).toBeInstanceOf(InvalidBidDataException);
    }
  });
});
