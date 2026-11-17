import type { BidEvaluationUseCase } from "@/usecases/evaluation/BidEvaluationUseCase";
import { errorResponse, successResponse } from "./apiResponse";
import type { AuthorizationGuard } from "./AuthorizationGuard";
import { parseListEvaluationsRequest } from "./evaluationRequests";
import type { TenderControllerOptions } from "./TenderController";

/**
 * controllers.EvaluationController (ODD): READ endpoints only (getEvaluation, getTenderEvaluations). The write operations
 * (createEvaluation, submitScores, completeEvaluation) are not exposed: see BidEvaluationUseCase for why. The user id comes from
 * the authenticated session; no identity, role or scoring value is read from the client.
 */
export class EvaluationController {
  constructor(
    private readonly evaluation: BidEvaluationUseCase,
    private readonly guard: AuthorizationGuard,
    private readonly options: TenderControllerOptions,
  ) {}

  /** GET /api/evaluations?tenderId=... */
  async getTenderEvaluations(request: Request): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, ["evaluation:read"]);
      const input = parseListEvaluationsRequest(new URL(request.url).searchParams, caller.user.userId);
      return successResponse(200, await this.evaluation.getTenderEvaluations(input), "Evaluations retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getTenderEvaluations");
    }
  }

  /** GET /api/evaluations/[id] */
  async getEvaluation(request: Request, evaluationId: string): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, ["evaluation:read"]);
      const evaluation = await this.evaluation.getEvaluation({ actingUserId: caller.user.userId, evaluationId });
      return successResponse(200, { evaluation }, "Evaluation retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getEvaluation");
    }
  }
}
