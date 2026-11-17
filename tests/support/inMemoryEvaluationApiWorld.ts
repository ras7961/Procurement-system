import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { Container } from "@/infrastructure/container";
import { AuthenticationController } from "@/controllers/AuthenticationController";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { EvaluationController } from "@/controllers/EvaluationController";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import { JwtTokenService } from "@/services/JwtTokenService";
import { generateId } from "@/shared/utilities/uuid";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { BidEvaluationUseCase } from "@/usecases/evaluation/BidEvaluationUseCase";
import { InMemoryEvaluationRepository } from "./InMemoryEvaluationRepository";
import { InMemoryRevokedTokenRepository } from "./InMemoryRevokedTokenRepository";
import { InMemoryRoleRepository } from "./InMemoryRoleRepository";
import { InMemoryTenderRepository } from "./InMemoryTenderRepository";
import { InMemoryUserRepository } from "./InMemoryUserRepository";
import { FakePasswordService } from "./authFakes";
import { installContainer, uninstallContainer } from "./authApiTestKit";

export const APP_ORIGIN = "https://procurement.example.org";

/** In-memory world for the evaluation API tests: real auth, guard, controller and use case. */
export async function createInMemoryEvaluationApiWorld() {
  const settings: JwtSettings = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api", accessTokenTtlSeconds: 900, secretSource: "environment" };
  const users = new InMemoryUserRepository();
  const roles = new InMemoryRoleRepository();
  const tenders = new InMemoryTenderRepository();
  const evaluations = new InMemoryEvaluationRepository();
  const passwords = new FakePasswordService();
  const loggedErrors: unknown[] = [];
  await new SeedRolesUseCase(roles).execute();

  const tokenService = new JwtTokenService(() => settings, new InMemoryRevokedTokenRepository());
  const cookie = { name: SESSION_COOKIE_NAME, secure: true };
  const allowedOrigin = () => APP_ORIGIN;
  const logger = { logError: (_m: string, error?: unknown) => void loggedErrors.push(error) };
  const sessionAuthenticator = new SessionAuthenticator(new AuthenticateSessionUseCase(tokenService, new GetCurrentUserUseCase(users, roles)), cookie);
  const authorize = new AuthorizeUseCase(users, roles);
  const guard = new AuthorizationGuard(sessionAuthenticator, authorize);
  const evaluationController = new EvaluationController(new BidEvaluationUseCase(authorize, evaluations, tenders), guard, { allowedOrigin, logger });
  const authenticationController = new AuthenticationController(
    new RegisterSupplierUseCase(users, roles, passwords),
    new LoginUseCase(users, roles, passwords, tokenService),
    new LogoutUseCase(tokenService),
    sessionAuthenticator,
    { cookie, allowedOrigin, logger },
  );
  installContainer({ authenticationController, evaluationController } as unknown as Container);
  return { users, roles, tenders, evaluations, passwords, loggedErrors, dispose: () => uninstallContainer() };
}
