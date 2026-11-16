# shared

Plain, dependency-free building blocks that every layer may import.

- `types/` plain data shapes (no logic). Currently the health report types.
- `constants/` application-wide constants (none yet).
- `utilities/` small pure functions. Currently `redact.ts`, which keeps secrets out of logs.

**Rules**
- May import only from `shared`. No third-party packages, no framework code.
- Keep it small. If something belongs to one layer, put it in that layer.
