import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/evaluations?tenderId=... — a tender's evaluations (read-only; Administrator, or the owning Broker, once the tender has closed) */
export function GET(request: Request) {
  return getContainer().evaluationController.getTenderEvaluations(request);
}
