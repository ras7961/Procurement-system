import { beforeEach, describe, expect, it } from "vitest";
import { Evaluation } from "@/entities/Evaluation";
import {
  EvaluationAlreadyCompletedException,
  EvaluationNotFoundException,
  EvaluationRepositoryException,
  IncompleteEvaluationException,
  InvalidEvaluationScoreException,
} from "@/entities/exceptions";
import type { EvaluationRepositoryInterface } from "@/interfaces/repositories/EvaluationRepositoryInterface";
import { catchAsyncError, makeBid, TENDER_NOW } from "./fixtures";

let n = 0;
export function makeEvaluation(overrides: { tenderId?: string; bidId?: string; evaluatorId?: string; minutes?: number } = {}): Evaluation {
  n += 1;
  const bid = makeBid({ ...(overrides.tenderId ? { tenderId: overrides.tenderId } : {}), bidId: overrides.bidId ?? `eval-bid-${n}` });
  return Evaluation.create({ evaluationId: `eval-${n}`, bid, evaluatorId: overrides.evaluatorId ?? "evaluator-1", now: new Date(TENDER_NOW.getTime() + (overrides.minutes ?? 0) * 60_000) });
}
function scored(e: Evaluation): Evaluation {
  e.assessTechnicalProposal(70);
  e.assessFinancialProposal(80);
  e.checkCompliance("Compliant");
  return e;
}

/** Behaviour every EvaluationRepositoryInterface implementation must have. */
export function runEvaluationRepositoryContract(name: string, create: () => Promise<EvaluationRepositoryInterface> | EvaluationRepositoryInterface) {
  describe(`EvaluationRepositoryInterface contract: ${name}`, () => {
    let repo: EvaluationRepositoryInterface;
    beforeEach(async () => {
      repo = await create();
    });

    it("stores an evaluation and findById returns every field; unknown id gives null; returns copies", async () => {
      const e = makeEvaluation();
      const created = await repo.create(e);
      created.addComments("changed locally");
      expect((await repo.findById(e.evaluationId))?.toJSON()).toEqual(e.toJSON());
      expect(await repo.findById("missing")).toBeNull();
    });

    it("rejects an existing evaluationId", async () => {
      const e = makeEvaluation();
      await repo.create(e);
      expect(await catchAsyncError(() => repo.create(e))).toBeInstanceOf(EvaluationRepositoryException);
    });

    it("finds by bid, tender and evaluator, newest first, with paging", async () => {
      const old = await repo.create(makeEvaluation({ tenderId: "t-1", evaluatorId: "ev-1", minutes: 1 }));
      const recent = await repo.create(makeEvaluation({ tenderId: "t-1", evaluatorId: "ev-2", minutes: 9 }));
      await repo.create(makeEvaluation({ tenderId: "t-2", evaluatorId: "ev-1", minutes: 5 }));
      expect((await repo.findByTenderId("t-1")).map((e) => e.evaluationId)).toEqual([recent.evaluationId, old.evaluationId]);
      expect((await repo.findByTenderId("t-1", { limit: 1, skip: 1 })).map((e) => e.evaluationId)).toEqual([old.evaluationId]);
      expect(await repo.findByEvaluatorId("ev-1")).toHaveLength(2);
      expect((await repo.findByBidId(old.bidId)).map((e) => e.evaluationId)).toEqual([old.evaluationId]);
      expect(await repo.findByTenderId("none")).toEqual([]);
      for (const query of [{ limit: 0 }, { limit: 501 }, { skip: -1 }]) {
        expect(await catchAsyncError(() => repo.findByTenderId("t-1", query))).toBeInstanceOf(InvalidEvaluationScoreException);
      }
    });

    it("update stores the entity's changes; a completed evaluation is final and listed as completed", async () => {
      const e = await repo.create(makeEvaluation({ tenderId: "t-9" }));
      scored(e);
      e.addComments("solid");
      await repo.update(e);
      expect((await repo.findById(e.evaluationId))?.toJSON()).toEqual(e.toJSON());
      expect(await repo.findCompletedByTenderId("t-9")).toEqual([]);
      const done = await repo.updateStatus(e.evaluationId, "Completed");
      expect(done.evaluationStatus).toBe("Completed");
      expect((await repo.findCompletedByTenderId("t-9")).map((x) => x.evaluationId)).toEqual([e.evaluationId]);
      const stale = (await repo.findById(e.evaluationId))!;
      expect(await catchAsyncError(() => repo.update(stale))).toBeInstanceOf(EvaluationAlreadyCompletedException);
      expect(await catchAsyncError(() => repo.updateStatus(e.evaluationId, "In Progress"))).toBeInstanceOf(EvaluationAlreadyCompletedException);
    });

    it("updateStatus: unknown id, incomplete completion and forbidden transitions", async () => {
      const e = await repo.create(makeEvaluation());
      expect(await catchAsyncError(() => repo.updateStatus("missing", "In Progress"))).toBeInstanceOf(EvaluationNotFoundException);
      expect(await catchAsyncError(() => repo.update(makeEvaluation()))).toBeInstanceOf(EvaluationNotFoundException);
      expect(await catchAsyncError(() => repo.updateStatus(e.evaluationId, "Completed"))).toBeInstanceOf(IncompleteEvaluationException);
      expect(await catchAsyncError(() => repo.updateStatus(e.evaluationId, "Approved"))).toBeInstanceOf(InvalidEvaluationScoreException);
      expect((await repo.updateStatus(e.evaluationId, "In Progress")).evaluationStatus).toBe("In Progress");
      expect((await repo.findById(e.evaluationId))?.evaluationStatus).toBe("In Progress");
    });

    it("with expectedStatus a stale write is refused", async () => {
      const e = await repo.create(makeEvaluation());
      expect(await catchAsyncError(() => repo.updateStatus(e.evaluationId, "In Progress", { expectedStatus: "In Progress" }))).toBeInstanceOf(EvaluationRepositoryException);
    });
  });
}
