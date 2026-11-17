import { normalizeEvaluationQuery, type Evaluation, type EvaluationQueryInput, type EvaluationStatus } from "@/entities/Evaluation";
import { EvaluationNotFoundException, EvaluationRepositoryException } from "@/entities/exceptions";
import type { EvaluationRepositoryInterface, EvaluationWriteCondition } from "@/interfaces/repositories/EvaluationRepositoryInterface";
import { applyEvaluationStatusChange, assertWritable, cloneEvaluation } from "@/interfaces/repositories/evaluationRepositoryRules";

/** Test double implementing EvaluationRepositoryInterface in memory with the shared rules. */
export class InMemoryEvaluationRepository implements EvaluationRepositoryInterface {
  private readonly rows = new Map<string, Evaluation>();

  async create(evaluation: Evaluation) {
    if (this.rows.has(evaluation.evaluationId)) throw new EvaluationRepositoryException();
    this.rows.set(evaluation.evaluationId, cloneEvaluation(evaluation));
    return cloneEvaluation(evaluation);
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? cloneEvaluation(row) : null;
  }
  findByBidId(bidId: string, query?: EvaluationQueryInput) { return this.list((e) => e.bidId === bidId, query); }
  findByTenderId(tenderId: string, query?: EvaluationQueryInput) { return this.list((e) => e.tenderId === tenderId, query); }
  findByEvaluatorId(evaluatorId: string, query?: EvaluationQueryInput) { return this.list((e) => e.evaluatorId === evaluatorId, query); }
  findCompletedByTenderId(tenderId: string, query?: EvaluationQueryInput) {
    return this.list((e) => e.tenderId === tenderId && e.evaluationStatus === "Completed", query);
  }
  async update(evaluation: Evaluation, condition: EvaluationWriteCondition = {}) {
    const stored = this.rows.get(evaluation.evaluationId);
    if (!stored) throw new EvaluationNotFoundException();
    assertWritable(stored, condition);
    this.rows.set(evaluation.evaluationId, cloneEvaluation(evaluation));
    return cloneEvaluation(evaluation);
  }
  async updateStatus(id: string, status: EvaluationStatus, condition: EvaluationWriteCondition = {}) {
    const stored = this.rows.get(id);
    if (!stored) throw new EvaluationNotFoundException();
    const next = applyEvaluationStatusChange(stored, status, condition);
    this.rows.set(id, next);
    return cloneEvaluation(next);
  }
  private async list(predicate: (e: Evaluation) => boolean, input?: EvaluationQueryInput) {
    const { limit, skip } = normalizeEvaluationQuery(input);
    return [...this.rows.values()]
      .filter(predicate)
      .sort((a, b) => b.evaluationDate.getTime() - a.evaluationDate.getTime() || a.evaluationId.localeCompare(b.evaluationId))
      .slice(skip, skip + limit)
      .map(cloneEvaluation);
  }
}
