import { apiRequest } from './apiClient';
import type { Account, Currency, ListResponse } from '../../types';

export interface AccountInput {
  name: string;
  type: string;
  currency_id: string;
  institution?: string;
  account_number?: string;
  notes?: string;
  /** Booked against Opening balances; the account's accounting side is derived by the backend. */
  opening_balance?: string;
  opening_date?: string;
}

export type AccountUpdate = Partial<Pick<Account, 'name' | 'institution' | 'account_number' | 'notes' | 'is_active'>>;

export const accountsApi = {
  /** Every account with its ledger balance. */
  list: (limit = 200, offset = 0) => apiRequest<ListResponse<Account>>('/accounts/', { query: { limit, offset } }),
  get: (id: string) => apiRequest<Account>(`/accounts/${id}/`),
  create: (data: AccountInput) => apiRequest<Account>('/accounts/', { method: 'POST', body: data }),
  update: (id: string, data: AccountUpdate) => apiRequest<Account>(`/accounts/${id}/`, { method: 'PATCH', body: data }),
  archive: (id: string) => apiRequest<{ status: string; id: string }>(`/accounts/${id}/archive/`, { method: 'POST' }),
  currencies: () => apiRequest<{ results: Currency[] }>('/currencies/'),
};
