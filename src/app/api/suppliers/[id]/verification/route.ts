import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/suppliers/[id]/verification — verify or reject a supplier (Administrator, Procurement Broker) */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => getContainer().supplierController.verifySupplier(request, id));
}
