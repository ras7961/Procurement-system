import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/evaluations/[id] — one evaluation (read-only) */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().evaluationController.getEvaluation(request, id));
}
