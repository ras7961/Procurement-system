# app (Next.js App Router)

Routing files that Next.js requires: `layout.tsx`, `page.tsx`, and API route handlers under `api/`.

**Rules**
- Route handlers are thin: get a controller from `@/infrastructure/container`, call it, return its result (max 40 lines, enforced by the architecture test).
- No business logic and no database access here.
- Page UI is composed from `src/presentation` as it grows.

**Routes**
- `api/health` (Stage 0).
- `api/auth/register`, `login`, `logout` (POST) and `me` (GET) (Stage 1E). Each is a few lines: `export const dynamic = "force-dynamic"` and a call into `getContainer().authenticationController`.
