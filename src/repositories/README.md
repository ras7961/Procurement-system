# repositories (Interface Adapters)

Concrete MongoDB implementations of the repository interfaces (ODD package `repositories`), such as `MongoUserRepository implements UserRepositoryInterface`.

**Rules**
- Each class implements an interface from `src/interfaces/repositories` (checked by the architecture test once files exist).
- Obtain the database from `MongoDBConnection.getDatabase()`. Never create a MongoClient here.
- Map stored documents to entities and back; do not leak MongoDB types (`ObjectId`, `Document`) out of this folder.
- May import from `entities`, `interfaces`, `shared`, `infrastructure` and the `mongodb` package.

**Implemented (Stage 1B)**
- `MongoUserRepository` (collection `users`) and `MongoRoleRepository` (collection `roles`), both sharing the one `MongoDBConnection`.
- `_id` holds the domain id as a string (the application creates ids). An `ObjectId` `_id` is converted to its hex string at the boundary. Dates are stored as BSON `Date`.
- Indexes, created lazily on first use and safe to repeat: `users.email_unique_ci` (unique, collation `en` strength 2; emails are also stored lowercase) and `roles.roleName_unique`.
- Errors: duplicate key becomes `DuplicateEmailException` / `DuplicateRoleException`; other driver errors become `UserRepositoryException` / `DatabaseOperationException` (the raw error is kept only as `cause`); connection errors pass through.
- `update()` never changes `userId` or `createdAt`. `update`/`updateStatus` do not check status transitions: use cases change status through `User` methods.
- `MongoRevokedTokenRepository` (Stage 1D, collection `revoked_tokens`): `_id` is the token `jti`, with `expiresAt` and `revokedAt` as BSON dates. Revocation is an upsert, so it is idempotent. TTL index `expiresAt_ttl` (`expireAfterSeconds: 0`) lets MongoDB delete records after the token would have expired anyway (MongoDB's TTL task runs about once a minute). Raw tokens are never stored.
- `userDocumentMapper.ts`, `roleDocumentMapper.ts` and `mongoErrors.ts` are helpers; no repository seeds data.

**Implemented (Stage 2A)**
- `MongoTenderRepository` (collection `tenders`, `tenderDocumentMapper.ts`): `_id` is the tenderId; dates are BSON `Date`; `publicationDate` is `null` for a Draft. Indexes `tenders.status_submissionDeadline` and `tenders.brokerId_createdAt`, created lazily and safe to repeat.
- `update()`, `updateStatus()` and `delete()` apply the shared rules of `interfaces/repositories/tenderRepositoryRules.ts` and write **conditionally on the status that was read**, so a concurrent publish, cancel, edit or delete cannot be overwritten (the loser gets `InvalidTenderStatusException` or `TenderNotFoundException`).
- `delete()` removes only a Draft tender; other tenders are kept as records (archiving is not modelled).
- A corrupt stored tender becomes `TenderRepositoryException`; other driver errors become `DatabaseOperationException`.

