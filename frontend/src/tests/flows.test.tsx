import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionDrawer } from '../components/modals/TransactionDrawer';
import { TransactionDetailModal } from '../components/modals/TransactionDetailModal';
import { DashboardPage } from '../pages/DashboardPage';
import { TransactionsPage } from '../pages/TransactionsPage';
import { useTenant } from '../providers/TenantProvider';
import { account, apiError, category, installApi, renderWithProviders, STUDIO, summary, transaction } from './harness';

const lists = {
  'GET /accounts/': () => ({ body: { results: [account(), account({ id: 'acc-savings', name: 'Savings', balance_amount: '0.00' }), account({ id: 'acc-sys', name: 'Expenses', type: 'EXPENSE', category: 'EXPENSE', is_system: true, is_payment_account: false })] } }),
  'GET /categories/': () => ({ body: { results: [category(), category({ id: 'cat-rent', name: 'Rent' }), category({ id: 'cat-salary', name: 'Salary', type: 'INCOME' })] } }),
  'GET /contacts/': () => ({ body: { results: [] } }),
};
const noop = () => undefined;

async function fillExpense(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('option', { name: 'Food' });
  await user.type(screen.getByLabelText('Amount'), '150.25');
  await user.selectOptions(screen.getByLabelText('Category'), 'cat-food');
}

describe('recording an expense', () => {
  it('asks in plain language and sends only what the user chose', async () => {
    const user = userEvent.setup();
    const api = installApi({ ...lists, 'POST /expenses/': () => ({ status: 201, body: { id: 'exp-1', ledger_transaction_id: 'tx-9' } }) });
    renderWithProviders(<TransactionDrawer type="Add expense" close={noop} saved={noop} />);
    await fillExpense(user);

    // No accounting vocabulary, and internal accounts are not offered.
    expect(screen.getByLabelText('Paid from')).toBeInTheDocument();
    expect(screen.queryByText(/debit|credit|ledger|normal balance/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Expenses/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Salary' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record expense' }));
    await waitFor(() => expect(api.calls('POST', '/expenses/')).toHaveLength(1));
    const [request] = api.calls('POST', '/expenses/');
    expect(request.body).toMatchObject({ amount: '150.25', category_id: 'cat-food', source_account_id: 'acc-bank' });
    expect(Object.keys(request.body as object)).not.toEqual(expect.arrayContaining(['expense_account_id', 'currency_id', 'normal_balance', 'entries']));
    expect(request.headers['Idempotency-Key']).toMatch(/^expense-/);
  });

  it('cannot be submitted twice by double-clicking', async () => {
    const user = userEvent.setup();
    let release: (value: { status: number; body: unknown }) => void = noop;
    const api = installApi({ ...lists, 'POST /expenses/': () => new Promise((resolve) => { release = resolve; }) });
    renderWithProviders(<TransactionDrawer type="Add expense" close={noop} saved={noop} />);
    await fillExpense(user);

    const form = screen.getByRole('form', { name: 'Record expense' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled());
    expect(api.calls('POST', '/expenses/')).toHaveLength(1);
    await act(async () => release({ status: 201, body: { id: 'exp-1', ledger_transaction_id: 'tx-9' } }));
  });

  it('retries with the same idempotency key when the outcome is unknown, and a new one after a definite rejection', async () => {
    const user = userEvent.setup();
    const replies = [new TypeError('Failed to fetch'), apiError(400, 'ACCOUNT_INACTIVE', 'Everyday checking is archived. Choose an active account.', { source_account_id: 'Everyday checking is archived.' }), { status: 201, body: { id: 'exp-1', ledger_transaction_id: 'tx-9' } }];
    const api = installApi({ ...lists, 'POST /expenses/': () => replies.shift() as never });
    renderWithProviders(<TransactionDrawer type="Add expense" close={noop} saved={noop} />);
    await fillExpense(user);
    const submit = () => user.click(screen.getByRole('button', { name: 'Record expense' }));

    await submit();
    expect(await screen.findByText(/cannot reach fintrace/i)).toBeInTheDocument();
    await submit();
    // The specific reason from the backend is shown, next to the field it concerns.
    expect(await screen.findByText('Everyday checking is archived. Choose an active account.')).toBeInTheDocument();
    expect(screen.getByText('Everyday checking is archived.')).toBeInTheDocument();
    await submit();
    await waitFor(() => expect(api.calls('POST', '/expenses/')).toHaveLength(3));

    const keys = api.calls('POST', '/expenses/').map((r) => r.headers['Idempotency-Key']);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('validates before calling the server and explains what is missing', async () => {
    const user = userEvent.setup();
    const api = installApi(lists);
    renderWithProviders(<TransactionDrawer type="Add expense" close={noop} saved={noop} />);
    await screen.findByRole('option', { name: 'Food' });
    await user.type(screen.getByLabelText('Amount'), '12.345');
    await user.click(screen.getByRole('button', { name: 'Record expense' }));
    expect(await screen.findByText('Use at most 2 decimal places.')).toBeInTheDocument();
    expect(screen.getByText('Choose a category.')).toBeInTheDocument();
    expect(api.calls('POST', '/expenses/')).toHaveLength(0);
  });

  it('explains what to do when there are no accounts instead of showing an empty form', async () => {
    installApi({ ...lists, 'GET /accounts/': () => ({ body: { results: [] } }) });
    renderWithProviders(<TransactionDrawer type="Add expense" close={noop} saved={noop} />);
    expect(await screen.findByText('No accounts available. Create an account before recording money.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record expense' })).toBeDisabled();
  });
});

describe('transferring money', () => {
  it('posts one atomic transfer and refuses the same account on both sides', async () => {
    const user = userEvent.setup();
    const api = installApi({ ...lists, 'POST /transfers/': () => ({ status: 201, body: { id: 'tx-5', ledger_transaction_id: 'tx-5' } }) });
    renderWithProviders(<TransactionDrawer type="Transfer money" close={noop} saved={noop} />);
    await screen.findAllByRole('option', { name: /Savings/ });
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.getByText(/not counted as income or spending/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount'), '200');
    await user.selectOptions(screen.getByLabelText('To account'), 'acc-bank');
    await user.click(screen.getByRole('button', { name: 'Transfer money' }));
    expect(await screen.findByText('Choose two different accounts.')).toBeInTheDocument();
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    await user.selectOptions(screen.getByLabelText('To account'), 'acc-savings');
    await user.click(screen.getByRole('button', { name: 'Transfer money' }));
    await waitFor(() => expect(api.calls('POST', '/transfers/')).toHaveLength(1));
    expect(api.calls('POST', '/transfers/')[0].body).toMatchObject({ from_account_id: 'acc-bank', to_account_id: 'acc-savings', amount: '200' });
    // The old two-step create-then-post flow is gone.
    expect(api.requests.some((r) => r.path.startsWith('/transactions'))).toBe(false);
  });
});

describe('reversing a transaction', () => {
  it('requires confirmation and never edits the original', async () => {
    const user = userEvent.setup();
    const tx = transaction();
    const api = installApi({ 'GET /transactions/tx-1/': () => ({ body: tx }), 'POST /transactions/tx-1/reverse/': () => ({ status: 201, body: { id: 'tx-2', reverses_transaction_id: 'tx-1' } }) });
    renderWithProviders(<TransactionDetailModal transaction={tx} close={noop} />);

    await user.click(await screen.findByRole('button', { name: 'Reverse or correct…' }));
    expect(api.calls('POST', '/transactions/tx-1/reverse/')).toHaveLength(0);
    expect(screen.getByText(/the original is kept/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reverse' }));
    await waitFor(() => expect(api.calls('POST', '/transactions/tx-1/reverse/')).toHaveLength(1));
    expect(api.calls('POST', '/transactions/tx-1/reverse/')[0].headers['Idempotency-Key']).toMatch(/^reverse-/);
    expect(api.requests.some((r) => r.method === 'PATCH' || r.method === 'DELETE')).toBe(false);
  });

  it('is not offered for a transaction that is already reversed or is itself a reversal', async () => {
    const reversed = transaction({ is_reversed: true, reversed_by_transaction_id: 'tx-2' });
    installApi({ 'GET /transactions/tx-1/': () => ({ body: reversed }) });
    renderWithProviders(<TransactionDetailModal transaction={reversed} close={noop} />);
    expect(await screen.findByText(/this transaction was reversed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reverse/i })).not.toBeInTheDocument();
  });
});

describe('dashboard', () => {
  const props = { setPage: noop, openExpense: noop, openIncome: noop, openChooser: noop };

  it('shows the backend totals from a single request and does no arithmetic of its own', async () => {
    // Deliberately inconsistent parts: if the page summed anything itself, these would not match.
    const api = installApi({ 'GET /dashboard/summary/': () => ({ body: summary() }) });
    renderWithProviders(<DashboardPage {...props} />);
    expect(await screen.findByText('$7,500.00')).toBeInTheDocument();
    expect(screen.getByText('$9,000.00')).toBeInTheDocument();
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText(/transfers are not counted/i)).toBeInTheDocument();
    const financial = api.requests.filter((r) => !r.path.startsWith('/auth') && !r.path.startsWith('/rbac'));
    expect(financial.map((r) => r.path)).toEqual(['/dashboard/summary/']);
    expect(financial[0].query.get('date_from')).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('shows an error with a retry rather than zeros when the data cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    installApi({ 'GET /dashboard/summary/': () => (fail ? apiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Please try again.') : { body: summary() }) });
    renderWithProviders(<DashboardPage {...props} />);
    expect(await screen.findByText(/unable to load the dashboard/i)).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$7,500.00')).toBeInTheDocument();
  });

  it('guides a new workspace to add an account and invents no figures', async () => {
    installApi({ 'GET /dashboard/summary/': () => ({ body: summary({ accounts: [], recent_transactions: [], cashflow: [], totals: { assets: '0', liabilities: '0', net_worth: '0', income: '0', expenses: '0', net_cash_flow: '0', savings_rate: null }, spending_by_category: { total: '0', results: [] }, income_by_category: { total: '0', results: [] } }) }) });
    renderWithProviders(<DashboardPage {...props} />);
    expect(await screen.findByText(/let's set up your finances/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2},\d{3}/);
  });

  it('tells a user without permission, instead of showing an empty dashboard', async () => {
    installApi({ 'GET /dashboard/summary/': () => apiError(403, 'PERMISSION_DENIED', 'You need the dashboard.view permission to see this.') });
    renderWithProviders(<DashboardPage {...props} />);
    expect(await screen.findByText(/do not have permission to view the dashboard/i)).toBeInTheDocument();
  });
});

describe('workspace isolation', () => {
  function Switcher() {
    const { switchCompany, currentCompany } = useTenant();
    return <button onClick={() => void switchCompany(STUDIO.id)}>switch from {currentCompany?.name}</button>;
  }
  const pageProps = { openExpense: noop, openIncome: noop, openTransfer: noop, openChooser: noop };

  it("never shows one workspace's transactions under another, even while the new ones load", async () => {
    const user = userEvent.setup();
    let releaseStudio: () => void = noop;
    const api = installApi({
      'GET /transactions/': () =>
        api.state.tenant?.id === STUDIO.id
          ? new Promise((resolve) => { releaseStudio = () => resolve({ body: { results: [transaction({ id: 'tx-s', description: 'Studio rent' })], total: 1 } }); })
          : { body: { results: [transaction({ description: 'Home groceries' })], total: 1 } },
    });
    renderWithProviders(<><Switcher /><TransactionsPage {...pageProps} /></>);
    expect(await screen.findByText('Home groceries')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'switch from Home' }));
    await screen.findByRole('button', { name: 'switch from Studio' });
    // Studio's data has not arrived yet: Home's rows must already be gone.
    expect(screen.queryByText('Home groceries')).not.toBeInTheDocument();
    await act(async () => releaseStudio());
    expect(await screen.findByText('Studio rent')).toBeInTheDocument();
    expect(screen.queryByText('Home groceries')).not.toBeInTheDocument();
  });

  it('discards a slow response that belongs to the previous workspace', async () => {
    const user = userEvent.setup();
    let releaseHome: () => void = noop;
    const api = installApi({
      'GET /transactions/': () =>
        api.state.tenant?.id === STUDIO.id
          ? { body: { results: [transaction({ id: 'tx-s', description: 'Studio rent' })], total: 1 } }
          : new Promise((resolve) => { releaseHome = () => resolve({ body: { results: [transaction({ description: 'Home groceries' })], total: 1 } }); }),
    });
    renderWithProviders(<><Switcher /><TransactionsPage {...pageProps} /></>);
    await user.click(await screen.findByRole('button', { name: 'switch from Home' }));
    expect(await screen.findByText('Studio rent')).toBeInTheDocument();
    await act(async () => releaseHome());
    expect(screen.queryByText('Home groceries')).not.toBeInTheDocument();
    expect(screen.getByText('Studio rent')).toBeInTheDocument();
  });
});
