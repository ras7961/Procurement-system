import { describe, expect, it, vi } from "vitest";
import { createContainer } from "@/infrastructure/container";
import { MongoRoleRepository } from "@/repositories/MongoRoleRepository";
import { BidController } from "@/controllers/BidController";
import { MongoEvaluationRepository } from "@/repositories/MongoEvaluationRepository";
import { BidEvaluationUseCase } from "@/usecases/evaluation/BidEvaluationUseCase";
import { EvaluationController } from "@/controllers/EvaluationController";
import { MongoBidRepository } from "@/repositories/MongoBidRepository";
import { BidSubmissionUseCase } from "@/usecases/bid/BidSubmissionUseCase";
import { MongoTenderRepository } from "@/repositories/MongoTenderRepository";
import { MongoUserRepository } from "@/repositories/MongoUserRepository";
import { Argon2PasswordService } from "@/services/Argon2PasswordService";
import { JwtTokenService } from "@/services/JwtTokenService";
import { CreateUserAccountUseCase } from "@/usecases/authentication/CreateUserAccountUseCase";
import { GetCurrentUserUseCase } from "@/usecases/authentication/GetCurrentUserUseCase";
import { LoginUseCase } from "@/usecases/authentication/LoginUseCase";
import { LogoutUseCase } from "@/usecases/authentication/LogoutUseCase";
import { AuthorizationGuard } from "@/controllers/AuthorizationGuard";
import { TenderManagementUseCase } from "@/usecases/tender/TenderManagementUseCase";
import { SupplierController } from "@/controllers/SupplierController";
import { MongoSupplierRepository } from "@/repositories/MongoSupplierRepository";
import { SupplierManagementUseCase } from "@/usecases/supplier/SupplierManagementUseCase";
import { TenderController } from "@/controllers/TenderController";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import { RegisterSupplierUseCase } from "@/usecases/authentication/RegisterSupplierUseCase";

describe("composition root (Stage 1B wiring)", () => {
  it("wires the Mongo repositories and the Argon2id password service", () => {
    const container = createContainer({ NODE_ENV: "test" });

    expect(container.userRepository).toBeInstanceOf(MongoUserRepository);
    expect(container.roleRepository).toBeInstanceOf(MongoRoleRepository);
    expect(container.tenderRepository).toBeInstanceOf(MongoTenderRepository);
    expect(container.tenderManagement).toBeInstanceOf(TenderManagementUseCase);
    expect(container.tenderController).toBeInstanceOf(TenderController);
    expect(container.supplierRepository).toBeInstanceOf(MongoSupplierRepository);
    expect(container.supplierManagement).toBeInstanceOf(SupplierManagementUseCase);
    expect(container.supplierController).toBeInstanceOf(SupplierController);
    expect(container.bidRepository).toBeInstanceOf(MongoBidRepository);
    expect(container.bidSubmission).toBeInstanceOf(BidSubmissionUseCase);
    expect(container.bidController).toBeInstanceOf(BidController);
    expect(container.evaluationRepository).toBeInstanceOf(MongoEvaluationRepository);
    expect(container.bidEvaluation).toBeInstanceOf(BidEvaluationUseCase);
    expect(container.evaluationController).toBeInstanceOf(EvaluationController);
    expect(container.passwordService).toBeInstanceOf(Argon2PasswordService);
  });

  it("wires the authentication use cases that do not need a token service", () => {
    const container = createContainer({ NODE_ENV: "test" });

    expect(container.registerSupplier).toBeInstanceOf(RegisterSupplierUseCase);
    expect(container.createUserAccount).toBeInstanceOf(CreateUserAccountUseCase);
    expect(container.getCurrentUser).toBeInstanceOf(GetCurrentUserUseCase);
  });

  it("wires role seeding and authorization (Stage 1F)", () => {
    const container = createContainer({ NODE_ENV: "test" });

    expect(container.seedRoles).toBeInstanceOf(SeedRolesUseCase);
    expect(container.authorize).toBeInstanceOf(AuthorizeUseCase);
    expect(container.authorizationGuard).toBeInstanceOf(AuthorizationGuard);
  });

  it("wires login and logout with the JWT token service", () => {
    const container = createContainer({ NODE_ENV: "test" });

    expect(container.tokenService).toBeInstanceOf(JwtTokenService);
    expect(container.login).toBeInstanceOf(LoginUseCase);
    expect(container.logout).toBeInstanceOf(LogoutUseCase);
  });

  it("starts even when the production JWT secret is missing, and fails closed when a token is used", async () => {
    const container = createContainer({ NODE_ENV: "production", MONGODB_URI: "mongodb://127.0.0.1:1", MONGODB_DB_NAME: "x" });

    await expect(container.tokenService.issue({ userId: "u", roleId: "r" })).rejects.toMatchObject({ code: "ENVIRONMENT_CONFIGURATION_ERROR" });
    await container.mongoDB.closeConnection();
  });

  it("opens no database connection until a repository is used", async () => {
    const container = createContainer({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://127.0.0.1:1",
      MONGODB_DB_NAME: "never_used",
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: "200",
    });
    const connect = vi.spyOn(container.mongoDB, "connect");
    const getDatabase = vi.spyOn(container.mongoDB, "getDatabase");

    // Nothing has touched the database yet, including building the whole container.
    expect(connect).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();

    await container.mongoDB.closeConnection();
  });

  it("shares one MongoDBConnection between both repositories", async () => {
    const container = createContainer({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://127.0.0.1:1",
      MONGODB_DB_NAME: "unreachable",
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: "200",
    });
    const getDatabase = vi.spyOn(container.mongoDB, "getDatabase");

    // The server is unreachable on purpose: both calls must fail safely through the SAME connection object.
    await expect(container.userRepository.findAll()).rejects.toMatchObject({ code: "DATABASE_CONNECTION_ERROR" });
    await expect(container.roleRepository.findAll()).rejects.toMatchObject({ code: "DATABASE_CONNECTION_ERROR" });
    await expect(container.revokedTokenRepository.isRevoked("jti")).rejects.toMatchObject({ code: "DATABASE_CONNECTION_ERROR" });
    expect(getDatabase).toHaveBeenCalledTimes(3);

    await container.mongoDB.closeConnection();
  });

  it("keeps the health endpoint independent of the password library", async () => {
    const { healthController, passwordService } = createContainer({ NODE_ENV: "test" });
    const hashSpy = vi.spyOn(passwordService, "hash");

    const { statusCode } = await healthController.getHealth();

    expect(statusCode).toBe(503); // no database configured, as expected for this input
    expect(hashSpy).not.toHaveBeenCalled();
  });
});
