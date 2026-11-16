import { getContainer } from "@/infrastructure/container";

// Health must reflect the current state on every request.
export const dynamic = "force-dynamic";

/** Thin route handler: delegate to the controller and return its result. */
export async function GET() {
  const { statusCode, body } = await getContainer().healthController.getHealth();
  return Response.json(body, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}
