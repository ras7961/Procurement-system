# Procurement System

AI-Assisted Broker-Centric Procurement Evaluation and Contract Administration System for Public Organizations.

**Status: Stage 1F, role seeding and authorization.** The foundation (Stage 0), user and role entities (1A), MongoDB repositories and Argon2id hashing (1B), authentication use cases (1C), JWT with persistent revocation (1D) the HTTP authentication endpoints (1E) and role seeding with permission-based authorization (1F) exist. Tender, supplier, bid, evaluation, contract and AI features are added stage by stage, following the SRS, SDD and ODD. No route is protected by a permission yet because no feature routes exist; the reusable guard is ready for them. Tender assignments and record ownership checks wait for the Tender, Bid and Supplier modules.

## Stack

Next.js (App Router) + React + TypeScript, MongoDB, Ollama (added in a later stage), Vitest, ESLint.

## Getting started

Requires Node.js 20.9 or newer (developed on Node 22) and a MongoDB server (local or Atlas).

```bash
npm install
cp .env.example .env.local     # then set MONGODB_URI (and MONGODB_DB_NAME if you like)
npm run dev                    # http://localhost:3000
```

Check the foundation: open <http://localhost:3000/api/health>. It returns `200` when the configuration is valid and MongoDB is reachable, and `503` otherwise. The response never contains secrets or connection strings.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGODB_URI` | yes | none | MongoDB connection string (`mongodb://` or `mongodb+srv://`) |
| `MONGODB_DB_NAME` | yes | none | Database name |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | no | `5000` | How long to wait for MongoDB before failing |
| `APP_ORIGIN` | **in production** | `http://localhost:3000` | The application's own origin (scheme, host, optional port; no path, no trailing slash). POST requests are accepted only from this origin (CSRF protection) |
| `JWT_SECRET` | **in production** | random per process | HS256 signing secret, at least 32 random characters |
| `JWT_ISSUER` / `JWT_AUDIENCE` | no | `procurement-system` / `procurement-system-api` | Token issuer and audience |
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | no | `900` | Session lifetime, 60 to 3600 |
| `LOG_LEVEL` | no | `info` | `info`, `warn` or `error` |
| `NODE_ENV` | no | `development` | Set by Next.js |

## Authentication API (Stage 1E)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Public supplier registration. Always creates a **Pending** Supplier; role, status and permissions cannot be sent |
| POST | `/api/auth/login` | Sets the `procurement_session` cookie (HttpOnly, SameSite=Lax, Secure in production). The token is never in the JSON |
| POST | `/api/auth/logout` | Revokes the token and clears the cookie. Idempotent |
| GET | `/api/auth/me` | The current user, read from the database |

Every response is JSON (`{ success, data, message }` or `{ success: false, error: { code, message } }`) with `Cache-Control: no-store`. Every POST must come from `APP_ORIGIN` (an `Origin` header, or a `Referer` as fallback) and must send `Content-Type: application/json`; command-line clients therefore need `-H "Origin: <APP_ORIGIN>"`. There is no CORS support. Administrator account creation is not exposed over HTTP yet.

## Roles and authorization (Stage 1F)

**Seed the four roles** (Administrator, Procurement Broker, Supplier, Evaluation Committee) once per database, before anyone registers:

```bash
npm run seed:roles
```

It reads `MONGODB_URI` and `MONGODB_DB_NAME` from the environment, or from `.env.local` / `.env`. It is safe to repeat: missing roles are created from the approved matrix (`RolePermissionMatrix.ts`); an existing role is never changed, and if its permissions differ from the matrix it is reported as "Customized (kept as stored)". It creates **no users and no administrator account**. Exit code 1 means a conflict or a database problem.

**Protect a future route.** The controller calls the guard first, inside its normal try/catch:

```ts
const { user, requiresScopeCheck } = await this.guard.require(request, "tender:create");
```

`guard` is `getContainer().authorizationGuard` (an `AuthorizationGuard`). It authenticates the session, then reads the user and the role from MongoDB and checks that the role holds the permission. The role in the token is never used, so a suspended, deleted or re-roled user loses access on the next request. Failures are 401 `AUTHENTICATION_REQUIRED`, 403 `ACCOUNT_INACTIVE` and 403 `UNAUTHORIZED_ACCESS`; if permission data cannot be read the request fails with a generic 5xx and nothing is granted. When `requiresScopeCheck` is true (Suppliers' own records, Evaluation Committee members' assigned tenders) the module's use case must still check ownership or assignment; general RBAC does not.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Run, build and serve the app |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | ESLint (includes layer import restrictions) |
| `npm test` | All automated tests |
| `npm run test:architecture` | Only the dependency-rule checks |
| `npm run verify` | typecheck + lint + tests |
| `npm run seed:roles` | Create the four approved roles (idempotent, creates no users) |

### Testing against a real MongoDB

`tests/integration/mongodb-connection.test.ts` runs the real-database tests when it can reach a MongoDB. Otherwise they are reported as **skipped** (never as passed).

```bash
MONGODB_TEST_URI="mongodb://127.0.0.1:27017" npm test
```

`tests/integration/auth-api.test.ts` runs the full authentication API scenarios (the same ones as `tests/unit/auth-api.test.ts`) against a real MongoDB, and the token revocation tests use the same targets. The TTL-cleanup test runs only on the in-memory server (it runs MongoDB with a 1-second TTL monitor) and is skipped with `MONGODB_TEST_URI`.

Without `MONGODB_TEST_URI`, it tries to start an in-memory MongoDB, which downloads a `mongod` binary on first use (set `MONGOMS_SYSTEM_BINARY` to use a local `mongod` instead). The repository integration tests use a throw-away database with a random name and drop only that database. If no MongoDB is available they are reported as skipped.

## Architecture

Clean Architecture as documented in the SDD, with the packages named in the ODD. Dependencies point inward only.

```
Frameworks & Drivers   infrastructure/, app/ (Next.js), presentation/
Interface Adapters     controllers/, repositories/, services/
Use Cases              usecases/, interfaces/ (ports)
Entities               entities/
                       shared/ (plain types and pure helpers, importable by every layer)
```

The rules are enforced two ways: ESLint restrictions for fast feedback while editing, and `tests/architecture/dependency-rule.test.ts`, which analyses every import in `src/` (including relative ones). See the README in each `src/` folder for what belongs there.

`src/infrastructure/container.ts` is the composition root, the only file allowed to know every layer. Route handlers in `src/app/api` stay thin: they call a controller obtained from the container and return its result.
