# entities (Entities layer)

Core business objects and rules of the procurement domain (ODD package `entities`): User, Role, Tender, Supplier, Bid, Evaluation, Contract, ContractMilestone, SupplierPerformance, ProcurementDocument, AIAnalysis, Notification.

**Rules**
- Pure TypeScript. May import only from `entities` and `shared`.
- Never import Next.js, React, MongoDB, Ollama, zod, use cases, repositories or any outer layer.
- No persistence operations here. Storing and loading belongs to use cases through repository interfaces.

`exceptions/` holds the centralized error structure (`AppError` and its subclasses). Domain exceptions named in the ODD (for example `TenderClosedException`) are added with their modules. An exception's `message` must be safe to show to a user; never put secrets in it.

Implemented so far: `User` and `Role` (Stage 1A); account status `Pending` with guarded transitions (Pending to Active only through `approve()`), and `RolePermissionMatrix.ts`, the approved permission table kept as data (Stage 1B; nothing enforces it yet). `Tender` (Stage 2A): lifecycle Draft, Published, Closed, Awarded, Cancelled with guarded operations (`publish`, `close`, `cancel`, `updateTender`, `addRequirement`, `setEvaluationCriteria`); nothing awards a tender yet. Open points (committee assignment, post-publication edits, evaluation-criteria structure) are listed at the top of `Tender.ts`. Other entity classes are added in the stage that needs them.

Conventions used by the entities:
- Private `#fields` with getters, so state changes only through methods that validate.
- `Entity.create()` / `register()` builds a new object. `Entity.restore()` rebuilds one from stored data (repositories use it). Both validate and collect every problem.
- Operations that need persistence or hashing (`register` saving, `authenticate` password check) belong to use cases and services. The entity only enforces its own rules.
- Secrets never leave an entity through `toJSON()`.
