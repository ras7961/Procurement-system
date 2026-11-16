import type { TenderManagementUseCase } from "@/usecases/tender/TenderManagementUseCase";
import {
  errorResponse,
  successResponse,
  type ErrorLogger,
} from "./apiResponse";
import { assertTrustedOrigin, readJsonObject } from "./requestSecurity";
import {
  parseCreateTenderRequest,
  parseListTendersRequest,
  parseUpdateTenderRequest,
} from "./tenderRequests";
import type { AuthorizationGuard } from "./AuthorizationGuard";

export interface TenderControllerOptions {
  /**
   * The application origin that state-changing requests (POST, PATCH, DELETE) must come from.
   * A function so a missing production setting fails the request rather than the startup.
   */
  allowedOrigin: () => string;
  logger?: ErrorLogger;
}

/**
 * controllers.TenderController (ODD: Stage 2C).
 *
 * Each method maps to one API endpoint, takes the standard Web `Request`, and returns a standard
 * `Response`. No business rule lives here. Each state-changing method:
 *   1. Checks the origin (CSRF).
 *   2. Authenticates and authorizes the caller via the guard (session -> stored role).
 *   3. Validates the request body / query params.
 *   4. Delegates to the use case.
 *   5. Returns a safe JSON response.
 *
 * The user id is taken from the authenticated session, never from the request body or URL.
 * The role and brokerId are derived by the use case from stored data.
 */
export class TenderController {
  constructor(
    private readonly tenderManagement: TenderManagementUseCase,
    private readonly guard: AuthorizationGuard,
    private readonly options: TenderControllerOptions,
  ) {}

  /** POST /api/tenders */
  async createTender(request: Request): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:create");
      const input = parseCreateTenderRequest(
        await readJsonObject(request),
        caller.user.userId,
        caller.user.roleName,
      );
      const tender = await this.tenderManagement.createTender(input);
      return successResponse(201, { tender }, "Tender created.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "createTender");
    }
  }

  /** GET /api/tenders */
  async listTenders(request: Request): Promise<Response> {
    try {
      const caller = await this.guard.require(request, "tender:read");
      const url = new URL(request.url);
      const input = parseListTendersRequest(
        url.searchParams,
        caller.user.userId,
      );
      const result = await this.tenderManagement.listTenders(input);
      return successResponse(200, result, "Tenders retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "listTenders");
    }
  }

  /** GET /api/tenders/[id] */
  async getTender(request: Request, tenderId: string): Promise<Response> {
    try {
      const caller = await this.guard.require(request, "tender:read");
      const tender = await this.tenderManagement.getTender({
        actingUserId: caller.user.userId,
        tenderId,
      });
      return successResponse(200, { tender }, "Tender retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getTender");
    }
  }

  /** PATCH /api/tenders/[id] */
  async updateTender(request: Request, tenderId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:update");
      const input = parseUpdateTenderRequest(
        await readJsonObject(request),
        caller.user.userId,
        tenderId,
      );
      const tender = await this.tenderManagement.updateTender(input);
      return successResponse(200, { tender }, "Tender updated.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "updateTender");
    }
  }

  /** POST /api/tenders/[id]/publish */
  async publishTender(request: Request, tenderId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:publish");
      const tender = await this.tenderManagement.publishTender({
        actingUserId: caller.user.userId,
        tenderId,
      });
      return successResponse(200, { tender }, "Tender published.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "publishTender");
    }
  }

  /** POST /api/tenders/[id]/close */
  async closeTender(request: Request, tenderId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:publish");
      const tender = await this.tenderManagement.closeTender({
        actingUserId: caller.user.userId,
        tenderId,
      });
      return successResponse(200, { tender }, "Tender closed.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "closeTender");
    }
  }

  /** POST /api/tenders/[id]/cancel */
  async cancelTender(request: Request, tenderId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:publish");
      const tender = await this.tenderManagement.cancelTender({
        actingUserId: caller.user.userId,
        tenderId,
      });
      return successResponse(200, { tender }, "Tender cancelled.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "cancelTender");
    }
  }

  /** DELETE /api/tenders/[id] */
  async deleteDraftTender(
    request: Request,
    tenderId: string,
  ): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.require(request, "tender:update");
      await this.tenderManagement.deleteDraftTender({
        actingUserId: caller.user.userId,
        tenderId,
      });
      return successResponse(200, null, "Tender deleted.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "deleteDraftTender");
    }
  }
}
