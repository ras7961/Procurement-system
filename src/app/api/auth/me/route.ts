import { getContainer } from "@/infrastructure/container";

// Authentication responses depend on the request and must never be cached or prerendered.
export const dynamic = "force-dynamic";

/** Thin route handler: hand the request to the controller and return its response. */
export function GET(request: Request) {
  return getContainer().authenticationController.getCurrentUser(request);
}
