import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/tenders/[id]/publish */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().tenderController.publishTender(request, id));
}
