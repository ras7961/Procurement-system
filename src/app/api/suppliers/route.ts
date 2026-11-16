import { getContainer } from "@/infrastructure/container";

export const dynamic = "force-dynamic";

/** POST /api/suppliers — register a supplier profile */
export function POST(request: Request) {
  return getContainer().supplierController.registerSupplier(request);
}

/** GET /api/suppliers — list supplier profiles (Administrator, Procurement Broker) */
export function GET(request: Request) {
  return getContainer().supplierController.listSuppliers(request);
}
