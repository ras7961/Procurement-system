import type { Container } from "@/infrastructure/container";

/**
 * The route handlers read the composition root from globalThis (see getContainer() in
 * src/infrastructure/container.ts). API tests put their own container there, so the real route
 * handlers run against a controlled setup and never against production data.
 */
const CONTAINER_KEY = Symbol.for("procurement-system.container");

export function installContainer(container: Pick<Container, "authenticationController"> | Container): void {
  (globalThis as unknown as Record<symbol, unknown>)[CONTAINER_KEY] = container;
}

export function uninstallContainer(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[CONTAINER_KEY];
}
