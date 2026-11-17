import type { ComplianceStatus } from "@/entities/Bid";
import { Evaluation, type EvaluationFinalResult, type EvaluationStatus } from "@/entities/Evaluation";
import { EvaluationRepositoryException } from "@/entities/exceptions";
import { describeDriverError } from "./mongoErrors";
import { toDomainDate, toDomainId } from "./userDocumentMapper";

/** How an evaluation is stored in the "evaluations" collection. `_id` holds the domain evaluationId. */
export interface EvaluationDocument {
  _id: string;
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

export type StoredEvaluationDocument = Omit<EvaluationDocument, "_id" | "evaluationDate"> & { _id: unknown; evaluationDate: Date | string | number };

export function toEvaluationDocument(evaluation: Evaluation): EvaluationDocument {
  const { evaluationId, evaluationDate, ...rest } = evaluation.toJSON();
  return { _id: evaluationId, ...rest, evaluationDate: new Date(evaluationDate) };
}

/** A corrupt stored document is a storage problem and never echoes its content. */
export function toEvaluation(document: StoredEvaluationDocument): Evaluation {
  try {
    const { _id, evaluationDate, ...rest } = document;
    return Evaluation.restore({ ...rest, evaluationId: toDomainId(_id), evaluationDate: toDomainDate(evaluationDate) });
  } catch (error) {
    throw new EvaluationRepositoryException({ cause: error, details: { reason: "stored evaluation document is invalid", ...describeDriverError(error) } });
  }
}
