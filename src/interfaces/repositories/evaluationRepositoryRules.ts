import { Evaluation, type EvaluationStatus } from "@/entities/Evaluation";
import { EvaluationAlreadyCompletedException, EvaluationRepositoryException, InvalidEvaluationScoreException } from "@/entities/exceptions";
import type { EvaluationWriteCondition } from "./EvaluationRepositoryInterface";

/** Shared by every repository so they all follow the same rules. */
export function cloneEvaluation(evaluation: Evaluation): Evaluation {
  const json = evaluation.toJSON();
  return Evaluation.restore({ ...json, evaluationDate: new Date(json.evaluationDate) });
}

/** Refuses a write to a finished evaluation or one whose status is not the expected one. */
export function assertWritable(stored: Evaluation, condition: EvaluationWriteCondition = {}): void {
  if (stored.evaluationStatus === "Completed" || stored.evaluationStatus === "Approved") throw new EvaluationAlreadyCompletedException();
  if (condition.expectedStatus !== undefined && stored.evaluationStatus !== condition.expectedStatus) {
    throw new EvaluationRepositoryException({ details: { reason: "the evaluation was changed by another request" } });
  }
}

/** The evaluation after a status change, or an exception. Completing goes through Evaluation.complete(). */
export function applyEvaluationStatusChange(stored: Evaluation, status: EvaluationStatus, condition: EvaluationWriteCondition = {}): Evaluation {
  assertWritable(stored, condition);
  const next = cloneEvaluation(stored);
  if (status === "Completed") {
    next.complete();
    return next;
  }
  if (status === "In Progress" && stored.evaluationStatus === "Pending") {
    // Only the entity operations change a status; an empty comment keeps every other field the same.
    next.addComments(stored.comments);
    return next;
  }
  throw new InvalidEvaluationScoreException([`the evaluation cannot move from ${stored.evaluationStatus} to ${status}`]);
}
