/**
 * The session cookie: how the JWT travels between server and browser.
 *
 * The token is only ever placed in this HttpOnly cookie. JavaScript in the page cannot read it,
 * it is never in a JSON body, and the application never stores it in localStorage or sessionStorage.
 *
 *   HttpOnly   scripts cannot read the cookie (limits the damage of an XSS bug)
 *   Secure     sent over HTTPS only (on in production)
 *   SameSite=Lax  not sent on cross-site POSTs, a first layer of CSRF defence (the Origin check is the second)
 *   Path=/     sent to every API route
 *   Max-Age    set from the token's own expiry, so the cookie never outlives the JWT
 *
 * Plain functions on strings: no framework is imported.
 */

export const SESSION_COOKIE_NAME = "procurement_session";

export interface SessionCookieSettings {
  name: string;
  /** True in production. Browsers refuse to store a Secure cookie that arrives over plain HTTP, except on localhost. */
  secure: boolean;
}

const MAX_COOKIE_HEADER_LENGTH = 8192;

function attributes(settings: SessionCookieSettings): string[] {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (settings.secure) parts.push("Secure");
  return parts;
}

/** The Set-Cookie value that starts a session. Max-Age is rounded down so the cookie ends no later than the token. */
export function buildSessionCookie(settings: SessionCookieSettings, token: string, expiresAt: Date, now: Date): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return [`${settings.name}=${token}`, `Max-Age=${maxAgeSeconds}`, ...attributes(settings)].join("; ");
}

/** The Set-Cookie value that removes the session. It repeats the same attributes, so the browser matches the original cookie. */
export function buildClearedSessionCookie(settings: SessionCookieSettings): string {
  return [`${settings.name}=`, "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", ...attributes(settings)].join("; ");
}

/** Returns the session token from the request's Cookie header, or undefined when there is none. */
export function readSessionToken(request: Request, cookieName: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null || header.length > MAX_COOKIE_HEADER_LENGTH) return undefined;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== cookieName) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}
