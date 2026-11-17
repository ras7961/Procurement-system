import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { Container } from "@/infrastructure/container";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { BidController } from "@/controllers/BidController";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import { AuthenticationController } from "@/controllers/AuthenticationController";
import { JwtTokenService } from "@/services/JwtTokenService";
import { generateId } from "@/shared/utilities/uuid";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { BidSubmissionUseCase } from "@/usecases/bid/BidSubmissionUseCase";
import { InMemoryBidRepository } from "./InMemoryBidRepository";
import { InMemoryRevokedTokenRepository } from "./InMemoryRevokedTokenRepository";
import { InMemoryRoleRepository } from "./InMemoryRoleRepository";
import { InMemorySupplierRepository } from "./InMemorySupplierRepository";
import { InMemoryTenderRepository } from "./InMemoryTenderRepository";
import { InMemoryUserRepository } from "./InMemoryUserRepository";
import { FakePasswordService } from "./authFakes";
import { installContainer, uninstallContainer } from "./authApiTestKit";
import { TENDER_NOW } from "./fixtures";

export const APP_ORIGIN = "https://procurement.example.org";

/** In-memory world for the bid API tests: real auth, guard, controller and use cases; the clock is controllable. */
export async function createInMemoryBidApiWorld() {
  const jwt = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api" };
  const settings: JwtSettings = { ...jwt, accessTokenTtlSeconds: 900, secretSource: "environment" };

  const users = new InMemoryUserRepository();
  const roles = new InMemoryRoleRepository();
  const suppliers = new InMemorySupplierRepository();
  const tenders = new InMemoryTenderRepository();
  const bids = new InMemoryBidRepository();
  const passwords = new FakePasswordService();
  const revoked = new InMemoryRevokedTokenRepository();
  const loggedErrors: unknown[] = [];
  const clock = { now: TENDER_NOW };

  await new SeedRolesUseCase(roles).execute();

  const tokenService = new JwtTokenService(() => settings, revoked);
  const cookie = { name: SESSION_COOKIE_NAME, secure: true };
  const allowedOrigin = () => APP_ORIGIN;
  const logger = { logError: (_message: string, error?: unknown) => void loggedErrors.push(error) };
  const sessionAuthenticator = new SessionAuthenticator(new AuthenticateSessionUseCase(tokenService, new GetCurrentUserUseCase(users, roles)), cookie);
  const authorize = new AuthorizeUseCase(users, roles);
  const guard = new AuthorizationGuard(sessionAuthenticator, authorize);

  const bidSubmission = new BidSubmissionUseCase(authorize, bids, tenders, suppliers, () => clock.now);
  const bidController = new BidController(bidSubmission, guard, { allowedOrigin, logger });
  const authenticationController = new AuthenticationController(
    new RegisterSupplierUseCase(users, roles, passwords),
    new LoginUseCase(users, roles, passwords, tokenService),
    new LogoutUseCase(tokenService),
    sessionAuthenticator,
    { cookie, allowedOrigin, logger },
  );

  installContainer({ authenticationController, bidController } as unknown as Container);

  return { users, roles, suppliers, tenders, bids, passwords, clock, loggedErrors, dispose: () => uninstallContainer() };
}
