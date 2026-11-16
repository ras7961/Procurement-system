# usecases (Use Case / Application layer)

Application-specific business operations (ODD package `usecases`). Each use case coordinates entities and talks to the outside world only through interfaces.

One folder per module: `authentication`, `user`, `tender`, `supplier`, `bid`, `evaluation`, `ai`, `contract`, `performance`, `reporting`, `document`, `notification`. Classes are named as in the ODD, for example `BidSubmissionUseCase`.

`health/` is a Stage 0 diagnostic (`CheckSystemHealthUseCase`) that verifies the foundation. It is not an ODD business module.

**Rules**
- May import only from `entities`, `interfaces` and `shared`.
- Never import MongoDB, Ollama, Next.js, React, repositories, services, controllers, infrastructure or presentation.
- Role-based authorization is enforced here, using the acting user's role.
- Authentication, tender, supplier and other modules are added in their own stages.

**Implemented (Stage 2B, `tender/`)**
- `TenderManagementUseCase`: create, update, publish, close, cancel, delete (Draft only), get and list tenders. Every call first runs `AuthorizeUseCase` (active user, stored role); close and cancel use `tender:publish`, delete uses `tender:update`, get and list use `tender:read`. Status changes are conditional on the status that was read. Suppliers see Published tenders only; Evaluation Committee reads are refused until assignment exists. Open decisions (broker ownership, published-tender field limits, early closure, committee scope, free-text search) are listed in the class comment. No controller or route uses it yet.

**Implemented (Stage 1F, `authorization/`)**
- `SeedRolesUseCase`: idempotent creation of the four approved roles from the matrix. Existing roles are never modified; differences are reported as `customized`, unreadable or colliding roles as `conflicts`. Creates no users.
- `AuthorizeUseCase`: given a user id and a permission, reads the user (must exist and be Active) and the role from storage and requires the stored role to hold the permission. Token claims are never an input. Storage errors propagate (fail closed). Does not check tender assignments or record ownership; `requiresScopeCheck` flags where a module must.

**Implemented (Stage 1C, `authentication/`)**
- `RegisterSupplierUseCase`: public supplier registration. Role Supplier and status Pending are fixed in the use case; the input has no role or status field.
- `CreateUserAccountUseCase`: an authorized administrator (Active, holds `user:manage`) creates Broker, Supplier or Evaluation Committee accounts, always Active. Administrator accounts are not created here.
- `LoginUseCase`: one generic `InvalidCredentialsException` for every failure; verifies against a dummy Argon2id hash for an unknown email; checks the status only after the password.
- `LogoutUseCase`: revokes the token through `TokenServiceInterface` and returns `clearCredentials: true` for the future HTTP adapter.
- `GetCurrentUserUseCase`: returns a `UserResponseDto` (never `passwordHash`).
- `AuthenticateSessionUseCase` (Stage 1E): turns a session token into the current user. Rejects a missing, invalid, expired or revoked token (`AuthenticationRequiredException`, 401) and an account that is no longer Active (`AccountInactiveException`, 403). The role in the token is ignored; the account is re-read from storage.
- Shared helpers: `dtos.ts`, `passwordPolicy.ts` (8 to 128 characters), `provisionAccount.ts`, `dummyPasswordHash.ts`. Use cases do not log.
- `LoginUseCase` and `LogoutUseCase` are wired in the composition root with `JwtTokenService` (Stage 1D).
- The AI use case may read procurement data and write only `AIAnalysis` records. It must never award a tender, accept a bid or record an evaluation outcome.
