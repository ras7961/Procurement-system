import type { Evaluation, EvaluationQueryInput, EvaluationStatus } from "@/entities/Evaluation";

/**
 * ODD: interfaces.EvaluationRepositoryInterface. Operations kept from the ODD: create, findById, findByBidId, findByEvaluatorId,
 * findCompletedByTenderId, updateStatus, and update (which stores the changes made on an Evaluation entity). Extra (for reading a
 * tender's evaluations): findByTenderId. There is no delete: evaluations are procurement records.
 *
 * Contract (tests/support/evaluationRepositoryContract.ts checks every implementation): findById returns null when nothing matches.
 * Lists are newest evaluationDate first (ties by evaluationId), at most 100 unless `limit` (1 to 500) says otherwise, `skip` pages;
 * bad paging throws InvalidEvaluationScoreException. create() with an existing evaluationId throws EvaluationRepositoryException.
 * update() and updateStatus() throw EvaluationNotFoundException for an unknown id. A Completed or Approved evaluation is never
 * changed (EvaluationAlreadyCompletedException). With `expectedStatus`, a write applies only if the stored status matches, so two
 * competing requests cannot both succeed (the loser gets EvaluationRepositoryException). updateStatus() only moves
 * Pending -> In Progress, or In Progress/Pending -> Completed when the evaluation is complete (IncompleteEvaluationException otherwise).
 * Storage failures throw EvaluationRepositoryException / DatabaseOperationException, never a raw driver error.
 */
export interface EvaluationWriteCondition {
  expectedStatus?: EvaluationStatus;
}

export interface EvaluationRepositoryInterface {
  create(evaluation: Evaluation): Promise<Evaluation>;
  findById(evaluationId: string): Promise<Evaluation | null>;
  findByBidId(bidId: string, query?: EvaluationQueryInput): Promise<Evaluation[]>;
  findByTenderId(tenderId: string, query?: EvaluationQueryInput): Promise<Evaluation[]>;
  findByEvaluatorId(evaluatorId: string, query?: EvaluationQueryInput): Promise<Evaluation[]>;
  findCompletedByTenderId(tenderId: string, query?: EvaluationQueryInput): Promise<Evaluation[]>;
  update(evaluation: Evaluation, condition?: EvaluationWriteCondition): Promise<Evaluation>;
  updateStatus(evaluationId: string, status: EvaluationStatus, condition?: EvaluationWriteCondition): Promise<Evaluation>;
}
