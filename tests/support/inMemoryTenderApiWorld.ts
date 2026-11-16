import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { Container } from "@/infrastructure/container";
import { AuthenticationController } from "@/controllers/AuthenticationController";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import { TenderController } from "@/controllers/TenderController";
import { JwtTokenService } from "@/services/JwtTokenService";
import { generateId } from "@/shared/utilities/uuid";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { TenderManagementUseCase } from "@/usecases/tender/TenderManagementUseCase";
import { InMemoryRevokedTokenRepository } from "./InMemoryRevokedTokenRepository";
import { InMemoryRoleRepository } from "./InMemoryRoleRepository";
import { InMemoryTenderRepository } from "./InMemoryTenderRepository";
import { InMemoryUserRepository } from "./InMemoryUserRepository";
import { FakePasswordService } from "./authFakes";
import { installContainer, uninstallContainer } from "./authApiTestKit";

export const APP_ORIGIN = "https://procurement.example.org";

/** Full in-memory world for the tender API tests: auth + tender stack with all real use cases. */
export async function createInMemoryTenderApiWorld() {
  const jwt = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api" };
  const settings: JwtSettings = { ...jwt, accessTokenTtlSeconds: 900, secretSource: "environment" };

  const users = new InMemoryUserRepository();
  const roles = new InMemoryRoleRepository();
  const tenders = new InMemoryTenderRepository();
  const passwords = new FakePasswordService();
  const revoked = new InMemoryRevokedTokenRepository();
  const loggedErrors: unknown[] = [];

  // Seed the four approved roles so authorization works immediately.
  await new SeedRolesUseCase(roles).execute();

  const tokenService = new JwtTokenService(() => settings, revoked);
  const getCurrentUser = new GetCurrentUserUseCase(users, roles);
  const cookie = { name: SESSION_COOKIE_NAME, secure: true };
  const allowedOrigin = () => APP_ORIGIN;

  const sessionAuthenticator = new SessionAuthenticator(new AuthenticateSessionUseCase(tokenService, getCurrentUser), cookie);
  const authorize = new AuthorizeUseCase(users, roles);
  const authorizationGuard = new AuthorizationGuard(sessionAuthenticator, authorize);

  const tenderManagement = new TenderManagementUseCase(authorize, tenders, users, roles);
  const tenderController = new TenderController(tenderManagement, authorizationGuard, {
    allowedOrigin,
    logger: { logError: (_msg, error) => void loggedErrors.push(error) },
  });

  const authenticationController = new AuthenticationController(
    new RegisterSupplierUseCase(users, roles, passwords),
    new LoginUseCase(users, roles, passwords, tokenService),
    new LogoutUseCase(tokenService),
    sessionAuthenticator,
    { cookie, allowedOrigin, logger: { logError: (_msg, error) => void loggedErrors.push(error) } },
  );

  installContainer({ authenticationController, tenderController } as unknown as Container);

  return {
    users,
    roles,
    tenders,
    passwords,
    tokenService,
    loggedErrors,
    dispose: () => { uninstallContainer(); },
  };
}
