import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { ApiError, errorMessage, fieldErrors, newIdempotencyKey } from '../../lib/api/apiClient';
import { accountsApi } from '../../lib/api/accountsApi';
import { categoriesApi } from '../../lib/api/categoriesApi';
import { contactsApi } from '../../lib/api/contactsApi';
import { incomeApi } from '../../lib/api/incomeApi';
import { expensesApi } from '../../lib/api/expensesApi';
import { transactionsApi } from '../../lib/api/transactionsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { useFinancialPermissions } from '../../hooks/useFinancialPermissions';
import { formatMoney, getWorkspaceCurrency, parseAmountInput } from '../../lib/money';
import { todayISO } from '../../lib/dates';

export type EntryKind = 'income' | 'expense' | 'transfer';

/** Maps the labels used around the app ("Add expense", …) to an entry kind. */
export function entryKindFor(action: string): EntryKind {
  if (action === 'Transfer money') return 'transfer';
  if (action === 'Add income') return 'income';
  return 'expense';
}

interface TransactionDrawerProps {
  type: string;
  close: () => void;
  saved: () => Promise<void> | void;
}

const COPY: Record<EntryKind, { eyebrow: string; title: string; hint: string; color: string }> = {
  income: { eyebrow: 'Money in', title: 'Record income', hint: 'Money you received: salary, client payments, interest, refunds.', color: 'var(--success)' },
  expense: { eyebrow: 'Money out', title: 'Record expense', hint: 'Money you spent: bills, shopping, rent, subscriptions.', color: 'var(--coral)' },
  transfer: { eyebrow: 'Between your accounts', title: 'Transfer money', hint: 'Moving money between your own accounts. This is not counted as income or spending.', color: '#5369bf' },
};

export function TransactionDrawer({ type, close, saved }: TransactionDrawerProps) {
  const kind = entryKindFor(type);
  const copy = COPY[kind];
  const { canCreateIncome, canCreateExpenses, canTransfer, permissionsLoading } = useFinancialPermissions();
  const permitted = kind === 'transfer' ? canTransfer : kind === 'expense' ? canCreateExpenses : canCreateIncome;

  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const categoriesQuery = useTenantQuery(() => categoriesApi.list(), [], { topics: ['categories'], enabled: kind !== 'transfer' });
  const contactsQuery = useTenantQuery(() => contactsApi.list(), [], { topics: ['contacts'], enabled: kind !== 'transfer' });

  const accounts = useMemo(() => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account), [accountsQuery.data]);
  const categories = useMemo(
    () => (categoriesQuery.data?.results ?? []).filter((c) => c.is_active && c.type === (kind === 'income' ? 'INCOME' : 'EXPENSE')),
    [categoriesQuery.data, kind]
  );
  const contacts = useMemo(() => (contactsQuery.data?.results ?? []).filter((c) => c.status === 'ACTIVE'), [contactsQuery.data]);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO);
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [contactId, setContactId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // One key per distinct submission. It is kept while a request's outcome is
  // unknown (so a retry cannot post twice) and replaced once the form changes.
  const [submitKey, setSubmitKey] = useState(() => newIdempotencyKey(kind));

  // Preselect the obvious choice once data arrives, without overriding the user.
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
    if (kind === 'transfer' && !toAccountId && accounts[1]) setToAccountId(accounts[1].id);
    if (kind !== 'transfer' && !categoryId && categories.length === 1) setCategoryId(categories[0].id);
  }, [accounts, categories, accountId, toAccountId, categoryId, kind]);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setSubmitKey(newIdempotencyKey(kind));
    setError(null);
    setErrors({});
  };

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);
  const base = getWorkspaceCurrency();
  // Moving money between currencies: what arrived differs from what left.
  const crossCurrency = kind === 'transfer' && Boolean(selectedAccount && toAccount && selectedAccount.currency_id !== toAccount.currency_id);
  const needsRate = crossCurrency && selectedAccount?.currency_code !== base.code && toAccount?.currency_code !== base.code;
  const loadingLists = accountsQuery.loading || (kind !== 'transfer' && categoriesQuery.loading);
  const listError = accountsQuery.error || (kind !== 'transfer' ? categoriesQuery.error : null);
  const blocker =
    !loadingLists && !listError
      ? accounts.length === 0
        ? 'No accounts available. Create an account before recording money.'
        : kind === 'transfer' && accounts.length < 2
        ? 'You need at least two accounts to transfer between.'
        : kind !== 'transfer' && categories.length === 0
        ? `No ${kind} categories yet. Create one under Categories first.`
        : null
      : null;

  const validate = (): { amount: string; toAmount?: string; rate?: string } | null => {
    const next: Record<string, string> = {};
    const parsed = parseAmountInput(amount);
    if (parsed.error) next.amount = parsed.error;
    const arrived = crossCurrency ? parseAmountInput(toAmount) : {};
    if (arrived.error) next.toAmount = arrived.error;
    const rate = needsRate ? parseAmountInput(exchangeRate, 10) : {};
    if (rate.error) next.exchangeRate = rate.error.replace(/amount/gi, 'rate');
    if (!accountId) next.account = 'Choose an account.';
    if (kind === 'transfer') {
      if (!toAccountId) next.toAccount = 'Choose the account to transfer to.';
      else if (toAccountId === accountId) next.toAccount = 'Choose two different accounts.';
    } else if (!categoryId) {
      next.category = 'Choose a category.';
    }
    if (!date) next.date = 'Choose a date.';
    setErrors(next);
    return Object.keys(next).length === 0 && parsed.value ? { amount: parsed.value, toAmount: arrived.value, rate: rate.value } : null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!permitted || submitting || blocker) return;
    const valid = validate();
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      if (kind === 'transfer') {
        await transactionsApi.transfer(
          { from_account_id: accountId, to_account_id: toAccountId, amount: valid.amount, occurred_on: date, description: notes.trim(), reference: reference.trim(), to_amount: valid.toAmount, exchange_rate: valid.rate },
          submitKey
        );
        notifyDataChanged(['accounts', 'transactions', 'reports']);
      } else if (kind === 'expense') {
        await expensesApi.create(
          { amount: valid.amount, category_id: categoryId, source_account_id: accountId, occurred_on: date, contact_id: contactId || undefined, reference: reference.trim(), notes: notes.trim() },
          submitKey
        );
        notifyDataChanged(['accounts', 'transactions', 'expenses', 'reports']);
      } else {
        await incomeApi.create(
          { amount: valid.amount, category_id: categoryId, destination_account_id: accountId, occurred_on: date, contact_id: contactId || undefined, reference: reference.trim(), notes: notes.trim() },
          submitKey
        );
        notifyDataChanged(['accounts', 'transactions', 'income', 'reports']);
      }
      await saved();
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors({
        amount: fields.amount,
        account: fields.source_account_id || fields.destination_account_id || fields.from_account_id,
        toAccount: fields.to_account_id,
        toAmount: fields.to_amount,
        exchangeRate: fields.exchange_rate,
        category: fields.category_id,
        date: fields.occurred_on,
      });
      setError(errorMessage(err, 'This could not be saved. Please try again.'));
      // A definite answer from the server ends this attempt; an unknown outcome keeps
      // the key so pressing the button again cannot create a second entry.
      if (!(err instanceof ApiError && err.retryable)) setSubmitKey(newIdempotencyKey(kind));
    } finally {
      setSubmitting(false);
    }
  };

  const accountLabel = kind === 'income' ? 'Received into' : kind === 'expense' ? 'Paid from' : 'From account';
  const fieldError = (name: string) => (errors[name] ? <small className="field-error" role="alert">{errors[name]}</small> : null);
  const accountOptions = accounts.map((account) => (
    <option key={account.id} value={account.id}>
      {account.name} · {formatMoney(account.balance_amount, account.currency_code)}
    </option>
  ));

  return (
    <div className="overlay drawer-overlay" onMouseDown={close}>
      <form className="drawer" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate aria-label={copy.title}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow" style={{ color: copy.color }}>{copy.eyebrow}</p>
            <h2 style={{ margin: '2px 0 3px' }}>{copy.title}</h2>
            <p>{copy.hint}</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="drawer-body">
          {!permissionsLoading && !permitted && (
            <div className="auth-error" role="alert">You do not have permission to record this in the current workspace.</div>
          )}
          {listError && (
            <div className="auth-error" role="alert">
              Could not load your accounts and categories. {listError}{' '}
              <button type="button" className="link-button" onClick={() => { void accountsQuery.reload(); void categoriesQuery.reload(); }}>Retry</button>
            </div>
          )}
          {blocker && <div className="auth-error" role="alert">{blocker}</div>}
          {error && <div className="auth-error" role="alert">{error}</div>}

          <label className="field amount-field">
            Amount
            <div>
              <span>{selectedAccount?.currency_symbol || selectedAccount?.currency_code || ''}</span>
              <input autoFocus aria-label="Amount" aria-invalid={Boolean(errors.amount)} value={amount} onChange={(e) => edit(setAmount)(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" />
            </div>
            {fieldError('amount')}
          </label>

          {kind !== 'transfer' && (
            <label className="field">
              Category
              <select aria-label="Category" aria-invalid={Boolean(errors.category)} value={categoryId} onChange={(e) => edit(setCategoryId)(e.target.value)} disabled={loadingLists}>
                <option value="">{loadingLists ? 'Loading…' : 'Choose a category'}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              {fieldError('category')}
            </label>
          )}

          <label className="field">
            {accountLabel}
            <select aria-label={accountLabel} aria-invalid={Boolean(errors.account)} value={accountId} onChange={(e) => edit(setAccountId)(e.target.value)} disabled={loadingLists}>
              <option value="">{loadingLists ? 'Loading…' : 'Choose an account'}</option>
              {accountOptions}
            </select>
            {fieldError('account')}
          </label>

          {kind === 'transfer' && (
            <label className="field">
              To account
              <select aria-label="To account" aria-invalid={Boolean(errors.toAccount)} value={toAccountId} onChange={(e) => edit(setToAccountId)(e.target.value)} disabled={loadingLists}>
                <option value="">{loadingLists ? 'Loading…' : 'Choose an account'}</option>
                {accountOptions}
              </select>
              {fieldError('toAccount')}
            </label>
          )}

          {crossCurrency && (
            <label className="field">
              Amount received in {toAccount?.currency_code}
              <input aria-label="Amount received" aria-invalid={Boolean(errors.toAmount)} value={toAmount} onChange={(e) => edit(setToAmount)(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" />
              <small>These accounts use different currencies. Enter what actually arrived, after conversion.</small>
              {fieldError('toAmount')}
            </label>
          )}

          {needsRate && (
            <label className="field">
              Value of 1 {selectedAccount?.currency_code} in {base.code}
              <input aria-label="Exchange rate" aria-invalid={Boolean(errors.exchangeRate)} value={exchangeRate} onChange={(e) => edit(setExchangeRate)(e.target.value)} inputMode="decimal" autoComplete="off" />
              <small>Neither account is in {base.code}, which your reports use, so FinTrace needs this rate.</small>
              {fieldError('exchangeRate')}
            </label>
          )}

          <label className="field">
            Date
            <input aria-label="Date" aria-invalid={Boolean(errors.date)} value={date} onChange={(e) => edit(setDate)(e.target.value)} type="date" max={todayISO()} />
            {fieldError('date')}
          </label>

          {kind !== 'transfer' && (
            <label className="field">
              {kind === 'income' ? 'Received from' : 'Paid to'} <small>Optional</small>
              <select aria-label={kind === 'income' ? 'Received from' : 'Paid to'} value={contactId} onChange={(e) => edit(setContactId)(e.target.value)}>
                <option value="">Not specified</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>{contact.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            Description <small>Optional</small>
            <textarea aria-label="Description" value={notes} onChange={(e) => edit(setNotes)(e.target.value)} maxLength={500}
              placeholder={kind === 'income' ? 'e.g. October salary' : kind === 'expense' ? 'e.g. Groceries at the market' : 'e.g. Monthly savings'} />
          </label>

          <label className="field">
            Reference <small>Optional</small>
            <input aria-label="Reference" value={reference} onChange={(e) => edit(setReference)(e.target.value)} maxLength={255}
              placeholder={kind === 'income' ? 'e.g. invoice number' : kind === 'expense' ? 'e.g. bill number' : 'e.g. bank reference'} />
          </label>
        </div>

        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={!permitted || submitting || Boolean(blocker) || loadingLists}>
            {submitting ? 'Saving…' : copy.title}
          </button>
        </div>
      </form>
    </div>
  );
}
