import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/bids/[id] — get one bid (own bid; staff only after the tender closed) */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().bidController.getBid(request, id));
}

/** PATCH /api/bids/[id] — update an own bid before the submission deadline */
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().bidController.updateBid(request, id));
}
