import { apiRequest, type QueryParams } from './apiClient';
import type { ListResponse, PostedResult, Transaction } from '../../types';

export interface TransactionFilters extends QueryParams {
  /** One type or a comma-separated list, e.g. "INCOME,EXPENSE". */
  type?: string;
  status?: string;
  account_id?: string;
  category_id?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TransferInput {
  from_account_id: string;
  to_account_id: string;
  amount: string;
  occurred_on: string;
  description?: string;
  reference?: string;
  /** Amount that arrived, when the two accounts are in different currencies. */
  to_amount?: string;
  /** Sending currency to workspace currency; only when neither account is in the workspace currency. */
  exchange_rate?: string;
}

export const transactionsApi = {
  list: (filters: TransactionFilters = {}) => apiRequest<ListResponse<Transaction>>('/transactions/', { query: filters }),
  get: (id: string) => apiRequest<Transaction>(`/transactions/${id}/`),
  /**
   * Posted history is never edited. This books an opposite entry and leaves the
   * original in place; the caller records a corrected replacement if needed.
   */
  reverse: (id: string, idempotencyKey: string, reason = '') =>
    apiRequest<{ id: string; reverses_transaction_id: string }>(`/transactions/${id}/reverse/`, {
      method: 'POST',
      body: reason ? { reference: reason } : {},
      idempotencyKey,
    }),
  transfers: (filters: TransactionFilters = {}) => apiRequest<ListResponse<Transaction>>('/transfers/', { query: filters }),
  transfer: (data: TransferInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/transfers/', { method: 'POST', body: data, idempotencyKey }),
};
