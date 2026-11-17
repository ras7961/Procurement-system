import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/bids/[id]/withdraw — withdraw an own bid before the submission deadline */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().bidController.withdrawBid(request, id));
}
