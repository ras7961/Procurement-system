# controllers (Interface Adapters)

Receive requests from route handlers, validate the request structure, call a use case, and return a structured response (ODD package `controllers`). `HealthController` (Stage 0) and `AuthenticationController` (Stage 1E).

**Rules**
- May import only from `entities`, `shared` and `usecases` (and `zod` for request validation).
- No business rules and no database queries here.
- Never import repositories, infrastructure, services, Next.js or React.
- Authenticate the caller here; authorize in the use case.
- Next.js route handlers in `src/app/api/**/route.ts` stay thin and only call a controller from the composition root.

**Implemented (Stage 1F, authorization)**
- `AuthorizationGuard`: `require(request, permission)` = `SessionAuthenticator.authenticate` then `AuthorizeUseCase`. Returns the authorized user and `requiresScopeCheck`; throws 401 / 403 `AppError`s (or the storage error, which becomes a generic 5xx) so the request fails closed. Controllers of protected endpoints call it first.

**Implemented (Stage 1E, authentication)**
- `AuthenticationController`: `register`, `login`, `logout`, `getCurrentUser`. Each takes a standard Web `Request` and returns a standard `Response`, so no framework is imported here. Order of work: Origin check (POST) -> read and validate the JSON body -> use case -> response.
- `SessionAuthenticator`: the reusable helper for protected endpoints. `authenticate(request)` reads the session cookie and returns the current user through `AuthenticateSessionUseCase`, or throws 401 (no valid session) / 403 (account no longer active). It decides identity only; permissions are checked by `AuthorizationGuard`.
- `sessionCookie.ts` (cookie name and attributes), `requestSecurity.ts` (Origin check, JSON body reading), `authenticationRequests.ts` (zod schemas; unknown fields are rejected), `apiResponse.ts` (response envelope, error mapping, `no-store` headers).
- Errors: an `AppError` below HTTP 500 shows its own safe code and message; everything else becomes a generic 500 (or 503) and is logged. Nothing technical or secret is returned.
