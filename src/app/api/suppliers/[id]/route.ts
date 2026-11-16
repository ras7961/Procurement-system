import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/suppliers/[id] — get one supplier profile */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().supplierController.getSupplier(request, id));
}

/** PATCH /api/suppliers/[id] — update a supplier profile */
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().supplierController.updateSupplier(request, id));
}
