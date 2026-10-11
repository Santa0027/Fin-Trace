import { apiRequest } from './apiClient';
import type { CashflowPoint, CategoryBreakdown, DashboardSummary } from '../../types';

/** Inclusive dates (YYYY-MM-DD), interpreted as UTC calendar days by the backend. */
export interface Period {
  date_from: string;
  date_to: string;
}

export const reportsApi = {
  /** One request for everything on the dashboard, all from one ledger snapshot. */
  dashboard: (period: Period, months = 6) => apiRequest<DashboardSummary>('/dashboard/summary/', { query: { ...period, months } }),
  cashflow: (months = 6, dateTo?: string) =>
    apiRequest<{ results: CashflowPoint[]; months: number }>('/reports/cashflow/', { query: { months, date_to: dateTo } }),
  spendingByCategory: (period: Period) => apiRequest<CategoryBreakdown>('/reports/spending-by-category/', { query: { ...period } }),
  incomeByCategory: (period: Period) => apiRequest<CategoryBreakdown>('/reports/income-by-category/', { query: { ...period } }),
};
