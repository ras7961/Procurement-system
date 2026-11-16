import { createInMemoryWorld } from "../support/inMemoryAuthApiWorld";
import { defineAuthApiScenarios } from "../support/authApiScenarios";

// The real route handlers, controller, use cases and JwtTokenService, with in-memory storage.
// The identical scenarios run against a real MongoDB in tests/integration/auth-api.test.ts.
defineAuthApiScenarios("Authentication API (in-memory storage)", async () => createInMemoryWorld().world);
