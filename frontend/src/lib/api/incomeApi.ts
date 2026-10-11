import { apiRequest, type QueryParams } from './apiClient';
import type { FinancialRecord, ListResponse, PostedResult } from '../../types';

export interface RecordFilters extends QueryParams {
  date_from?: string;
  date_to?: string;
  category_id?: string;
  limit?: number;
  offset?: number;
}

export interface IncomeInput {
  amount: string;
  category_id: string;
  /** Received into */
  destination_account_id: string;
  occurred_on: string;
  contact_id?: string;
  reference?: string;
  notes?: string;
}

export const incomeApi = {
  list: (filters: RecordFilters = {}) => apiRequest<ListResponse<FinancialRecord>>('/income/', { query: filters }),
  create: (data: IncomeInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/income/', { method: 'POST', body: data, idempotencyKey }),
};
