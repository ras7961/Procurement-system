import type { BidSubmissionUseCase } from "@/usecases/bid/BidSubmissionUseCase";
import { BID_OPERATION_PERMISSIONS } from "@/usecases/bid/BidSubmissionUseCase";
import { errorResponse, successResponse } from "./apiResponse";
import type { AuthorizationGuard } from "./AuthorizationGuard";
import { parseListBidsRequest, parseSubmitBidRequest, parseUpdateBidRequest } from "./bidRequests";
import { assertTrustedOrigin, readJsonObject } from "./requestSecurity";
import type { TenderControllerOptions } from "./TenderController";

/** Same options as the tender controller: the trusted origin (read when a request arrives) and an error logger. */
export type BidControllerOptions = TenderControllerOptions;

/**
 * controllers.BidController (ODD: submitBid, getBid, listBids, updateBid, withdrawBid).
 *
 * Each method maps to one API endpoint, takes the standard Web `Request`, and returns a standard `Response`. No business
 * rule lives here. Each state-changing method: checks the origin (CSRF), authenticates and authorizes the caller via the
 * guard (session -> stored role), validates the body, delegates to the use case, and returns a safe JSON response.
 *
 * The user id comes from the authenticated session, never from the body or URL. The supplier a bid belongs to, bid status and
 * every protected field are decided by the use case from stored data: the strict request schemas refuse them in a body.
 */
export class BidController {
  constructor(
    private readonly bidSubmission: BidSubmissionUseCase,
    private readonly guard: AuthorizationGuard,
    private readonly options: BidControllerOptions,
  ) {}

  /** POST /api/bids */
  async submitBid(request: Request): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, BID_OPERATION_PERMISSIONS.submit);
      const input = parseSubmitBidRequest(await readJsonObject(request), caller.user.userId);
      const bid = await this.bidSubmission.submitBid(input);
      return successResponse(201, { bid }, "Bid submitted.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "submitBid");
    }
  }

  /** GET /api/bids */
  async listBids(request: Request): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, BID_OPERATION_PERMISSIONS.list);
      const input = parseListBidsRequest(new URL(request.url).searchParams, caller.user.userId);
      return successResponse(200, await this.bidSubmission.listBids(input), "Bids retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "listBids");
    }
  }

  /** GET /api/bids/[id] */
  async getBid(request: Request, bidId: string): Promise<Response> {
    try {
      const caller = await this.guard.requireAny(request, BID_OPERATION_PERMISSIONS.get);
      const bid = await this.bidSubmission.getBid({ actingUserId: caller.user.userId, bidId });
      return successResponse(200, { bid }, "Bid retrieved.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "getBid");
    }
  }

  /** PATCH /api/bids/[id] */
  async updateBid(request: Request, bidId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, BID_OPERATION_PERMISSIONS.update);
      const input = parseUpdateBidRequest(await readJsonObject(request), caller.user.userId, bidId);
      const bid = await this.bidSubmission.updateBid(input);
      return successResponse(200, { bid }, "Bid updated.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "updateBid");
    }
  }

  /** POST /api/bids/[id]/withdraw */
  async withdrawBid(request: Request, bidId: string): Promise<Response> {
    try {
      assertTrustedOrigin(request, this.options.allowedOrigin());
      const caller = await this.guard.requireAny(request, BID_OPERATION_PERMISSIONS.withdraw);
      const bid = await this.bidSubmission.withdrawBid({ actingUserId: caller.user.userId, bidId });
      return successResponse(200, { bid }, "Bid withdrawn.");
    } catch (error) {
      return errorResponse(error, this.options.logger, "withdrawBid");
    }
  }
}
