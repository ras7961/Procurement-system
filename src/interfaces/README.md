# interfaces (ports)

Contracts that use cases depend on (ODD package `interfaces`). Concrete implementations live in outer layers.

| Folder | Holds (added by later stages) |
|---|---|
| `repositories/` | `UserRepositoryInterface` (ODD) and `RoleRepositoryInterface` (proposed, not in the ODD) exist. `TenderRepositoryInterface` and the other repository contracts named in the ODD are added with their modules |
| `services/` | `AIServiceInterface` and other service contracts. `SystemHealthProbe` (Stage 0), `PasswordServiceInterface` (1B) and `TokenServiceInterface` (1C; implemented by `JwtTokenService` in 1D) and `RevokedTokenRepositoryInterface` (1D, not in the ODD) |
| `storage/` | `DocumentStorageInterface` |
| `notifications/` | `NotificationDeliveryInterface` |

**Rules**
- May import only from `entities` and `shared`. No third-party packages.
- Definitions contain no implementation details of MongoDB, Ollama, the file system or an email provider.
- Concrete classes implement these in `repositories/`, `services/` and `infrastructure/`.

**Added in Stage 2A**: `TenderRepositoryInterface` (ODD operations plus `expectedStatus`/`publicationDate` on `updateStatus` and paging on the list operations) and `tenderRepositoryRules.ts`, pure functions holding the update and status-change rules so every implementation behaves identically.
