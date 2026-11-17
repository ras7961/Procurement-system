import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/bids — submit a bid (Supplier) */
export function POST(request: Request) {
  return getContainer().bidController.submitBid(request);
}

/** GET /api/bids — a Supplier's own bids, or (staff, with ?tenderId=) the bids of a closed tender */
export function GET(request: Request) {
  return getContainer().bidController.listBids(request);
}
