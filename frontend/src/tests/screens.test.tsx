import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoriesPage } from '../pages/CategoriesPage';
import { ContactsPage } from '../pages/ContactsPage';
import { DebtsPage } from '../pages/DebtsPage';
import { InvestmentsPage } from '../pages/InvestmentsPage';
import { RecurringPage } from '../pages/RecurringPage';
import { ReportsPage } from '../pages/ReportsPage';
import { DashboardPage } from '../pages/DashboardPage';
import { SettingsPage } from '../pages/SettingsPage';
import { TransactionDrawer } from '../components/modals/TransactionDrawer';
import { ALL_PERMISSIONS, account, apiError, category, installApi, renderWithProviders, summary } from './harness';
import type { BrokerAnalytics, BrokerPortfolio, Debt, Holding, Member, RecurringTransaction } from '../types';

const noop = () => undefined;
const accounts = { 'GET /accounts/': () => ({ body: { results: [account(), account({ id: 'acc-savings', name: 'Savings', balance_amount: '0.00' })] } }) };

describe('categories', () => {
  it('lists, adds, and archives with confirmation; never mentions ledger accounts', async () => {
    const user = userEvent.setup();
    const rows = [category(), category({ id: 'cat-old', name: 'Old', is_active: false }), category({ id: 'cat-salary', name: 'Salary', type: 'INCOME' })];
    const api = installApi({
      'GET /categories/': () => ({ body: { results: rows } }),
      'POST /categories/': (request) => ({ status: 201, body: { ...category({ id: 'cat-new' }), ...(request.body as object) } }),
      'POST /categories/cat-food/archive/': () => ({ body: { status: 'archived', id: 'cat-food' } }),
    });
    renderWithProviders(<CategoriesPage />);
    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    expect(screen.queryByText(/ledger|maps to/i)).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Archived categories' })).getByText('Old')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add expense category' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a category name.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Category name'), 'Transport');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls('POST', '/categories/')).toHaveLength(1));
    expect(api.calls('POST', '/categories/')[0].body).toEqual({ name: 'Transport', type: 'EXPENSE' });

    await user.click(screen.getByRole('button', { name: 'Archive Food' }));
    expect(api.calls('POST', '/categories/cat-food/archive/')).toHaveLength(0);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.calls('POST', '/categories/cat-food/archive/')).toHaveLength(1));
  });

  it('shows the duplicate-name message from the backend next to the field', async () => {
    const user = userEvent.setup();
    installApi({ 'GET /categories/': () => ({ body: { results: [] } }), 'POST /categories/': () => apiError(409, 'CONFLICT', 'A category with this name already exists.') });
    renderWithProviders(<CategoriesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add expense category' }));
    await user.type(screen.getByLabelText('Category name'), 'Food');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A category with this name already exists.')).toBeInTheDocument();
  });
});

describe('contacts', () => {
  it('creates a contact with only the fields the backend stores', async () => {
    const user = userEvent.setup();
    const api = installApi({ 'GET /contacts/': () => ({ body: { results: [] } }), 'POST /contacts/': () => ({ status: 201, body: { id: 'c1' } }) });
    renderWithProviders(<ContactsPage />);
    await user.click(await screen.findByRole('button', { name: 'Add contact', hidden: false }));
    await user.type(screen.getByLabelText('Name'), 'Acme Ltd');
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls('POST', '/contacts/')).toHaveLength(1));
    expect(api.calls('POST', '/contacts/')[0].body).toEqual({ name: 'Acme Ltd', email: null, phone: null, notes: '' });
  });
});

const debt: Debt = {
  id: 'debt-1', type: 'PAYABLE', contact_id: 'c1', contact_name: 'City Bank', principal_amount: '1000.00', repaid_principal: '400.00',
  outstanding_principal: '600.00', interest_paid: '25.00', interest_rate: '8.5000', currency_id: 'cur-usd', currency_code: 'USD',
  start_date: '2026-01-10', due_date: null, status: 'ACTIVE', notes: '', repayment_count: 1, last_repaid_on: '2026-09-10',
};

describe('loans', () => {
  it('shows the outstanding amount from the backend and records a repayment split into principal and interest', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...accounts,
      'GET /debts/': () => ({ body: { results: [debt] } }),
      'POST /debts/debt-1/repayments/': () => ({ status: 201, body: { id: 'r1', ledger_transaction_id: 't1', outstanding_principal: '500', status: 'ACTIVE' } }),
    });
    renderWithProviders(<DebtsPage />);
    expect(await screen.findByText('City Bank')).toBeInTheDocument();
    expect(screen.getByText('$600.00')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '40% repaid' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record repayment' }));
    await screen.findByRole('option', { name: /Everyday checking/ });
    await user.type(screen.getByLabelText('Principal amount'), '700');
    await user.selectOptions(screen.getByLabelText('Paid from'), 'acc-bank');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record repayment' }));
    expect(await screen.findByText(/only \$600\.00 is still outstanding/i)).toBeInTheDocument();
    expect(api.calls('POST', '/debts/debt-1/repayments/')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Principal amount'));
    await user.type(screen.getByLabelText('Principal amount'), '100');
    await user.type(screen.getByLabelText('Interest amount'), '7.50');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record repayment' }));
    await waitFor(() => expect(api.calls('POST', '/debts/debt-1/repayments/')).toHaveLength(1));
    const [request] = api.calls('POST', '/debts/debt-1/repayments/');
    expect(request.body).toMatchObject({ account_id: 'acc-bank', principal_amount: '100', interest_amount: '7.50' });
    expect(request.headers['Idempotency-Key']).toMatch(/^debt-repayment-/);
  });

  it('adds a loan in plain terms: who, how much, and where the money went', async () => {
    const user = userEvent.setup();
    const api = installApi({ ...accounts, 'GET /debts/': () => ({ body: { results: [] } }), 'GET /contacts/': () => ({ body: { results: [] } }), 'POST /debts/': () => ({ status: 201, body: { id: 'd2', ledger_transaction_id: 't2' } }) });
    renderWithProviders(<DebtsPage />);
    await user.click((await screen.findAllByRole('button', { name: 'Add loan' }))[0]);
    expect(screen.getByText(/borrowing is not income/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Borrowed from'), 'City Bank');
    await user.type(screen.getByLabelText('Loan amount'), '2500');
    await user.selectOptions(await screen.findByLabelText('Money was received into'), 'acc-bank');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add loan' }));
    await waitFor(() => expect(api.calls('POST', '/debts/')).toHaveLength(1));
    expect(api.calls('POST', '/debts/')[0].body).toMatchObject({ type: 'PAYABLE', contact_name: 'City Bank', principal_amount: '2500', account_id: 'acc-bank' });
    expect(api.calls('POST', '/debts/')[0].headers['Idempotency-Key']).toBeTruthy();
  });
});

const holding: Holding = {
  position_id: 'p1', portfolio_id: 'pf1', portfolio_name: 'Main portfolio', instrument_id: 'i1', symbol: 'VTI', instrument_name: 'Total Market ETF',
  instrument_type: 'ETF', quantity: '10.00000000', average_cost: '100.500000', cost_value: '1005.00', currency_code: 'USD',
};

const noBroker = { 'GET /integrations/zerodha/portfolio/': () => ({ body: { provider: 'ZERODHA', configured: true, currency: 'INR', connection: null } }) };

const brokerPortfolio: BrokerPortfolio = {
  provider: 'ZERODHA', configured: true, currency: 'INR',
  connection: { id: 'bc1', provider: 'ZERODHA', status: 'CONNECTED', broker_user_id: 'AB1234', broker_user_name: 'Asha Rao', token_expires_at: '2099-01-01T00:30:00Z', connected_at: '2026-10-11T04:00:00Z', last_synced_at: '2026-10-11T04:00:05Z', last_error: '', cash_available: '15250.75' },
  summary: { holding_count: 2, invested_value: '22313.67', current_value: '25490.09', pnl: '3176.42', pnl_percent: 14.24, day_change: '244.20', day_change_percent: 1.36 },
  by_class: [
    { asset_class: 'EQUITY', label: 'Stocks and ETFs (Kite)', holding_count: 1, invested_value: '16801.20', current_value: '18244.20', pnl: '1443.00', pnl_percent: 8.59, allocation_percent: 71.57 },
    { asset_class: 'MUTUAL_FUND', label: 'Mutual funds (Coin)', holding_count: 1, invested_value: '5512.47', current_value: '7245.89', pnl: '1733.42', pnl_percent: 31.45, allocation_percent: 28.43 },
  ],
  top_gainers: [{ symbol: 'INF879O01027', name: 'Parag Parikh Flexi Cap Fund', pnl: '1733.42', pnl_percent: 31.45 }],
  top_losers: [],
  holdings: [
    { id: 'h1', asset_class: 'EQUITY', symbol: 'INFY', name: '', exchange: 'NSE', isin: 'INE009A01021', folio: '', quantity: '12.000000', average_price: '1400.100000', last_price: '1520.350000', invested_value: '16801.20', current_value: '18244.20', pnl: '1443.00', pnl_percent: 8.59, day_change: '244.20', day_change_percent: 1.36, allocation_percent: 71.57 },
    { id: 'h2', asset_class: 'MUTUAL_FUND', symbol: 'INF879O01027', name: 'Parag Parikh Flexi Cap Fund', exchange: '', isin: 'INF879O01027', folio: '123456/78', quantity: '100.003000', average_price: '55.123000', last_price: '72.456700', invested_value: '5512.47', current_value: '7245.89', pnl: '1733.42', pnl_percent: 31.45, day_change: null, day_change_percent: null, allocation_percent: 28.43 },
  ],
  history: [{ snapshot_date: '2026-10-10', invested_value: '22313.67', current_value: '25100.00' }, { snapshot_date: '2026-10-11', invested_value: '22313.67', current_value: '25490.09' }],
};

describe('zerodha portfolio', () => {
  it('shows the backend metrics and both Kite and Coin holdings, in rupees, without recomputing them', async () => {
    installApi({ 'GET /integrations/zerodha/portfolio/': () => ({ body: brokerPortfolio }) });
    renderWithProviders(<InvestmentsPage />);
    const summary = await screen.findByRole('region', { name: 'Portfolio summary' });
    expect(within(summary).getByText(/25,490\.09/)).toBeInTheDocument();
    expect(within(summary).getByText(/\+₹3,176\.42/)).toBeInTheDocument();
    expect(within(summary).getByText('+14.24%')).toBeInTheDocument();
    const stocks = screen.getByRole('region', { name: 'Stocks and ETFs' });
    expect(within(stocks).getByText('INFY')).toBeInTheDocument();
    expect(within(stocks).getByText('From Kite')).toBeInTheDocument();
    const funds = screen.getByRole('region', { name: 'Mutual funds' });
    expect(within(funds).getByText('Parag Parikh Flexi Cap Fund')).toBeInTheDocument();
    expect(within(funds).getByText('Folio 123456/78')).toBeInTheDocument();
    expect(within(funds).queryByText('Today')).not.toBeInTheDocument(); // funds have no intraday change
    expect(screen.getByRole('img', { name: /value went from/i })).toBeInTheDocument();
    expect(screen.getByText(/not added to your FinTrace accounts, net worth or reports/i)).toBeInTheDocument();
  });

  it('offers to connect, explains it is read-only, and sends the browser to Zerodha', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const api = installApi({ ...noBroker, 'POST /integrations/zerodha/connect/': () => ({ body: { login_url: 'https://kite.zerodha.com/connect/login?v=3&api_key=k' } }) });
    renderWithProviders(<InvestmentsPage />);
    expect(await screen.findByText(/cannot place orders or move money/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect Zerodha' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://kite.zerodha.com/connect/login?v=3&api_key=k'));
    expect(api.calls('POST', '/integrations/zerodha/connect/')).toHaveLength(1);
  });

  it('says so when the server has no Zerodha credentials, instead of offering a button that cannot work', async () => {
    installApi({ 'GET /integrations/zerodha/portfolio/': () => ({ body: { provider: 'ZERODHA', configured: false, currency: 'INR', connection: null } }) });
    renderWithProviders(<InvestmentsPage />);
    expect(await screen.findByText(/no Zerodha API credentials yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Zerodha' })).not.toBeInTheDocument();
  });

  it('keeps the last figures and asks to reconnect when the daily session has ended', async () => {
    const user = userEvent.setup();
    let current = brokerPortfolio;
    installApi({
      'GET /integrations/zerodha/portfolio/': () => ({ body: current }),
      'POST /integrations/zerodha/sync/': () => {
        current = { ...brokerPortfolio, connection: { ...brokerPortfolio.connection!, status: 'EXPIRED' } };
        return apiError(409, 'BROKER_SESSION_EXPIRED', 'Your Zerodha session has ended (Zerodha signs every app out each morning). Reconnect to refresh.');
      },
    });
    renderWithProviders(<InvestmentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getAllByText(/session has ended/i).length).toBeGreaterThan(0);
    expect(within(screen.getByRole('region', { name: 'Portfolio summary' })).getByText(/25,490\.09/)).toBeInTheDocument();
  });

  it('labels demo data as a sample and hides controls from read-only members', async () => {
    installApi({ 'GET /integrations/zerodha/portfolio/': () => ({ body: { ...brokerPortfolio, connection: { ...brokerPortfolio.connection!, status: 'SAMPLE' } } }) },
      { permissions: ALL_PERMISSIONS.filter((p) => p !== 'investments.update') });
    renderWithProviders(<InvestmentsPage />);
    expect(await screen.findByText(/sample data from the demo seed, not a real Zerodha account/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh|connect/i })).not.toBeInTheDocument();
  });
});

const brokerAnalytics: BrokerAnalytics = {
  ...brokerPortfolio,
  analysis: {
    as_of: '2026-10-11T04:00:05Z',
    totals: { holdings_value: '25490.09', cash_available: '15250.75', total_with_cash: '40740.84', open_positions_pnl: '2975.00' },
    concentration: { largest: { symbol: 'INFY', name: '', allocation_percent: 71.57 }, top_3_percent: 100, top_5_percent: 100, effective_holdings: 1.7, holding_count: 2 },
    performance: { winners: 2, losers: 0, unchanged: 0, gains: '3176.42', losses: '0' },
    periods: [
      { code: '1D', label: 'Since yesterday', available: false },
      { code: '1W', label: '1 week', available: true, from_date: '2026-10-04', value_then: '24000.00', value_change: '1490.09', net_invested: '1000.00', market_movement: '490.09', market_movement_percent: 2.04 },
    ],
    holding_changes: { from_date: '2026-10-04', rows: [
      { symbol: 'INFY', name: '', asset_class: 'EQUITY', is_new: false, value_then: '17800.00', value_now: '18244.20', market_movement: '444.20', market_movement_percent: 2.5 },
      { symbol: 'INF879O01027', name: 'Parag Parikh Flexi Cap Fund', asset_class: 'MUTUAL_FUND', is_new: true, value_then: null, value_now: '7245.89', market_movement: null, market_movement_percent: null },
    ] },
    sips: { active_count: 1, monthly_commitment: '5000.00', yearly_commitment: '60000.00', rows: [
      { sip_id: 'S1', fund: 'Parag Parikh Flexi Cap Fund', symbol: 'INF879O01027', status: 'ACTIVE', frequency: 'monthly', instalment_amount: '5000.00', instalment_day: 5, next_instalment: '2026-11-05', completed_instalments: 14, pending_instalments: -1 },
    ] },
    positions: [{ symbol: 'NIFTY26OCTFUT', exchange: 'NFO', product: 'NRML', quantity: '50.000000', average_price: '24850.500000', last_price: '24910.000000', pnl: '2975.00' }],
    insights: [{ tone: 'warn', text: 'INFY alone is 71.6% of the portfolio. A fall in it moves everything.' }, { tone: 'info', text: '1 active SIP invests about 5,000.00 a month, 60,000.00 a year.' }],
  },
};

describe('zerodha analysis', () => {
  it('shows concentration, change over time, SIPs, positions and observations from the backend', async () => {
    const user = userEvent.setup();
    installApi({ 'GET /integrations/zerodha/portfolio/': () => ({ body: brokerPortfolio }), 'GET /integrations/zerodha/analytics/': () => ({ body: brokerAnalytics }) });
    renderWithProviders(<InvestmentsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Analysis, SIPs and positions' }));

    expect(await screen.findByText('INFY alone is 71.6% of the portfolio. A fall in it moves everything.')).toBeInTheDocument();
    const periods = screen.getByRole('region', { name: 'Change over time' });
    expect(within(periods).getByText('1 week')).toBeInTheDocument();
    expect(within(periods).queryByText('Since yesterday')).not.toBeInTheDocument(); // nothing to compare with yet
    expect(within(periods).getByText(/\+₹490\.09/)).toBeInTheDocument();
    expect(within(periods).getByText('+2.04%')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Totals' })).getByText(/40,740\.84/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Concentration' })).getByText(/1\.7 equal holdings \(you have 2\)/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Movement by holding' })).getByText('New')).toBeInTheDocument();
    const sips = screen.getByRole('region', { name: 'SIPs' });
    expect(within(sips).getByText(/14 paid, runs until cancelled/)).toBeInTheDocument();
    expect(within(sips).getByText(/60,000\.00 a year across 1 active/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Open positions' })).getByText('NIFTY26OCTFUT')).toBeInTheDocument();
  });

  it('exports the holdings exactly as the backend reported them', async () => {
    const user = userEvent.setup();
    let csv = '';
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { const reader = new FileReader(); reader.onload = () => { csv = String(reader.result); }; reader.readAsText(blob); return 'blob:x'; }, revokeObjectURL: () => undefined }));
    installApi({ 'GET /dashboard/summary/': () => ({ body: summary() }), 'GET /integrations/zerodha/analytics/': () => ({ body: brokerAnalytics }) });
    renderWithProviders(<ReportsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Zerodha portfolio' }));
    await user.click(await screen.findByRole('button', { name: 'Export holdings (CSV)' }));
    await waitFor(() => expect(csv).toContain('"INFY"'));
    expect(csv).toContain('"18244.20"');
    expect(csv).toContain('"Mutual fund (Coin)","INF879O01027","Parag Parikh Flexi Cap Fund"');
    expect(csv.trim().split('\n').at(-1)).toContain('"Total"');
  });

  it('says there is nothing to analyse when no account is connected', async () => {
    installApi({ 'GET /dashboard/summary/': () => ({ body: summary() }), 'GET /integrations/zerodha/analytics/': () => ({ body: { provider: 'ZERODHA', configured: true, currency: 'INR', connection: null, analysis: null } }) });
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Zerodha portfolio' }));
    expect(await screen.findByText(/no Zerodha portfolio to analyse yet/i)).toBeInTheDocument();
  });

  it('puts the portfolio on the dashboard for reference, outside net worth', async () => {
    const noop = () => undefined;
    installApi({ 'GET /dashboard/summary/': () => ({ body: summary({ broker: { provider: 'ZERODHA', status: 'CONNECTED', currency: 'INR', last_synced_at: '2026-10-11T04:00:05Z', holding_count: 2, invested_value: '22313.67', current_value: '25490.09', pnl: '3176.42', pnl_percent: 14.24, day_change: '244.20', day_change_percent: 1.36 } }) }) });
    renderWithProviders(<DashboardPage setPage={noop} openExpense={noop} openIncome={noop} openChooser={noop} />);
    const card = await screen.findByRole('region', { name: 'Zerodha portfolio' });
    expect(within(card).getByText(/25,490\.09/)).toBeInTheDocument();
    expect(within(card).getByText(/not included in net worth/i)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Net worth' })).getByText('$7,500.00')).toBeInTheDocument(); // unchanged by the broker figures
  });

  it('toggles Zerodha portfolio inclusion in combined net worth', async () => {
    const user = userEvent.setup();
    const noop = () => undefined;
    installApi({
      'GET /dashboard/summary/': () => ({
        body: summary({
          totals: {
            assets: '9000.00',
            liabilities: '1500.00',
            net_worth: '7500.00',
            net_worth_with_broker: '32990.09',
            assets_with_broker: '34490.09',
            broker_current: '25490.09',
            broker_invested: '22313.67',
            income: '4000.00',
            expenses: '1000.00',
            net_cash_flow: '3000.00',
            savings_rate: 75,
          },
          broker: {
            provider: 'ZERODHA',
            status: 'CONNECTED',
            currency: 'INR',
            last_synced_at: '2026-10-11T04:00:05Z',
            holding_count: 2,
            invested_value: '22313.67',
            current_value: '25490.09',
            pnl: '3176.42',
            pnl_percent: 14.24,
            day_change: '244.20',
            day_change_percent: 1.36,
          },
        }),
      }),
    });
    renderWithProviders(<DashboardPage setPage={noop} openExpense={noop} openIncome={noop} openChooser={noop} />);
    const netWorthRegion = await screen.findByRole('region', { name: 'Net worth' });
    expect(within(netWorthRegion).getByText('$7,500.00')).toBeInTheDocument();

    const toggle = screen.getByRole('switch', { name: /include zerodha in net worth/i });
    await user.click(toggle);

    expect(within(netWorthRegion).getByText('$32,990.09')).toBeInTheDocument();
    expect(within(netWorthRegion).getByText(/combined net worth/i)).toBeInTheDocument();

    const brokerCard = screen.getByRole('region', { name: 'Zerodha portfolio' });
    expect(within(brokerCard).getByText(/included in combined net worth/i)).toBeInTheDocument();
  });
});

describe('investments', () => {
  it('shows holdings at cost, with no invented market price or gain', async () => {
    const user = userEvent.setup();
    installApi({ ...noBroker, 'GET /reports/investment-position-summary/': () => ({ body: { results: [holding] } }), 'GET /investments/trades/': () => ({ body: { results: [] } }), 'GET /investments/dividends/': () => ({ body: { results: [] } }) });
    renderWithProviders(<InvestmentsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Recorded in FinTrace' }));
    expect(await screen.findByText('VTI')).toBeInTheDocument();
    expect(screen.getByText('$1,005.00')).toBeInTheDocument();
    expect(screen.getByText(/shown at what you paid/i)).toBeInTheDocument();
    expect(screen.queryByText(/market value|unrealized|current price/i)).not.toBeInTheDocument();
  });

  it('records a sale and refuses to sell more than is held', async () => {
    const user = userEvent.setup();
    const api = installApi({
      ...accounts,
      ...noBroker,
      'GET /reports/investment-position-summary/': () => ({ body: { results: [holding] } }),
      'GET /investments/trades/': () => ({ body: { results: [] } }),
      'GET /investments/dividends/': () => ({ body: { results: [] } }),
      'POST /investments/trades/': () => ({ status: 201, body: { id: 'tr1', ledger_transaction_id: 't3' } }),
    });
    renderWithProviders(<InvestmentsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Recorded in FinTrace' }));
    await user.click(await screen.findByRole('button', { name: 'Record trade' }));
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.selectOptions(screen.getByLabelText('Investment to sell'), 'VTI');
    await user.type(screen.getByLabelText('Quantity'), '11');
    await user.type(screen.getByLabelText('Price each'), '120');
    await user.selectOptions(await screen.findByLabelText('Proceeds received into'), 'acc-bank');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));
    expect(await screen.findByText('You hold 10 VTI.')).toBeInTheDocument();
    expect(api.calls('POST', '/investments/trades/')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '4');
    await user.click(screen.getByRole('button', { name: 'Record sale' }));
    await waitFor(() => expect(api.calls('POST', '/investments/trades/')).toHaveLength(1));
    expect(api.calls('POST', '/investments/trades/')[0].body).toMatchObject({ trade_type: 'SELL', symbol: 'VTI', quantity: '4', price: '120', settlement_account_id: 'acc-bank' });
  });
});

const rent: RecurringTransaction = {
  id: 'rec-1', transaction_type: 'EXPENSE', description: 'Rent', amount: '1200.00', currency_id: 'cur-usd', currency_code: 'USD', frequency: 'MONTHLY',
  source_account_id: 'acc-bank', source_account_name: 'Everyday checking', destination_account_id: null, destination_account_name: null,
  category_id: 'cat-rent', category_name: 'Rent', start_date: '2020-01-01', end_date: null, next_run_at: '2020-01-01', is_active: true,
  last_scheduled_for: null, last_status: null,
};

describe('recurring', () => {
  it('records a due item once, however many times the button is pressed while it is in flight', async () => {
    const user = userEvent.setup();
    let finish: (reply: { status: number; body: unknown }) => void = noop;
    const api = installApi({
      'GET /recurring-transactions/': () => ({ body: { results: [rent] } }),
      'POST /recurring-transactions/rec-1/run/': () => new Promise((resolve) => { finish = resolve; }),
    });
    renderWithProviders(<RecurringPage />);
    expect(await screen.findByText(/Everyday checking · Rent/)).toBeInTheDocument();
    expect(screen.getByText(/^Due /)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Record Rent now' });
    await user.click(button);
    await user.click(button);
    expect(api.calls('POST', '/recurring-transactions/rec-1/run/')).toHaveLength(1);
    const [request] = api.calls('POST', '/recurring-transactions/rec-1/run/');
    expect(request.body).toEqual({ action: 'post' });
    expect(request.headers['Idempotency-Key']).toMatch(/^recurring-/);
    finish({ status: 201, body: { id: 'rec-1', action: 'post', scheduled_for: '2020-01-01', ledger_transaction_id: 't9', next_run_at: '2020-02-01', is_active: true } });
    expect(await screen.findByRole('status')).toHaveTextContent(/Rent recorded for .*Next:/);
  });

  it('can skip a due item, and explains a refusal from the backend', async () => {
    const user = userEvent.setup();
    const replies = [apiError(400, 'CATEGORY_REQUIRED', 'Choose a category for this recurring item before posting it.'), { status: 201, body: { id: 'rec-1', action: 'skip', scheduled_for: '2020-01-01', ledger_transaction_id: null, next_run_at: '2020-02-01', is_active: true } }];
    const api = installApi({ 'GET /recurring-transactions/': () => ({ body: { results: [rent] } }), 'POST /recurring-transactions/rec-1/run/': () => replies.shift() as never });
    renderWithProviders(<RecurringPage />);
    await user.click(await screen.findByRole('button', { name: 'Record Rent now' }));
    expect(await screen.findByText(/Rent: Choose a category for this recurring item/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip Rent this time' }));
    await waitFor(() => expect(api.calls('POST', '/recurring-transactions/rec-1/run/')).toHaveLength(2));
    expect(api.calls('POST', '/recurring-transactions/rec-1/run/')[1].body).toEqual({ action: 'skip' });
    expect(await screen.findByRole('status')).toHaveTextContent(/skipped/);
  });
});

describe('reports', () => {
  it('uses the same endpoint as the dashboard and shows its totals unchanged', async () => {
    const user = userEvent.setup();
    const api = installApi({ 'GET /dashboard/summary/': () => ({ body: summary() }) });
    renderWithProviders(<ReportsPage />);
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('$3,000.00')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Spending' }));
    expect(within(screen.getByRole('table')).getAllByText('$1,000.00')).toHaveLength(2); // the row and the backend total
    await user.click(screen.getByRole('tab', { name: 'Net worth' }));
    expect(screen.getByText('$7,500.00')).toBeInTheDocument();
    expect(new Set(api.requests.filter((r) => !r.path.startsWith('/auth') && !r.path.startsWith('/rbac')).map((r) => r.path))).toEqual(new Set(['/dashboard/summary/']));
  });

  it('reports a failure instead of an empty report', async () => {
    installApi({ 'GET /dashboard/summary/': () => apiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Please try again.') });
    renderWithProviders(<ReportsPage />);
    expect(await screen.findByText('An unexpected error occurred. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});

const owner: Member = { id: 'm1', user_id: 'user-1', username: 'asha', email: 'asha@example.test', first_name: 'Asha', last_name: 'Rao', status: 'ACTIVE', joined_at: '2026-01-01T00:00:00Z', is_owner: true, role_codes: ['ADMIN'], roles: ['Administrator'] };
const colleague: Member = { ...owner, id: 'm2', user_id: 'user-2', username: 'ravi', email: 'ravi@example.test', first_name: 'Ravi', last_name: '', is_owner: false, role_codes: ['VIEWER'], roles: ['Viewer'] };

describe('settings', () => {
  it('adds a member, asking for a temporary password only when the person has no account', async () => {
    const user = userEvent.setup();
    const replies = [apiError(400, 'PASSWORD_REQUIRED', 'No FinTrace account uses this email yet.', { password: 'Set a temporary password.' }), { status: 201, body: { id: 'm3', email: 'nia@example.test', role: 'MEMBER', created_user: true } }];
    const api = installApi({ 'GET /memberships/': () => ({ body: { results: [owner, colleague] } }), 'POST /memberships/': () => replies.shift() as never });
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    expect(await screen.findByText('Asha Rao (you)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Access level for Asha Rao')).not.toBeInTheDocument(); // cannot change own access

    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(screen.queryByLabelText('Temporary password')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Member email'), 'nia@example.test');
    await user.click(within(screen.getByRole('form', { name: 'Add member' })).getByRole('button', { name: 'Add member' }));
    await user.type(await screen.findByLabelText('Temporary password'), 'a-decent-temporary-pass');
    await user.click(screen.getByRole('button', { name: 'Create account and add' }));
    await waitFor(() => expect(api.calls('POST', '/memberships/')).toHaveLength(2));
    expect(api.calls('POST', '/memberships/')[0].body).toEqual({ email: 'nia@example.test', role: 'MEMBER' });
    expect(api.calls('POST', '/memberships/')[1].body).toMatchObject({ email: 'nia@example.test', password: 'a-decent-temporary-pass' });
    expect(await screen.findByRole('status')).toHaveTextContent(/ask them to change it/i);
  });

  it('changes a role directly but confirms before suspending', async () => {
    const user = userEvent.setup();
    const api = installApi({ 'GET /memberships/': () => ({ body: { results: [owner, colleague] } }), 'PATCH /memberships/m2/': () => ({ body: { id: 'm2' } }) });
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    await user.selectOptions(await screen.findByLabelText('Access level for Ravi'), 'MEMBER');
    await waitFor(() => expect(api.calls('PATCH', '/memberships/m2/')).toHaveLength(1));
    expect(api.calls('PATCH', '/memberships/m2/')[0].body).toEqual({ role: 'MEMBER' });
    await user.click(screen.getByRole('button', { name: 'Suspend Ravi' }));
    expect(api.calls('PATCH', '/memberships/m2/')).toHaveLength(1);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Suspend access' }));
    await waitFor(() => expect(api.calls('PATCH', '/memberships/m2/')).toHaveLength(2));
    expect(api.calls('PATCH', '/memberships/m2/')[1].body).toEqual({ status: 'SUSPENDED' });
  });

  it('hides member management from someone who may only look', async () => {
    installApi({ 'GET /memberships/': () => ({ body: { results: [owner, colleague] } }) }, { permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('memberships.c') && !p.startsWith('memberships.u')) });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    expect(await screen.findByText('Ravi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend Ravi' })).not.toBeInTheDocument();
  });

  it('changes the password and shows which field was wrong', async () => {
    const user = userEvent.setup();
    const replies = [apiError(400, 'INVALID_CREDENTIALS', 'Your current password is not correct.', { current_password: 'Your current password is not correct.' }), { body: { status: 'password_changed' } }];
    const api = installApi({ 'POST /auth/change-password/': () => replies.shift() as never });
    renderWithProviders(<SettingsPage />);
    await user.type(await screen.findByLabelText('Current password'), 'old-password-value');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(api.calls('POST', '/auth/change-password/')).toHaveLength(0);
    await user.type(screen.getByLabelText('New password'), '-but-now-long-enough');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findAllByText('Your current password is not correct.')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/password changed/i);
    expect(api.calls('POST', '/auth/change-password/')[1].body).toEqual({ current_password: 'old-password-value', new_password: 'short-but-now-long-enough' });
  });

  it('saves the workspace timezone and lists activity in plain words', async () => {
    const user = userEvent.setup();
    const api = installApi({
      'PATCH /tenants/tenant-home/': (request) => ({ body: { id: 'tenant-home', name: 'Home', ...(request.body as object) } }),
      'GET /activity/': () => ({ body: { results: [{ id: 'a1', occurred_at: '2026-10-10T09:00:00Z', action: 'insert', entity_type: 'accounts', entity_id: 'x', actor_user_id: 'user-2', actor_name: 'Ravi', actor_username: 'ravi' }] } }),
    });
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Workspace' }));
    await user.selectOptions(await screen.findByLabelText('Timezone'), 'Europe/London');
    await user.click(screen.getByRole('button', { name: 'Save timezone' }));
    await waitFor(() => expect(api.calls('PATCH', '/tenants/tenant-home/')).toHaveLength(1));
    expect(api.calls('PATCH', '/tenants/tenant-home/')[0].body).toEqual({ timezone: 'Europe/London' });
    expect(await screen.findByRole('status')).toHaveTextContent('Reports now use Europe/London days.');
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText(/added an account/)).toBeInTheDocument();
  });
});

describe('transfer between currencies', () => {
  it('asks for the amount that arrived and sends both amounts', async () => {
    const user = userEvent.setup();
    const eur = account({ id: 'acc-eur', name: 'Euro wallet', currency_id: 'cur-eur', currency_code: 'EUR', currency_symbol: '€', balance_amount: '0.00' });
    const api = installApi({ 'GET /accounts/': () => ({ body: { results: [account(), eur] } }), 'POST /transfers/': () => ({ status: 201, body: { id: 't1', ledger_transaction_id: 't1' } }) });
    renderWithProviders(<TransactionDrawer type="Transfer money" close={noop} saved={noop} />);
    expect(await screen.findByLabelText('Amount received')).toBeInTheDocument();
    expect(screen.queryByLabelText('Exchange rate')).not.toBeInTheDocument(); // one side is the workspace currency
    await user.type(screen.getByLabelText('Amount'), '110');
    await user.click(screen.getByRole('button', { name: 'Transfer money' }));
    expect(await screen.findByText('Enter an amount.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount received'), '100');
    await user.click(screen.getByRole('button', { name: 'Transfer money' }));
    await waitFor(() => expect(api.calls('POST', '/transfers/')).toHaveLength(1));
    expect(api.calls('POST', '/transfers/')[0].body).toMatchObject({ from_account_id: 'acc-bank', to_account_id: 'acc-eur', amount: '110', to_amount: '100' });
  });
});
