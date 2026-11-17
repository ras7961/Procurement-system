import type { Bid, ComplianceStatus } from "./Bid";
import { COMPLIANCE_STATUSES } from "./Bid";
import {
  BidNotEligibleForEvaluationException,
  EvaluationAlreadyCompletedException,
  IncompleteEvaluationException,
  InvalidEvaluationScoreException,
} from "./exceptions";

/**
 * ODD: entities.Evaluation (SRS: Bid Evaluation, UC-06).
 *
 * WHAT IS IMPLEMENTED (only what the ODD names): createEvaluation, assessTechnicalProposal, assessFinancialProposal,
 * checkCompliance, addComments, completeEvaluation, getEvaluationDetails (toJSON).
 *
 * WHAT IS DELIBERATELY NOT IMPLEMENTED, because the documents do not define it (see the stage report):
 *   - calculateTotalScore: no weights or formula are documented, so `totalScore` is stored but never computed (null).
 *   - recordFinalResult and the "Approved" status: no approval workflow or approver role is documented.
 *   - A maximum score: the ODD says only "outside the permitted range" without giving it; scores must be finite and >= 0.
 *
 * Assumptions to confirm: statuses move Pending -> In Progress (first assessment/comment/compliance) -> Completed; a Completed
 * evaluation is final; complianceResult uses the same Compliant / NonCompliant values as Bid.complianceStatus; `tenderId` is
 * copied from the bid at creation (the ODD's findCompletedByTenderId needs it) and is never client-supplied.
 *
 * A withdrawn bid is never evaluated: createEvaluation uses the existing Bid.isEligibleForEvaluation() rule.
 */
export const EVALUATION_STATUSES = ["Pending", "In Progress", "Completed", "Approved"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
export const EVALUATION_FINAL_RESULTS = ["Qualified", "Disqualified", "Recommended"] as const;
export type EvaluationFinalResult = (typeof EVALUATION_FINAL_RESULTS)[number];

export const EVALUATION_COMMENTS_MAX_LENGTH = 2000;
export const MAX_EVALUATION_PAGE_SIZE = 500;

export interface EvaluationProps {
  evaluationId: string;
  bidId: string;
  tenderId: string;
  evaluatorId: string;
  technicalScore: number | null;
  financialScore: number | null;
  totalScore: number | null;
  comments: string;
  complianceResult: ComplianceStatus | null;
  evaluationDate: Date;
  evaluationStatus: EvaluationStatus;
  finalResult: EvaluationFinalResult | null;
}

const isScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

export class Evaluation {
  #props: EvaluationProps;

  private constructor(props: EvaluationProps) {
    this.#props = props;
  }

  /** ODD createEvaluation(): a Pending evaluation for an eligible bid. The tender comes from the stored bid, the evaluator from the session. */
  static create(input: { evaluationId: string; bid: Bid; evaluatorId: string; now: Date }): Evaluation {
    if (!input.bid.isEligibleForEvaluation()) throw new BidNotEligibleForEvaluationException();
    return Evaluation.restore({
      evaluationId: input.evaluationId,
      bidId: input.bid.bidId,
      tenderId: input.bid.tenderId,
      evaluatorId: input.evaluatorId,
      technicalScore: null,
      financialScore: null,
      totalScore: null,
      comments: "",
      complianceResult: null,
      evaluationDate: input.now,
      evaluationStatus: "Pending",
      finalResult: null,
    });
  }

  /** Rebuilds a stored evaluation, validating every field. */
  static restore(props: EvaluationProps): Evaluation {
    const issues: string[] = [];
    for (const key of ["evaluationId", "bidId", "tenderId", "evaluatorId"] as const) {
      if (typeof props[key] !== "string" || props[key].trim() === "") issues.push(`${key} is required`);
    }
    for (const key of ["technicalScore", "financialScore", "totalScore"] as const) {
      if (props[key] !== null && !isScore(props[key])) issues.push(`${key} must be a number of 0 or more`);
    }
    if (typeof props.comments !== "string" || props.comments.length > EVALUATION_COMMENTS_MAX_LENGTH) issues.push(`comments must be at most ${EVALUATION_COMMENTS_MAX_LENGTH} characters`);
    if (props.complianceResult !== null && !isOneOf(COMPLIANCE_STATUSES, props.complianceResult)) issues.push("complianceResult is invalid");
    if (!(props.evaluationDate instanceof Date) || Number.isNaN(props.evaluationDate.getTime())) issues.push("evaluationDate is invalid");
    if (!isOneOf(EVALUATION_STATUSES, props.evaluationStatus)) issues.push("evaluationStatus is invalid");
    if (props.finalResult !== null && !isOneOf(EVALUATION_FINAL_RESULTS, props.finalResult)) issues.push("finalResult is invalid");
    if (issues.length > 0) throw new InvalidEvaluationScoreException(issues);
    return new Evaluation({ ...props, evaluationDate: new Date(props.evaluationDate.getTime()) });
  }

  get evaluationId() { return this.#props.evaluationId; }
  get bidId() { return this.#props.bidId; }
  get tenderId() { return this.#props.tenderId; }
  get evaluatorId() { return this.#props.evaluatorId; }
  get technicalScore() { return this.#props.technicalScore; }
  get financialScore() { return this.#props.financialScore; }
  get totalScore() { return this.#props.totalScore; }
  get comments() { return this.#props.comments; }
  get complianceResult() { return this.#props.complianceResult; }
  get evaluationDate() { return new Date(this.#props.evaluationDate.getTime()); }
  get evaluationStatus() { return this.#props.evaluationStatus; }
  get finalResult() { return this.#props.finalResult; }

  /** ODD assessTechnicalProposal(). */
  assessTechnicalProposal(score: number): void {
    this.#assertOpen();
    if (!isScore(score)) throw new InvalidEvaluationScoreException(["technicalScore must be a number of 0 or more"]);
    this.#props = { ...this.#props, technicalScore: score, evaluationStatus: "In Progress" };
  }

  /** ODD assessFinancialProposal(). */
  assessFinancialProposal(score: number): void {
    this.#assertOpen();
    if (!isScore(score)) throw new InvalidEvaluationScoreException(["financialScore must be a number of 0 or more"]);
    this.#props = { ...this.#props, financialScore: score, evaluationStatus: "In Progress" };
  }

  /** ODD checkCompliance(): records the evaluator's compliance result (a human decision; nothing is computed). */
  checkCompliance(result: ComplianceStatus): void {
    this.#assertOpen();
    if (!isOneOf(COMPLIANCE_STATUSES, result)) throw new InvalidEvaluationScoreException([`complianceResult must be one of: ${COMPLIANCE_STATUSES.join(", ")}`]);
    this.#props = { ...this.#props, complianceResult: result, evaluationStatus: "In Progress" };
  }

  /** ODD addComments(). */
  addComments(comments: string): void {
    this.#assertOpen();
    if (typeof comments !== "string" || comments.length > EVALUATION_COMMENTS_MAX_LENGTH) {
      throw new InvalidEvaluationScoreException([`comments must be at most ${EVALUATION_COMMENTS_MAX_LENGTH} characters`]);
    }
    this.#props = { ...this.#props, comments, evaluationStatus: "In Progress" };
  }

  /** ODD completeEvaluation(): both scores and the compliance result must be recorded. */
  complete(): void {
    this.#assertOpen();
    const missing: string[] = [];
    if (this.#props.technicalScore === null) missing.push("technicalScore");
    if (this.#props.financialScore === null) missing.push("financialScore");
    if (this.#props.complianceResult === null) missing.push("complianceResult");
    if (missing.length > 0) throw new IncompleteEvaluationException(missing);
    this.#props = { ...this.#props, evaluationStatus: "Completed" };
  }

  /** ODD getEvaluationDetails(): plain data with an ISO date. The only representation handed to other layers. */
  toJSON() {
    return { ...this.#props, evaluationDate: this.#props.evaluationDate.toISOString() };
  }

  #assertOpen(): void {
    if (this.#props.evaluationStatus === "Completed" || this.#props.evaluationStatus === "Approved") throw new EvaluationAlreadyCompletedException();
  }
}

export interface EvaluationQueryInput {
  limit?: number;
  skip?: number;
}
export function normalizeEvaluationQuery(input: EvaluationQueryInput = {}): { limit: number; skip: number } {
  const limit = input.limit ?? 100;
  const skip = input.skip ?? 0;
  const issues: string[] = [];
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVALUATION_PAGE_SIZE) issues.push(`limit must be a whole number from 1 to ${MAX_EVALUATION_PAGE_SIZE}`);
  if (!Number.isInteger(skip) || skip < 0) issues.push("skip must be a whole number of 0 or more");
  if (issues.length > 0) throw new InvalidEvaluationScoreException(issues);
  return { limit, skip };
}
