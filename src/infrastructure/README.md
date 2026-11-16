# infrastructure (Frameworks & Drivers)

Technical configuration and implementations (ODD package `infrastructure`).

| Folder / file | Purpose | Status |
|---|---|---|
| `configuration/` | `EnvironmentConfiguration`: validated environment variables | Stage 0 |
| `logging/` | `LoggingAndDeploymentConfiguration`: structured, secret-redacting logs | Stage 0 |
| `database/` | `MongoDBConnection`: the only code that talks to MongoDB | Stage 0 |
| `storage/` | `FileStorageConfiguration` and file storage | later stage |
| `ai/` | `AIModelConfiguration` (Ollama) | later stage |
| `email/` | `EmailConfiguration` | later stage |
| `container.ts` | Composition root | Stage 0 |

**Rules**
- Only `database/` (and `repositories/`) may import the `mongodb` package.
- Everything here except `container.ts` may import only from `entities`, `interfaces` and `shared`.
- `container.ts` is the only file allowed to import every layer. It creates the concrete classes and wires them together.
- Never hard-code secrets. Read them through `EnvironmentConfiguration`.
