/**
 * Test harness: a fake `fetch` that speaks the real FinTrace API contract
 * (same paths, payload shapes and error envelope as the Django backend).
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AuthProvider } from '../providers/AuthProvider';
import { TenantProvider } from '../providers/TenantProvider';
import type { Account, Category, Company, DashboardSummary, Transaction } from '../types';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;

export const USD = { id: 'cur-usd', code: 'USD', symbol: '$', decimal_places: 2 };

export function company(id: string, name: string): Company {
  return { id, company_id: id, name, company_name: name, slug: id, status: 'ACTIVE', is_member: true, timezone: 'UTC', currency: USD };
}

export const HOME = company('tenant-home', 'Home');
export const STUDIO = company('tenant-studio', 'Studio');

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-bank', name: 'Everyday checking', type: 'BANK', normal_balance: 'DEBIT', category: 'ASSET',
    is_payment_account: true, is_system: false, is_active: true, institution: '', account_number: '',
    currency_id: USD.id, currency_code: 'USD', currency_symbol: '$', balance_amount: '5000.00', balance_base_amount: '5000.00', notes: '',
    ...overrides,
  };
}

export function category(overrides: Partial<Category> = {}): Category {
  return { id: 'cat-food', name: 'Food', type: 'EXPENSE', parent_id: null, is_active: true, ...overrides };
}

export function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', type: 'EXPENSE', status: 'COMPLETED', occurred_at: '2026-10-05T12:00:00+00:00', reference: '', description: 'Groceries',
    amount: '150.25', currency_code: 'USD', category_id: 'cat-food', category_name: 'Food', contact_id: null, contact_name: null,
    source_account_id: 'acc-bank', source_account_name: 'Everyday checking', destination_account_id: null, destination_account_name: null,
    reverses_transaction_id: null, reversed_by_transaction_id: null, is_reversed: false,
    entries: [
      { id: 'e1', account_id: 'acc-exp', account_name: 'Expenses', account_type: 'EXPENSE', debit_amount: '150.25', credit_amount: '0' },
      { id: 'e2', account_id: 'acc-bank', account_name: 'Everyday checking', account_type: 'BANK', debit_amount: '0', credit_amount: '150.25' },
    ],
    ...overrides,
  };
}

export function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    period: { date_from: '2026-10-01', date_to: '2026-10-11', timezone: 'UTC' },
    currency: USD,
    totals: { assets: '9000.00', liabilities: '1500.00', net_worth: '7500.00', income: '4000.00', expenses: '1000.00', net_cash_flow: '3000.00', savings_rate: 75 },
    accounts: [account()],
    spending_by_category: { total: '1000.00', results: [{ category_id: 'cat-food', category: 'Food', amount: '1000.00', percentage: 100, count: 3 }] },
    income_by_category: { total: '4000.00', results: [{ category_id: 'cat-salary', category: 'Salary', amount: '4000.00', percentage: 100, count: 1 }] },
    cashflow: [{ month: 'Oct 2026', month_start: '2026-10-01', income: '4000.00', expenses: '1000.00', net: '3000.00' }],
    recent_transactions: [transaction()],
    debts: { payable: '0', receivable: '0', active_count: 0 },
    investments: { cost_basis: '0', holding_count: 0 },
    broker: null,
    ...overrides,
  };
}

export const ALL_PERMISSIONS = [
  'dashboard.view', 'accounts.view', 'accounts.create', 'accounts.update', 'transactions.view', 'transactions.create',
  'transactions.post', 'transactions.reverse', 'income.view', 'income.create', 'expenses.view', 'expenses.create',
  'categories.view', 'categories.create', 'categories.update', 'contacts.view', 'debts.view', 'debts.create', 'debts.update',
  'investments.view', 'investments.create', 'investments.update', 'recurring.view', 'recurring.create', 'recurring.update', 'memberships.view',
  'memberships.create', 'memberships.update', 'audit.view', 'settings.update', 'contacts.create', 'contacts.update',
];

export function apiError(status: number, code: string, message: string, fields: Record<string, string> = {}): Reply {
  return { status, body: { error: { code, message, fields } } };
}

/**
 * Install a fake backend. Routes are "METHOD /path" (path relative to /api/v1).
 * Unknown routes fail the test loudly instead of returning something plausible.
 */
export function installApi(routes: Record<string, Handler>, options: { tenant?: Company | null; companies?: Company[]; permissions?: string[] } = {}) {
  const state = { tenant: options.tenant === undefined ? HOME : options.tenant };
  const companies = options.companies ?? [HOME, STUDIO];
  const requests: RecordedRequest[] = [];
  const session = () => ({
    authenticated: true,
    user: { id: 'user-1', username: 'asha', email: 'asha@example.test', first_name: 'Asha', last_name: 'Rao' },
    tenant: state.tenant,
    platform: { is_superuser: false, is_staff: false },
  });
  const defaults: Record<string, Handler> = {
    'GET /auth/csrf/': () => ({ body: { csrf: 'ready' } }),
    'GET /auth/me/': () => ({ body: session() }),
    'GET /auth/companies/': () => ({ body: { companies } }),
    'GET /rbac/effective-permissions/': () => ({ body: { results: (options.permissions ?? ALL_PERMISSIONS).map((code) => ({ code, effect: 'ALLOW' })) } }),
    'POST /auth/switch-tenant/': (request) => {
      const next = companies.find((c) => c.id === (request.body as { company_id: string }).company_id);
      if (!next) return apiError(403, 'FORBIDDEN', 'You are not a member of this workspace, or it does not exist.');
      state.tenant = next;
      return { body: { tenant: next } };
    },
  };
  const table = { ...defaults, ...routes };

  document.cookie = 'csrftoken=test-csrf-token';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const request: RecordedRequest = {
      method, path, query: url.searchParams,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const handler = table[`${method} ${path}`];
    if (!handler) throw new Error(`Unexpected API call in test: ${method} ${path}`);
    const reply = await handler(request);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, calls: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path), state };
}

export function renderWithProviders(ui: ReactElement) {
  return render(
    <AuthProvider>
      <TenantProvider>{ui}</TenantProvider>
    </AuthProvider>
  );
}
