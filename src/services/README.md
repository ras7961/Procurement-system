# services (Interface Adapters)

Adapters that implement service interfaces using external technology (ODD package `services`): `AIServiceAdapter` (Ollama), `DocumentService`, `NotificationService`, `AuthenticationService`. Implemented so far: `JwtTokenService` (Stage 1D, implements `TokenServiceInterface`: HS256 JWTs through `jose`, verification checks algorithm, signature, issuer, audience, required claims, expiry and then the revocation store; only this folder may import `jose`); `SystemHealthProbeAdapter` (Stage 0) and `Argon2PasswordService` (Stage 1B, implements `PasswordServiceInterface`, Argon2id with the library defaults; `verify` returns false for wrong passwords and malformed hashes). Only this folder may import the `argon2` package.

**Rules**
- Implement an interface from `src/interfaces`.
- May use configuration and clients from `infrastructure`.
- Never import Next.js or React, and never use the MongoDB driver directly (go through repositories).
- The AI adapter is the only place that talks to Ollama, so the model can be replaced without touching use cases.
