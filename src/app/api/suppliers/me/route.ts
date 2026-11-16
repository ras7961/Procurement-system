import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** GET /api/suppliers/me — the signed-in Supplier's own profile */
export function GET(request: Request) {
  return getContainer().supplierController.getOwnSupplier(request);
}
