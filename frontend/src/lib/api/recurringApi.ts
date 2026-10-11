import { apiRequest } from './apiClient';
import type { ListResponse, RecurringFrequency, RecurringRunResult, RecurringTransaction } from '../../types';

export interface RecurringInput {
  transaction_type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  description: string;
  amount: string;
  frequency: RecurringFrequency;
  next_run_at: string;
  source_account_id?: string;
  destination_account_id?: string;
  category_id?: string;
}

export const recurringApi = {
  list: (limit = 100, offset = 0) =>
    apiRequest<ListResponse<RecurringTransaction>>('/recurring-transactions/', { query: { limit, offset } }),
  create: (data: RecurringInput) => apiRequest<RecurringTransaction>('/recurring-transactions/', { method: 'POST', body: data }),
  update: (id: string, data: Partial<Pick<RecurringTransaction, 'description' | 'next_run_at' | 'end_date' | 'is_active'>>) =>
    apiRequest<RecurringTransaction>(`/recurring-transactions/${id}/`, { method: 'PATCH', body: data }),
  /** Post the next due occurrence to the ledger, or skip it. Either way the item moves to its next date. */
  run: (id: string, action: 'post' | 'skip', idempotencyKey: string, overrides: { category_id?: string } = {}) =>
    apiRequest<RecurringRunResult>(`/recurring-transactions/${id}/run/`, { method: 'POST', body: { action, ...overrides }, idempotencyKey }),
};
