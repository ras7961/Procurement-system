import type { CheckSystemHealthUseCase } from "@/usecases/health/CheckSystemHealthUseCase";
import type { HealthReport } from "@/shared/types/health";

export interface ControllerResponse<TBody> {
  statusCode: number;
  body: TBody;
}

/**
 * Adapter between the web layer and CheckSystemHealthUseCase.
 * Healthy maps to 200; anything else maps to 503 so load balancers and
 * monitors treat the instance as not ready.
 */
export class HealthController {
  constructor(private readonly checkSystemHealth: CheckSystemHealthUseCase) {}

  async getHealth(): Promise<ControllerResponse<HealthReport>> {
    const report = await this.checkSystemHealth.execute();
    return { statusCode: report.status === "healthy" ? 200 : 503, body: report };
  }
}
