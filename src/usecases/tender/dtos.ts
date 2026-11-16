import type { Tender, TenderStatus, UpdateTenderProps } from "@/entities/Tender";

/**
 * Input and output shapes of the tender use cases. Plain data: no entities.
 * Every input carries `actingUserId`, the id of the authenticated user taken from a verified session by the
 * HTTP adapter. No role or permission is ever part of an input: the use case reads them from storage.
 */

export interface CreateTenderInput {
  actingUserId: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements?: readonly string[];
  evaluationCriteria?: readonly string[];
  submissionDeadline: Date;
  /**
   * The responsible Procurement Broker. A Procurement Broker creating a tender is always the responsible broker
   * (this may be left out or must equal their own id). Any other creator, in practice an Administrator, must name
   * an active Procurement Broker here.
   */
  brokerId?: string;
}

export interface UpdateTenderInput {
  actingUserId: string;
  tenderId: string;
  /** Only these fields can change; anything else is rejected. */
  changes: UpdateTenderProps;
}

export interface TenderActionInput {
  actingUserId: string;
  tenderId: string;
}

export interface ListTendersInput {
  actingUserId: string;
  status?: TenderStatus | readonly TenderStatus[];
  brokerId?: string;
  category?: string;
  limit?: number;
  skip?: number;
}

export interface TenderDto {
  tenderId: string;
  title: string;
  description: string;
  category: string;
  estimatedBudget: number;
  requirements: string[];
  evaluationCriteria: string[];
  /** ISO text, or null until the tender is published. */
  publicationDate: string | null;
  submissionDeadline: string;
  status: TenderStatus;
  brokerId: string;
  createdAt: string;
  /** True while suppliers can still submit bids: Published and before the deadline. */
  openForSubmissions: boolean;
}

export interface TenderListDto {
  tenders: TenderDto[];
  limit: number;
  skip: number;
}

export function toTenderDto(tender: Tender, now: Date): TenderDto {
  return { ...tender.toJSON(), openForSubmissions: tender.isOpenForSubmissions(now) };
}
