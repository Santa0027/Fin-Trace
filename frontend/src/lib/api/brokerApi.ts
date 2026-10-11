import { apiRequest } from './apiClient';
import type { BrokerAnalytics, BrokerPortfolio } from '../../types';

const BASE = '/integrations/zerodha';

/** Zerodha (Kite for stocks and ETFs, Coin for mutual funds). Read-only: FinTrace can never place orders. */
export const brokerApi = {
  portfolio: () => apiRequest<BrokerPortfolio>(`${BASE}/portfolio/`),
  /** The portfolio plus concentration, change over time, SIPs, positions and observations. */
  analytics: () => apiRequest<BrokerAnalytics>(`${BASE}/analytics/`),
  /** Returns Zerodha's own sign-in page; the browser goes there and comes back to FinTrace. */
  connect: () => apiRequest<{ login_url: string }>(`${BASE}/connect/`, { method: 'POST' }),
  sync: () => apiRequest<BrokerPortfolio>(`${BASE}/sync/`, { method: 'POST' }),
  disconnect: () => apiRequest<BrokerPortfolio>(`${BASE}/disconnect/`, { method: 'POST' }),
};
