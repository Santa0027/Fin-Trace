import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { accountsApi } from '../../lib/api/accountsApi';
import { categoriesApi } from '../../lib/api/categoriesApi';
import { recurringApi } from '../../lib/api/recurringApi';
import { errorMessage, fieldErrors } from '../../lib/api/apiClient';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { parseAmountInput } from '../../lib/money';
import { todayISO } from '../../lib/dates';
import type { RecurringFrequency } from '../../types';

type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER';

const FREQUENCIES: [RecurringFrequency, string][] = [['WEEKLY', 'Every week'], ['MONTHLY', 'Every month'], ['YEARLY', 'Every year'], ['DAILY', 'Every day']];

interface RecurringFormModalProps {
  close: () => void;
  saved: () => void;
}

export function RecurringFormModal({ close, saved }: RecurringFormModalProps) {
  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const categoriesQuery = useTenantQuery(() => categoriesApi.list(), [], { topics: ['categories'] });
  const accounts = useMemo(() => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account), [accountsQuery.data]);

  const [kind, setKind] = useState<Kind>('EXPENSE');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<RecurringFrequency>('MONTHLY');
  const [nextDate, setNextDate] = useState(todayISO);
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const categories = useMemo(() => (categoriesQuery.data?.results ?? []).filter((c) => c.is_active && c.type === kind), [categoriesQuery.data, kind]);
  const accountLabel = kind === 'INCOME' ? 'Received into' : kind === 'EXPENSE' ? 'Paid from' : 'From account';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    const parsed = parseAmountInput(amount);
    if (parsed.error) next.amount = parsed.error;
    if (!description.trim()) next.description = 'Give this a name, like Rent or Salary.';
    if (!accountId) next.account = 'Choose an account.';
    if (kind === 'TRANSFER') {
      if (!toAccountId) next.toAccount = 'Choose the account to transfer to.';
      else if (toAccountId === accountId) next.toAccount = 'Choose two different accounts.';
    }
    if (kind !== 'TRANSFER' && !categoryId) next.category = 'Choose a category, so this can be recorded when it is due.';
    if (!nextDate) next.next_run_at = 'Choose the next date.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    setError(null);
    try {
      await recurringApi.create({
        transaction_type: kind,
        description: description.trim(),
        amount: parsed.value as string,
        frequency,
        next_run_at: nextDate,
        source_account_id: kind === 'INCOME' ? undefined : accountId,
        destination_account_id: kind === 'INCOME' ? accountId : kind === 'TRANSFER' ? toAccountId : undefined,
        category_id: kind !== 'TRANSFER' && categoryId ? categoryId : undefined,
      });
      notifyDataChanged(['recurring']);
      saved();
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors({ amount: fields.amount, account: fields.source_account_id || (kind === 'INCOME' ? fields.destination_account_id : ''), toAccount: kind === 'TRANSFER' ? fields.destination_account_id : '', next_run_at: fields.next_run_at });
      setError(errorMessage(err, 'The schedule could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (field: string) => (errors[field] ? <small className="field-error" role="alert">{errors[field]}</small> : null);
  const accountOptions = accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>);

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label="Add recurring item" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>Add a recurring item</h2>
            <p>Something that repeats: rent, salary, a subscription, a regular transfer to savings.</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>
        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {error && <div className="auth-error" role="alert">{error}</div>}

          <div className="tabs" role="group" aria-label="Kind" style={{ margin: '0 0 12px' }}>
            {(['EXPENSE', 'INCOME', 'TRANSFER'] as Kind[]).map((value) => (
              <button key={value} type="button" aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => { setKind(value); setCategoryId(''); }}>
                {value === 'EXPENSE' ? 'Expense' : value === 'INCOME' ? 'Income' : 'Transfer'}
              </button>
            ))}
          </div>

          <label className="field">
            Name
            <input autoFocus aria-label="Name" aria-invalid={Boolean(errors.description)} value={description} maxLength={255} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Rent" />
            {fieldError('description')}
          </label>

          <div className="field-row">
            <label className="field">
              Amount
              <input aria-label="Amount" aria-invalid={Boolean(errors.amount)} value={amount} inputMode="decimal" autoComplete="off" placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
              {fieldError('amount')}
            </label>
            <label className="field">
              Repeats
              <select aria-label="Repeats" value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
                {FREQUENCIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          <label className="field">
            {accountLabel}
            <select aria-label={accountLabel} aria-invalid={Boolean(errors.account)} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{accountsQuery.loading ? 'Loading…' : 'Choose an account'}</option>
              {accountOptions}
            </select>
            {fieldError('account')}
          </label>

          {kind === 'TRANSFER' ? (
            <label className="field">
              To account
              <select aria-label="To account" aria-invalid={Boolean(errors.toAccount)} value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">Choose an account</option>
                {accountOptions}
              </select>
              {fieldError('toAccount')}
            </label>
          ) : (
            <label className="field">
              Category
              <select aria-label="Category" aria-invalid={Boolean(errors.category)} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose a category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {fieldError('category')}
            </label>
          )}

          <label className="field">
            Next date
            <input aria-label="Next date" type="date" aria-invalid={Boolean(errors.next_run_at)} value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            {fieldError('next_run_at')}
          </label>
        </div>
        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add recurring item'}</button>
        </div>
      </form>
    </div>
  );
}
