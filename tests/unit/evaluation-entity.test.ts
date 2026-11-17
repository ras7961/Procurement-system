import { describe, expect, it } from "vitest";
import { Evaluation } from "@/entities/Evaluation";
import {
  BidNotEligibleForEvaluationException,
  EvaluationAlreadyCompletedException,
  IncompleteEvaluationException,
  InvalidEvaluationScoreException,
} from "@/entities/exceptions";
import { makeBid, TENDER_NOW } from "../support/fixtures";

const create = (bid = makeBid()) => Evaluation.create({ evaluationId: "ev-1", bid, evaluatorId: "u-1", now: TENDER_NOW });

describe("Evaluation entity", () => {
  it("starts Pending with no scores, no total and no final result; tender comes from the bid", () => {
    const bid = makeBid();
    const e = create(bid);
    expect(e.toJSON()).toMatchObject({ bidId: bid.bidId, tenderId: bid.tenderId, evaluatorId: "u-1", evaluationStatus: "Pending", technicalScore: null, financialScore: null, totalScore: null, finalResult: null, comments: "" });
  });

  it("never evaluates a withdrawn bid (Bid.isEligibleForEvaluation)", () => {
    const bid = makeBid();
    bid.withdraw();
    expect(() => create(bid)).toThrow(BidNotEligibleForEvaluationException);
    expect(create(makeBid()).evaluationId).toBe("ev-1");
  });

  it("records scores, compliance and comments, moving to In Progress; the total is never computed", () => {
    const e = create();
    e.assessTechnicalProposal(0);
    e.assessFinancialProposal(55.5);
    expect(e.evaluationStatus).toBe("In Progress");
    e.checkCompliance("NonCompliant");
    e.addComments("notes");
    expect(e).toMatchObject({ technicalScore: 0, financialScore: 55.5, complianceResult: "NonCompliant", comments: "notes", totalScore: null });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])("rejects the score %s", (bad) => {
    const e = create();
    expect(() => e.assessTechnicalProposal(bad)).toThrow(InvalidEvaluationScoreException);
    expect(() => e.assessFinancialProposal(bad)).toThrow(InvalidEvaluationScoreException);
    expect(e.technicalScore).toBeNull();
  });

  it("rejects an invalid compliance result and over-long comments", () => {
    const e = create();
    expect(() => e.checkCompliance("Maybe" as never)).toThrow(InvalidEvaluationScoreException);
    expect(() => e.addComments("x".repeat(2001))).toThrow(InvalidEvaluationScoreException);
  });

  it("completes only when both scores and compliance are recorded, then is final", () => {
    const e = create();
    e.assessTechnicalProposal(10);
    expect(() => e.complete()).toThrow(IncompleteEvaluationException);
    e.assessFinancialProposal(20);
    e.checkCompliance("Compliant");
    e.complete();
    expect(e.evaluationStatus).toBe("Completed");
    expect(() => e.assessTechnicalProposal(1)).toThrow(EvaluationAlreadyCompletedException);
    expect(() => e.addComments("late")).toThrow(EvaluationAlreadyCompletedException);
    expect(() => e.complete()).toThrow(EvaluationAlreadyCompletedException);
    expect(e.technicalScore).toBe(10);
  });

  it("restore validates stored data", () => {
    const json = create().toJSON();
    expect(() => Evaluation.restore({ ...json, evaluationDate: new Date(json.evaluationDate), evaluationStatus: "Bogus" as never })).toThrow(InvalidEvaluationScoreException);
    expect(() => Evaluation.restore({ ...json, evaluationDate: new Date(json.evaluationDate), technicalScore: -3 })).toThrow(InvalidEvaluationScoreException);
  });
});
