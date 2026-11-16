# presentation (UI)

React components, page content and layouts (ODD package `presentation`): login and registration, role dashboards, tender and bid forms, evaluation and AI analysis views, contract pages, reports.

- `components/` reusable UI pieces
- `pages/` page-level views composed by the routes in `src/app`
- `layouts/` shared layouts

**Rules**
- Talk to the backend only through API endpoints (`fetch`). Never import use cases, controllers, repositories, services or infrastructure.
- Never import the MongoDB driver or the Ollama client.
- No business rules here. Show what the API returns.
- AI results must be labeled as recommendations for a human reviewer.

Routing files (`page.tsx`, `layout.tsx`, `route.ts`) live in `src/app`, as Next.js requires.
