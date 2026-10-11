import { apiRequest } from './apiClient';
import type { Dividend, Holding, ListResponse, PostedResult, Trade } from '../../types';

export interface TradeInput {
  trade_type: 'BUY' | 'SELL';
  symbol: string;
  name?: string;
  instrument_type?: string;
  quantity: string;
  price: string;
  fees?: string;
  /** Paid from (buy) or received into (sell). */
  settlement_account_id: string;
  traded_on: string;
}

export interface DividendInput {
  symbol: string;
  amount: string;
  deposit_account_id: string;
  paid_on: string;
}

export const investmentsApi = {
  holdings: (limit = 200) => apiRequest<ListResponse<Holding>>('/reports/investment-position-summary/', { query: { limit } }),
  trades: (limit = 50, offset = 0) => apiRequest<ListResponse<Trade>>('/investments/trades/', { query: { limit, offset } }),
  dividends: (limit = 50, offset = 0) => apiRequest<ListResponse<Dividend>>('/investments/dividends/', { query: { limit, offset } }),
  recordTrade: (data: TradeInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/investments/trades/', { method: 'POST', body: data, idempotencyKey }),
  recordDividend: (data: DividendInput, idempotencyKey: string) =>
    apiRequest<PostedResult>('/investments/dividends/', { method: 'POST', body: data, idempotencyKey }),
};
