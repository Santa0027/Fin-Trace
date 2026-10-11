import { apiRequest } from './apiClient';
import type { RecordFilters } from './incomeApi';
import type { FinancialRecord, ListResponse, PostedResult } from '../../types';

export interface ExpenseInput {
  amount: string;
  category_id: string;
  /** Paid from */
  source_account_id: string;
  occurred_on: string;
  contact_id?: string;
  reference?: string;
  notes?: string;
}

export const expensesApi = {
  list: (filters: RecordFilters = {}) => apiRequest<ListResponse<FinancialRecord>>('/expenses/', { query: filters }),
  create: (data: ExpenseInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/expenses/', { method: 'POST', body: data, idempotencyKey }),
};
