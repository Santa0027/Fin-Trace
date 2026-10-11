/**
 * Shapes returned by the FinTrace API.
 *
 * Money is always a decimal string ("1500.00"); it is formatted for display and
 * never summed in the browser. Totals come from the backend, which derives them
 * from the ledger.
 */

export type IconName =
  | 'home' | 'wallet' | 'swap' | 'repeat' | 'debt' | 'trend' | 'chart' | 'settings' | 'search'
  | 'bell' | 'plus' | 'arrow' | 'sun' | 'moon' | 'chevron' | 'more' | 'calendar' | 'filter'
  | 'download' | 'close' | 'check' | 'building' | 'card' | 'lock' | 'users' | 'plug' | 'income'
  | 'expense' | 'transfer' | 'trash' | 'edit' | 'play' | 'pause' | 'refresh' | 'shield';

export type Money = string;

export interface ListResponse<T> {
  results: T[];
  limit?: number;
  offset?: number;
  total?: number;
}

export interface User {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
}

export interface PlatformInfo {
  is_superuser?: boolean;
  is_staff?: boolean;
}

export interface CurrencyInfo {
  id: string;
  code: string;
  symbol: string;
  decimal_places: number;
}

export interface Company {
  id: string;
  company_id: string;
  name: string;
  company_name: string;
  slug?: string;
  status: string;
  is_member: boolean;
  /** IANA timezone; the workspace's calendar days are days in this zone. */
  timezone: string;
  currency: CurrencyInfo;
}

export interface Session {
  authenticated: boolean;
  user: User;
  tenant: Company | null;
  platform: PlatformInfo;
}

export interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimal_places: number;
}

export type AccountType =
  | 'BANK' | 'CASH' | 'CREDIT_CARD' | 'WALLET' | 'BROKER' | 'INVESTMENT'
  | 'INCOME' | 'EXPENSE' | 'LIABILITY' | 'EQUITY' | 'FOREX' | 'OTHER';

export type AccountCategory = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  normal_balance: 'DEBIT' | 'CREDIT';
  /** What the account is, in plain terms. Decided by the backend. */
  category: AccountCategory;
  /** True for accounts a person can pay from or receive into. */
  is_payment_account: boolean;
  is_system: boolean;
  is_active: boolean;
  institution: string;
  account_number: string;
  currency_id: string;
  currency_code: string;
  currency_symbol: string;
  /** In the account's own currency; positive means "has" for assets and "owes" for liabilities. */
  balance_amount: Money;
  /** The same balance in the workspace's base currency. */
  balance_base_amount: Money;
  notes: string;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Category {
  id: string;
  name: string;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'OTHER';
  parent_id: string | null;
  is_active: boolean;
  archived_at?: string | null;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string;
  status: 'ACTIVE' | 'ARCHIVED';
  created_at?: string;
}

export type TransactionType =
  | 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'REVERSAL' | 'DEBT_PAYMENT'
  | 'INVESTMENT_BUY' | 'INVESTMENT_SELL' | 'DIVIDEND' | 'JOURNAL';

export interface TransactionEntry {
  id: string;
  account_id: string;
  account_name: string;
  account_type: AccountType;
  debit_amount: Money;
  credit_amount: Money;
}

export interface Transaction {
  id: string;
  /** Classified by the backend from the ledger; the client never guesses. */
  type: TransactionType;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  occurred_at: string;
  reference: string;
  description: string;
  amount: Money;
  currency_code: string | null;
  category_id: string | null;
  category_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  /** Where the money left from / arrived at (never an internal income or expense account). */
  source_account_id: string | null;
  source_account_name: string | null;
  destination_account_id: string | null;
  destination_account_name: string | null;
  reverses_transaction_id: string | null;
  reversed_by_transaction_id: string | null;
  is_reversed: boolean;
  entries: TransactionEntry[];
  created_at?: string;
}

/** An income or expense record. */
export interface FinancialRecord {
  id: string;
  ledger_transaction_id: string;
  amount: Money;
  currency_code: string;
  category_id: string;
  category_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  account_id: string | null;
  account_name: string | null;
  occurred_on: string;
  reference: string;
  description: string;
  notes: string;
  status: string;
  is_reversed: boolean;
}

export interface Debt {
  id: string;
  /** PAYABLE: money you owe. RECEIVABLE: money owed to you. */
  type: 'PAYABLE' | 'RECEIVABLE';
  contact_id: string;
  contact_name: string | null;
  principal_amount: Money;
  repaid_principal: Money;
  outstanding_principal: Money;
  interest_paid: Money;
  interest_rate: string;
  currency_id: string;
  currency_code: string;
  start_date: string;
  due_date: string | null;
  status: 'ACTIVE' | 'PAID' | 'DEFAULTED';
  notes: string;
  repayment_count: number;
  last_repaid_on: string | null;
}

export interface DebtRepayment {
  id: string;
  debt_id: string;
  ledger_transaction_id: string;
  principal_amount: Money;
  interest_amount: Money;
  total_amount: Money;
  repaid_on: string;
  notes: string;
  /** Its ledger entry was reversed; it no longer counts towards the loan. */
  is_reversed: boolean;
}

export interface Holding {
  position_id: string;
  portfolio_id: string;
  portfolio_name: string;
  instrument_id: string;
  symbol: string;
  instrument_name: string;
  instrument_type: string;
  quantity: string;
  average_cost: string;
  /** Quantity × average cost. FinTrace does not have market prices. */
  cost_value: Money;
  currency_code: string;
}

export interface Trade {
  id: string;
  instrument_id: string;
  symbol: string;
  instrument_name: string;
  ledger_transaction_id: string;
  trade_type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: Money;
  gross_amount: Money;
  realized_pnl: Money;
  traded_at: string;
  cash_account_id: string;
  cash_account_name: string | null;
  currency_code: string;
}

export interface Dividend {
  id: string;
  instrument_id: string;
  symbol: string;
  instrument_name: string;
  ledger_transaction_id: string;
  amount: Money;
  currency_code: string;
  paid_on: string;
  cash_account_id: string;
  cash_account_name: string | null;
  notes: string;
  is_reversed: boolean;
}

export type RecurringFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RecurringTransaction {
  id: string;
  transaction_type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  description: string;
  amount: Money;
  currency_id: string;
  currency_code: string;
  frequency: RecurringFrequency;
  source_account_id: string | null;
  source_account_name: string | null;
  destination_account_id: string | null;
  destination_account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  start_date: string;
  end_date: string | null;
  next_run_at: string;
  is_active: boolean;
  last_scheduled_for: string | null;
  last_status: 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'PENDING' | 'PROCESSING' | null;
}

export interface RecurringRunResult {
  id: string;
  action: 'post' | 'skip';
  scheduled_for: string;
  ledger_transaction_id: string | null;
  next_run_at: string | null;
  is_active: boolean;
}

export interface Member {
  id: string;
  user_id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  joined_at: string | null;
  is_owner: boolean;
  /** ADMIN, MEMBER or VIEWER */
  role_codes: string[];
  roles: string[];
}

export type MemberRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface ActivityEvent {
  id: string;
  occurred_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string;
  actor_name: string | null;
  actor_username: string | null;
}

export interface CategoryTotal {
  category_id: string | null;
  category: string;
  amount: Money;
  percentage: number;
  count: number;
}

export interface CategoryBreakdown {
  total: Money;
  results: CategoryTotal[];
  date_from?: string;
  date_to?: string;
}

export interface CashflowPoint {
  month: string;
  month_start: string;
  income: Money;
  expenses: Money;
  net: Money;
}

export interface DashboardSummary {
  period: { date_from: string; date_to: string; timezone: string };
  currency: CurrencyInfo;
  totals: {
    assets: Money;
    liabilities: Money;
    net_worth: Money;
    /** Combined net worth including connected broker market value. */
    net_worth_with_broker?: Money;
    /** Combined assets including connected broker market value. */
    assets_with_broker?: Money;
    /** Current market value of connected broker holdings. */
    broker_current?: Money;
    /** Invested cost basis of connected broker holdings. */
    broker_invested?: Money;
    income: Money;
    expenses: Money;
    net_cash_flow: Money;
    /** Percent of income kept; null when there was no income in the period. */
    savings_rate: number | null;
  };
  accounts: Account[];
  spending_by_category: CategoryBreakdown;
  income_by_category: CategoryBreakdown;
  cashflow: CashflowPoint[];
  recent_transactions: Transaction[];
  debts: { payable: Money; receivable: Money; active_count: number };
  investments: { cost_basis: Money; holding_count: number };
  /** Connected broker portfolio at a glance. */
  broker: BrokerHeadline | null;
}

export interface BrokerHeadline {
  provider: 'ZERODHA';
  status: BrokerConnection['status'];
  currency: string;
  last_synced_at: string | null;
  holding_count: number;
  invested_value: Money;
  current_value: Money;
  pnl: Money;
  pnl_percent: number | null;
  day_change: Money | null;
  day_change_percent: number | null;
  combined_assets?: Money;
  combined_net_worth?: Money;
}

export interface PermissionRow {
  code: string;
  effect: 'ALLOW' | 'DENY';
}

/** What a money-changing endpoint returns. */
export interface PostedResult {
  id: string;
  ledger_transaction_id: string;
}

export interface BrokerConnection {
  id: string;
  provider: 'ZERODHA';
  /** SAMPLE marks demo data that did not come from Zerodha. */
  status: 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED' | 'SAMPLE';
  broker_user_id: string;
  broker_user_name: string;
  token_expires_at: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_error: string;
  /** Uninvested funds in the trading account; null if Zerodha did not report it. */
  cash_available: Money | null;
}

export interface BrokerHolding {
  id: string;
  asset_class: 'EQUITY' | 'MUTUAL_FUND';
  symbol: string;
  name: string;
  exchange: string;
  isin: string;
  folio: string;
  quantity: string;
  average_price: string;
  last_price: string;
  invested_value: Money;
  current_value: Money;
  pnl: Money;
  pnl_percent: number | null;
  /** Stocks and ETFs only; funds have no intraday change. */
  day_change: Money | null;
  day_change_percent: number | null;
  allocation_percent: number;
}

export interface BrokerClassTotal {
  asset_class: 'EQUITY' | 'MUTUAL_FUND';
  label: string;
  holding_count: number;
  invested_value: Money;
  current_value: Money;
  pnl: Money;
  pnl_percent: number | null;
  allocation_percent: number;
}

export interface BrokerMover {
  symbol: string;
  name: string;
  pnl: Money;
  pnl_percent: number;
}

export interface BrokerPortfolio {
  provider: 'ZERODHA';
  /** Whether the server has Zerodha API credentials at all. */
  configured: boolean;
  currency: string;
  connection: BrokerConnection | null;
  summary?: {
    holding_count: number;
    invested_value: Money;
    current_value: Money;
    pnl: Money;
    pnl_percent: number | null;
    day_change: Money | null;
    day_change_percent: number | null;
  };
  by_class?: BrokerClassTotal[];
  top_gainers?: BrokerMover[];
  top_losers?: BrokerMover[];
  holdings?: BrokerHolding[];
  history?: { snapshot_date: string; invested_value: Money; current_value: Money }[];
}

export interface BrokerPeriod {
  code: '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | 'ALL';
  label: string;
  /** False until FinTrace has a sync old enough to compare with. */
  available: boolean;
  from_date?: string;
  value_then?: Money;
  value_change?: Money;
  /** Money added (or withdrawn, if negative) in the period. */
  net_invested?: Money;
  /** Change in value not explained by money added or withdrawn. */
  market_movement?: Money;
  market_movement_percent?: number | null;
}

export interface BrokerSip {
  sip_id: string;
  fund: string;
  symbol: string;
  status: string;
  frequency: string;
  instalment_amount: Money;
  instalment_day: number | null;
  next_instalment: string | null;
  completed_instalments: number;
  /** -1: runs until cancelled */
  pending_instalments: number;
}

export interface BrokerPosition {
  symbol: string;
  exchange: string;
  product: string;
  quantity: string;
  average_price: string;
  last_price: string;
  pnl: Money;
}

export interface BrokerAnalysis {
  as_of: string | null;
  totals: { holdings_value: Money; cash_available: Money | null; total_with_cash: Money | null; open_positions_pnl: Money | null };
  concentration: {
    largest: { symbol: string; name: string; allocation_percent: number };
    top_3_percent: number;
    top_5_percent: number;
    /** How many equal-sized holdings would be this concentrated. */
    effective_holdings: number;
    holding_count: number;
  };
  performance: { winners: number; losers: number; unchanged: number; gains: Money; losses: Money };
  periods: BrokerPeriod[];
  holding_changes: {
    from_date: string | null;
    rows: { symbol: string; name: string; asset_class: string; is_new: boolean; value_then: Money | null; value_now: Money; market_movement: Money | null; market_movement_percent: number | null }[];
  };
  sips: { active_count: number; monthly_commitment: Money; yearly_commitment: Money; rows: BrokerSip[] };
  positions: BrokerPosition[];
  insights: { tone: 'good' | 'warn' | 'info'; text: string }[];
}

export interface BrokerAnalytics extends BrokerPortfolio {
  analysis: BrokerAnalysis | null;
}
