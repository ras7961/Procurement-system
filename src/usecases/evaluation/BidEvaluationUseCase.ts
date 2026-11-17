import { normalizeEvaluationQuery, type Evaluation } from "@/entities/Evaluation";
import { EvaluationNotFoundException, InvalidEvaluationScoreException, InvalidTenderStatusException, TenderNotFoundException, UnauthorizedAccessException } from "@/entities/exceptions";
import type { Tender } from "@/entities/Tender";
import type { EvaluationRepositoryInterface } from "@/interfaces/repositories/EvaluationRepositoryInterface";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import type { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";

/**
 * ODD: usecases.BidEvaluationUseCase (SRS UC-06), READ OPERATIONS ONLY: getEvaluation and getTenderEvaluations.
 *
 * WHY NO WRITE OPERATIONS (createEvaluation, submitScores, completeEvaluation): in the approved matrix `evaluation:manage` belongs
 * to the Evaluation Committee alone ("restricted" to ASSIGNED tenders), and no committee-to-tender assignment model is documented.
 * Brokers and Administrators must not change scores. Scores have no documented range, weights or total formula, and the approval
 * workflow is undefined. Nothing is guessed: the entity (Evaluation) holds the documented rules, and these writes are added once
 * the assignment mechanism is decided. AI never decides an evaluation or an award.
 *
 * Reading (permission `evaluation:read`): Administrator reads any tender's evaluations; a Procurement Broker only those of tenders
 * they own (another broker's tender looks like "not found"); Suppliers (no documented rule) and the Evaluation Committee (no
 * assignment model) are denied. Evaluations stay sealed like bids: only when the tender is Closed or Awarded.
 */
export interface EvaluationListInput {
  actingUserId: string;
  tenderId: string;
  limit?: number;
  skip?: number;
}

export type EvaluationDto = ReturnType<Evaluation["toJSON"]>;

const UNSEALED = ["Closed", "Awarded"] as const;

export class BidEvaluationUseCase {
  constructor(
    private readonly authorization: AuthorizeUseCase,
    private readonly evaluations: EvaluationRepositoryInterface,
    private readonly tenders: TenderRepositoryInterface,
  ) {}

  /** ODD EvaluationController.getEvaluation(id). */
  async getEvaluation(input: { actingUserId: string; evaluationId: string }): Promise<EvaluationDto> {
    const caller = await this.authorize(input?.actingUserId);
    if (typeof input.evaluationId !== "string" || input.evaluationId.trim() === "") throw new EvaluationNotFoundException();
    const evaluation = await this.evaluations.findById(input.evaluationId);
    if (evaluation === null) throw new EvaluationNotFoundException();
    const tender = await this.tenders.findById(evaluation.tenderId);
    if (tender === null || !mayRead(caller, tender)) throw new EvaluationNotFoundException();
    assertUnsealed(tender, "read evaluation");
    return evaluation.toJSON();
  }

  /** ODD EvaluationController.getTenderEvaluations(tenderId). Newest first. */
  async getTenderEvaluations(input: EvaluationListInput): Promise<{ evaluations: EvaluationDto[]; limit: number; skip: number }> {
    const caller = await this.authorize(input?.actingUserId);
    if (typeof input.tenderId !== "string" || !/^\S+$/.test(input.tenderId)) throw new InvalidEvaluationScoreException(["tenderId is required"]);
    const query = normalizeEvaluationQuery({ limit: input.limit, skip: input.skip });
    const tender = await this.tenders.findById(input.tenderId);
    if (tender === null || !mayRead(caller, tender)) throw new TenderNotFoundException();
    assertUnsealed(tender, "list evaluations");
    const found = await this.evaluations.findByTenderId(input.tenderId, query);
    return { evaluations: found.map((evaluation) => evaluation.toJSON()), ...query };
  }

  private async authorize(actingUserId: string): Promise<{ userId: string; roleName: string }> {
    const granted = await this.authorization.execute({ userId: actingUserId, permission: "evaluation:read" });
    const { userId, roleName } = granted.user;
    if (roleName === "Administrator" || roleName === "Procurement Broker") return { userId, roleName };
    throw new UnauthorizedAccessException(); // Supplier and Evaluation Committee: fail closed
  }
}

function mayRead(caller: { userId: string; roleName: string }, tender: Tender): boolean {
  return caller.roleName === "Administrator" || (caller.roleName === "Procurement Broker" && tender.brokerId === caller.userId);
}

function assertUnsealed(tender: Tender, operation: string): void {
  if (!(UNSEALED as readonly string[]).includes(tender.status)) throw new InvalidTenderStatusException(tender.status, operation);
}
