import { apiRequest } from './apiClient';
import type { Debt, DebtRepayment, ListResponse, PostedResult } from '../../types';

export interface DebtInput {
  type: 'PAYABLE' | 'RECEIVABLE';
  /** Who the loan is with; an existing contact is reused, otherwise one is created. */
  contact_name: string;
  principal_amount: string;
  interest_rate?: string;
  start_date: string;
  due_date?: string;
  /** Where the borrowed money arrived (or the lent money left). Omit for a loan that predates FinTrace. */
  account_id?: string;
  notes?: string;
}

export interface RepaymentInput {
  account_id: string;
  principal_amount: string;
  interest_amount?: string;
  repaid_on: string;
  notes?: string;
}

export interface RepaymentResult extends PostedResult {
  outstanding_principal: string;
  status: 'ACTIVE' | 'PAID';
}

export const debtsApi = {
  list: (limit = 100, offset = 0) => apiRequest<ListResponse<Debt>>('/debts/', { query: { limit, offset } }),
  get: (id: string) => apiRequest<Debt>(`/debts/${id}/`),
  create: (data: DebtInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/debts/', { method: 'POST', body: data, idempotencyKey }),
  repayments: (id: string) => apiRequest<ListResponse<DebtRepayment>>(`/debts/${id}/repayments/`),
  repay: (id: string, data: RepaymentInput, idempotencyKey: string) =>
    apiRequest<RepaymentResult>(`/debts/${id}/repayments/`, { method: 'POST', body: data, idempotencyKey }),
};
