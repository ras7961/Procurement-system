import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/tenders/[id] — get one tender */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().tenderController.getTender(request, id));
}

/** PATCH /api/tenders/[id] — update a tender */
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().tenderController.updateTender(request, id));
}

/** DELETE /api/tenders/[id] — delete a draft tender */
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().tenderController.deleteDraftTender(request, id));
}
