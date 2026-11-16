import { DatabaseOperationException } from "@/entities/exceptions";
import type { JwtSettings } from "@/infrastructure/configuration/EnvironmentConfiguration";
import type { Container } from "@/infrastructure/container";
import { AuthenticationController } from "@/controllers/AuthenticationController";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME } from "@/controllers/sessionCookie";
import { JwtTokenService } from "@/services/JwtTokenService";
import { generateId } from "@/shared/utilities/uuid";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { InMemoryRevokedTokenRepository } from "./InMemoryRevokedTokenRepository";
import { InMemoryRoleRepository } from "./InMemoryRoleRepository";
import { InMemoryUserRepository } from "./InMemoryUserRepository";
import { FakePasswordService } from "./authFakes";
import { installContainer, uninstallContainer } from "./authApiTestKit";
import type { AuthApiWorld } from "./authApiScenarios";

/** In-memory repositories whose failures can be switched on, to prove errors never leak. */
class FlakyUserRepository extends InMemoryUserRepository {
  failWith: Error | null = null;

  override async findByEmail(email: string) {
    if (this.failWith) throw this.failWith;
    return super.findByEmail(email);
  }

  override async findById(userId: string) {
    if (this.failWith) throw this.failWith;
    return super.findById(userId);
  }
}

const databaseFailure = () =>
  new DatabaseOperationException({ cause: new Error("connection to mongodb://admin:hunter2@db.internal:27017 refused") });

export const APP_ORIGIN = "https://procurement.example.org";

/** Builds the real route -> controller -> use case -> JwtTokenService chain on in-memory storage. */
export function createInMemoryWorld(overrides: { secure?: boolean } = {}) {
  const jwt = { secret: `${generateId()}${generateId()}`, issuer: "procurement-system", audience: "procurement-system-api" };
  const settings: JwtSettings = { ...jwt, accessTokenTtlSeconds: 900, secretSource: "environment" };
  const secure = overrides.secure ?? true;

  const users = new FlakyUserRepository();
  const roles = new InMemoryRoleRepository();
  const passwords = new FakePasswordService();
  const revoked = new InMemoryRevokedTokenRepository();
  const loggedErrors: unknown[] = [];

  const tokenService = new JwtTokenService(() => settings, revoked);
  const getCurrentUser = new GetCurrentUserUseCase(users, roles);
  const cookie = { name: SESSION_COOKIE_NAME, secure };
  const controller = new AuthenticationController(
    new RegisterSupplierUseCase(users, roles, passwords),
    new LoginUseCase(users, roles, passwords, tokenService),
    new LogoutUseCase(tokenService),
    new SessionAuthenticator(new AuthenticateSessionUseCase(tokenService, getCurrentUser), cookie),
    { cookie, allowedOrigin: () => APP_ORIGIN, logger: { logError: (_message, error) => void loggedErrors.push(error) } },
  );
  installContainer({ authenticationController: controller } as unknown as Container);

  const world: AuthApiWorld = {
    origin: APP_ORIGIN,
    jwt,
    secureCookies: secure,
    users,
    roles,
    passwords,
    faults: {
      breakUserStore: () => void (users.failWith = databaseFailure()),
      breakRevocationStore: () => void (revoked.failWith = databaseFailure()),
      heal: () => {
        users.failWith = null;
        revoked.failWith = null;
      },
      loggedErrors,
    },
    dispose: async () => uninstallContainer(),
  };
  return { world, controller, loggedErrors };
}
