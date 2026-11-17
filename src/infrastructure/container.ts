import { AuthenticationController } from "@/controllers/AuthenticationController";
import { HealthController } from "@/controllers/HealthController";
import { SupplierController } from "@/controllers/SupplierController";
import { TenderController } from "@/controllers/TenderController";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { BidController } from "@/controllers/BidController";
import { SessionAuthenticator } from "@/controllers/SessionAuthenticator";
import { SESSION_COOKIE_NAME, type SessionCookieSettings } from "@/controllers/sessionCookie";
import { EnvironmentConfiguration } from "@/infrastructure/configuration/EnvironmentConfiguration";
import { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import { LoggingAndDeploymentConfiguration } from "@/infrastructure/logging/LoggingAndDeploymentConfiguration";
import type { BidRepositoryInterface } from "@/interfaces/repositories/BidRepositoryInterface";
import type { RevokedTokenRepositoryInterface } from "@/interfaces/repositories/RevokedTokenRepositoryInterface";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { SupplierRepositoryInterface } from "@/interfaces/repositories/SupplierRepositoryInterface";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import type { PasswordServiceInterface } from "@/interfaces/services/PasswordServiceInterface";
import type { TokenServiceInterface } from "@/interfaces/services/TokenServiceInterface";
import { MongoBidRepository } from "@/repositories/MongoBidRepository";
import { MongoRevokedTokenRepository } from "@/repositories/MongoRevokedTokenRepository";
import { MongoRoleRepository } from "@/repositories/MongoRoleRepository";
import { MongoSupplierRepository } from "@/repositories/MongoSupplierRepository";
import { MongoTenderRepository } from "@/repositories/MongoTenderRepository";
import { MongoUserRepository } from "@/repositories/MongoUserRepository";
import { Argon2PasswordService } from "@/services/Argon2PasswordService";
import { JwtTokenService } from "@/services/JwtTokenService";
import { SystemHealthProbeAdapter } from "@/services/SystemHealthProbeAdapter";
import { AuthenticateSessionUseCase } from "@/usecases/authentication/AuthenticateSessionUseCase";
import { CreateUserAccountUseCase } from "@/usecases/authentication/CreateUserAccountUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";
import { BidSubmissionUseCase } from "@/usecases/bid/BidSubmissionUseCase";
import { BidEvaluationUseCase } from "@/usecases/evaluation/BidEvaluationUseCase";
import { EvaluationController } from "@/controllers/EvaluationController";
import { MongoEvaluationRepository } from "@/repositories/MongoEvaluationRepository";
import type { EvaluationRepositoryInterface } from "@/interfaces/repositories/EvaluationRepositoryInterface";
import { SupplierManagementUseCase } from "@/usecases/supplier/SupplierManagementUseCase";
import { TenderManagementUseCase } from "@/usecases/tender/TenderManagementUseCase";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { CheckSystemHealthUseCase } from "@/usecases/health/CheckSystemHealthUseCase";

/**
 * Composition root.
 *
 * This is the ONLY file allowed to know every layer. It creates the concrete
 * classes and wires them together, so inner layers depend on interfaces while the
 * real implementations are chosen here. Next.js route handlers obtain what they
 * need from getContainer() and do nothing else. Each later stage adds its
 * repositories, services, use cases and controllers here.
 */
export interface Container {
  configuration: EnvironmentConfiguration;
  logger: LoggingAndDeploymentConfiguration;
  mongoDB: MongoDBConnection;
  /** Exposed as interfaces: use cases receive these, never the Mongo classes. */
  userRepository: UserRepositoryInterface;
  roleRepository: RoleRepositoryInterface;
  /** Stage 2A: tender persistence. No use case or route uses it yet. */
  tenderRepository: TenderRepositoryInterface;
  /** Stage 2D: supplier profile persistence. */
  supplierRepository: SupplierRepositoryInterface;
  bidRepository: BidRepositoryInterface;
  /** Stage 3: evaluation persistence. */
  evaluationRepository: EvaluationRepositoryInterface;
  passwordService: PasswordServiceInterface;
  revokedTokenRepository: RevokedTokenRepositoryInterface;
  tokenService: TokenServiceInterface;
  registerSupplier: RegisterSupplierUseCase;
  createUserAccount: CreateUserAccountUseCase;
  getCurrentUser: GetCurrentUserUseCase;
  login: LoginUseCase;
  logout: LogoutUseCase;
  authenticateSession: AuthenticateSessionUseCase;
  /** The reusable "who is calling?" helper that later controllers use for protected endpoints. */
  sessionAuthenticator: SessionAuthenticator;
  /** Stage 1F: permission check against the CURRENT user and role in the database. */
  authorize: AuthorizeUseCase;
  /** Authenticate, then authorize. Controllers of protected endpoints call guard.require(request, permission). */
  authorizationGuard: AuthorizationGuard;
  /** Idempotent creation of the four approved roles. Run by `npm run seed:roles`, not by a route. */
  seedRoles: SeedRolesUseCase;
  /** Stage 2B: tender operations. */
  tenderManagement: TenderManagementUseCase;
  /** Stage 2C: tender HTTP endpoints. */
  tenderController: TenderController;
  /** Stage 2D: supplier profile operations and HTTP endpoints. */
  supplierManagement: SupplierManagementUseCase;
  supplierController: SupplierController;
  /** Stage 2E: bid submission operations and HTTP endpoints. */
  bidSubmission: BidSubmissionUseCase;
  bidController: BidController;
  /** Stage 3: read-only evaluation operations and endpoints (writes are blocked by the missing committee assignment model). */
  bidEvaluation: BidEvaluationUseCase;
  evaluationController: EvaluationController;
  authenticationController: AuthenticationController;
  healthController: HealthController;
}

export function createContainer(source: Readonly<Record<string, string | undefined>> = process.env): Container {
  const configuration = new EnvironmentConfiguration(source);
  const logger = new LoggingAndDeploymentConfiguration(configuration);
  const mongoDB = new MongoDBConnection(configuration, logger);

  // Both repositories share the one MongoDBConnection. Neither connects until first used.
  const userRepository = new MongoUserRepository(mongoDB);
  const roleRepository = new MongoRoleRepository(mongoDB);
  const tenderRepository = new MongoTenderRepository(mongoDB);
  const supplierRepository = new MongoSupplierRepository(mongoDB);
  const bidRepository = new MongoBidRepository(mongoDB);
  const evaluationRepository = new MongoEvaluationRepository(mongoDB);
  // Argon2id. The native library is loaded on the first hash/verify call.
  const passwordService = new Argon2PasswordService();

  // JWT tokens with persistent revocation. The JWT settings are read on first use, not here, so a
  // missing production secret cannot stop the application (or the health check) from starting.
  const revokedTokenRepository = new MongoRevokedTokenRepository(mongoDB);
  const tokenService = new JwtTokenService(() => configuration.getJwtSettings(), revokedTokenRepository, {
    onEphemeralSecret: () =>
      logger.logWarning("JWT_SECRET is not set: using a temporary secret for this process. Tokens stop working on restart."),
  });

  // Authentication use cases receive interfaces only.
  const registerSupplier = new RegisterSupplierUseCase(userRepository, roleRepository, passwordService);
  const createUserAccount = new CreateUserAccountUseCase(userRepository, roleRepository, passwordService);
  const getCurrentUser = new GetCurrentUserUseCase(userRepository, roleRepository);
  const login = new LoginUseCase(userRepository, roleRepository, passwordService, tokenService);
  const logout = new LogoutUseCase(tokenService);

  // HTTP adapter for authentication (Stage 1E). The cookie is Secure in production, and the origin
  // used for the CSRF check is read from APP_ORIGIN when a request arrives, not at start-up.
  const authenticateSession = new AuthenticateSessionUseCase(tokenService, getCurrentUser);
  const sessionCookie: SessionCookieSettings = { name: SESSION_COOKIE_NAME, secure: configuration.isProduction() };
  const sessionAuthenticator = new SessionAuthenticator(authenticateSession, sessionCookie);
  const authenticationController = new AuthenticationController(registerSupplier, login, logout, sessionAuthenticator, {
    cookie: sessionCookie,
    allowedOrigin: () => configuration.getAppOrigin(),
    logger,
  });

  // Authorization (Stage 1F) reads user and role from storage on every check; it never uses token claims.
  const authorize = new AuthorizeUseCase(userRepository, roleRepository);
  const authorizationGuard = new AuthorizationGuard(sessionAuthenticator, authorize);
  const seedRoles = new SeedRolesUseCase(roleRepository);
  const tenderManagement = new TenderManagementUseCase(authorize, tenderRepository, userRepository, roleRepository);
  const tenderController = new TenderController(tenderManagement, authorizationGuard, {
    allowedOrigin: () => configuration.getAppOrigin(),
    logger,
  });
  const supplierManagement = new SupplierManagementUseCase(authorize, supplierRepository, userRepository, roleRepository);
  const supplierController = new SupplierController(supplierManagement, authorizationGuard, {
    allowedOrigin: () => configuration.getAppOrigin(),
    logger,
  });

  const bidSubmission = new BidSubmissionUseCase(authorize, bidRepository, tenderRepository, supplierRepository);
  const bidController = new BidController(bidSubmission, authorizationGuard, {
    allowedOrigin: () => configuration.getAppOrigin(),
    logger,
  });

  const bidEvaluation = new BidEvaluationUseCase(authorize, evaluationRepository, tenderRepository);
  const evaluationController = new EvaluationController(bidEvaluation, authorizationGuard, {
    allowedOrigin: () => configuration.getAppOrigin(),
    logger,
  });

  const probe = new SystemHealthProbeAdapter(configuration, mongoDB);
  const healthController = new HealthController(new CheckSystemHealthUseCase(probe));

  return {
    configuration,
    logger,
    mongoDB,
    userRepository,
    roleRepository,
    tenderRepository,
    supplierRepository,
    bidRepository,
    evaluationRepository,
    passwordService,
    revokedTokenRepository,
    tokenService,
    registerSupplier,
    createUserAccount,
    getCurrentUser,
    login,
    logout,
    authenticateSession,
    sessionAuthenticator,
    authorize,
    authorizationGuard,
    seedRoles,
    tenderManagement,
    tenderController,
    supplierManagement,
    supplierController,
    bidSubmission,
    bidController,
    bidEvaluation,
    evaluationController,
    authenticationController,
    healthController,
  };
}

// Next.js dev mode reloads modules on every change. Keeping the container on
// globalThis prevents each reload from opening a new MongoDB connection pool.
const CONTAINER_KEY = Symbol.for("procurement-system.container");
type ContainerHolder = Record<symbol, Container | undefined>;

export function getContainer(): Container {
  const holder = globalThis as unknown as ContainerHolder;
  holder[CONTAINER_KEY] ??= createContainer();
  return holder[CONTAINER_KEY];
}
