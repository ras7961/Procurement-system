import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/tenders — create a new tender */
export function POST(request: Request) {
  return getContainer().tenderController.createTender(request);
}

/** GET /api/tenders — list / search tenders */
export function GET(request: Request) {
  return getContainer().tenderController.listTenders(request);
}
