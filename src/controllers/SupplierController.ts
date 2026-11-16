import type { SupplierManagementUseCase } from "@/usecases/supplier/SupplierManagementUseCase";
import { SUPPLIER_OPERATION_PERMISSIONS } from "@/usecases/supplier/SupplierManagementUseCase";
import { errorResponse, successResponse } from "./apiResponse";
import type { AuthorizationGuard } from "./AuthorizationGuard";
import { assertTrustedOrigin, readJsonObject } from "./requestSecurity";
import type { TenderControllerOptions } from "./TenderController";
import {
  parseListSuppliersRequest,
  parseRegisterSupplierRequest,
  parseUpdateSupplierRequest,
  parseVerifySupplierRequest,
} from "./supplierRequests";

/** Same options as the tender controller: the trusted origin (read when a request arrives) and an error logger. */
export type SupplierControllerOptions = TenderControllerOptions;

/**
 * controllers.SupplierController (ODD: registerSupplier, getSupplier, updateSupplier, verifySupplier, listSuppliers).
 *
 * Each method maps to one API endpoint, takes the standard Web `Request`, and returns a standard `Response`. No business
 * rule lives here. Each state-changing method: checks the origin (CSRF), authenticates and authorizes the caller via the
 * guard (session -> stored role), validates the body, delegates to the use case, and returns a safe JSON response.
 *
 * The user id comes from the authenticated session, never from the body or URL. Ownership of a profile is decided by the
 * use case from stored data. `submitDocuments` is not offered (Stage 2D does not include supplier documents).
 */
export class SupplierController {
  constructor(
    private readonly supplierManagement: SupplierManagementUseCase,
    private readonly guard: AuthorizationGuard,
    private readonly options: SupplierControllerOptions,
  ) {}

  /** POST /api/suppliers */
  async registerSupplier(request: Request): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.register);
      const input = parseRegisterSupplierRequest(await readJsonObject(request), caller.user.userId, caller.user.roleName);
      const supplier = await this.supplierManagement.registerSupplier(input);
      return successResponse(201, { supplier }, "Supplier profile created.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "registerSupplier");
    }
  }

  /** GET /api/suppliers */
  async listSuppliers(request: Request): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.list);
      const input = parseListSuppliersRequest(new URL(request.url).searchParams, caller.user.userId);
      return successResponse(200, await this.supplierManagement.listSuppliers(input), "Suppliers retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "listSuppliers");
    }
  }

  /** GET /api/suppliers/me */
  async getOwnSupplier(request: Request): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.getOwn);
      const supplier = await this.supplierManagement.getOwnSupplier({ actingUserId: caller.user.userId });
      return successResponse(200, { supplier }, "Supplier profile retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getOwnSupplier");
    }
  }

  /** GET /api/suppliers/[id] */
  async getSupplier(request: Request, supplierId: string): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.get);
      const supplier = await this.supplierManagement.getSupplier({ actingUserId: caller.user.userId, supplierId });
      return successResponse(200, { supplier }, "Supplier retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getSupplier");
    }
  }

  /** PATCH /api/suppliers/[id] */
  async updateSupplier(request: Request, supplierId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.update);
      const input = parseUpdateSupplierRequest(await readJsonObject(request), caller.user.userId, supplierId);
      const supplier = await this.supplierManagement.updateSupplier(input);
      return successResponse(200, { supplier }, "Supplier profile updated.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "updateSupplier");
    }
  }

  /** POST /api/suppliers/[id]/verification */
  async verifySupplier(request: Request, supplierId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, SUPPLIER_OPERATION_PERMISSIONS.verify);
      const input = parseVerifySupplierRequest(await readJsonObject(request), caller.user.userId, supplierId);
      const supplier = await this.supplierManagement.verifySupplier(input);
      return successResponse(200, { supplier }, "Supplier verification updated.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "verifySupplier");
    }
  }
}
