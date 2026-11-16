import { ApiRequestException } from "./apiResponse";

/**
 * Request-level protection for the cookie-based session.
 *
 * CSRF strategy (checked on every state-changing request, which here means every POST):
 *  1. The Origin header must equal the configured application origin (APP_ORIGIN) exactly.
 *     Browsers add Origin to every cross-site POST and page scripts cannot change it.
 *  2. If there is no Origin header, the Referer's origin is checked instead.
 *  3. With neither header the request is refused. A browser always sends one of them on a POST,
 *     so a missing header means a non-browser client, which has no ambient cookie to abuse and
 *     can add an Origin header itself.
 *  4. Bodies must be JSON (Content-Type: application/json). A cross-site HTML form cannot send
 *     that type, and a cross-site script that does must first pass a CORS preflight, which these
 *     endpoints never approve (they send no Access-Control-* headers).
 *  Together with the session cookie's SameSite=Lax attribute, a foreign site cannot make the
 *  browser perform a login, logout or registration.
 *
 * GET requests change nothing and are not checked. There is deliberately no CORS support.
 */

export const MAX_BODY_BYTES = 16 * 1024;

const ORIGIN_REJECTED = () => new ApiRequestException("ORIGIN_NOT_ALLOWED", "The request origin is not allowed.", 403);

/** Throws ApiRequestException (403) unless the request comes from the application's own origin. */
export function assertTrustedOrigin(request: Request, allowedOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    // "null" (sandboxed frames, some redirects) and every other value that is not an exact match fail here.
    if (origin === allowedOrigin) return;
    throw ORIGIN_REJECTED();
  }

  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      if (new URL(referer).origin === allowedOrigin) return;
    } catch {
      // An unparseable Referer is the same as a wrong one.
    }
  }
  throw ORIGIN_REJECTED();
}

/** Reads the request body as a JSON object. Throws ApiRequestException (400) for anything else. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new ApiRequestException("INVALID_REQUEST", "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw tooLarge();

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiRequestException("INVALID_REQUEST", "The request body could not be read.");
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw tooLarge();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiRequestException("INVALID_REQUEST", "The request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiRequestException("INVALID_REQUEST", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function tooLarge(): ApiRequestException {
  return new ApiRequestException("INVALID_REQUEST", "The request body is too large.");
}
