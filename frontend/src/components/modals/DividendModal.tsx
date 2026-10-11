import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useSubmission } from '../common/useSubmission';
import { accountsApi } from '../../lib/api/accountsApi';
import { investmentsApi } from '../../lib/api/investmentsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { formatMoney, parseAmountInput } from '../../lib/money';
import { todayISO } from '../../lib/dates';
import type { Holding } from '../../types';

interface DividendModalProps {
  holdings: Holding[];
  close: () => void;
  saved: () => void;
}

export function DividendModal({ holdings, close, saved }: DividendModalProps) {
  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const accounts = useMemo(() => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account && a.category === 'ASSET'), [accountsQuery.data]);
  const [symbol, setSymbol] = useState(holdings.length === 1 ? holdings[0].symbol : '');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayISO);
  const submission = useSubmission('dividend');

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    submission.touched();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const parsed = parseAmountInput(amount);
    if (parsed.error) next.amount = parsed.error;
    if (!symbol) next.symbol = 'Choose which investment paid it.';
    if (!accountId) next.deposit_account_id = 'Choose an account.';
    if (!date) next.paid_on = 'Choose a date.';
    submission.setErrors(next);
    if (Object.keys(next).length) return;

    const result = await submission.run(
      (key) => investmentsApi.recordDividend({ symbol, amount: parsed.value as string, deposit_account_id: accountId, paid_on: date }, key),
      'The dividend could not be recorded.'
    );
    if (result) {
      notifyDataChanged(['investments', 'accounts', 'transactions', 'income', 'reports']);
      saved();
    }
  };

  const fieldError = (field: string) => (submission.errors[field] ? <small className="field-error" role="alert">{submission.errors[field]}</small> : null);

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label="Record dividend" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>Record a dividend</h2>
            <p>Cash an investment paid you. It is counted as income.</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>
        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {submission.error && <div className="auth-error" role="alert">{submission.error}</div>}
          <label className="field">
            Amount
            <input autoFocus aria-label="Dividend amount" aria-invalid={Boolean(submission.errors.amount)} value={amount} inputMode="decimal" autoComplete="off" placeholder="0.00" onChange={(e) => change(setAmount)(e.target.value)} />
            {fieldError('amount')}
          </label>
          <label className="field">
            Paid by
            <select aria-label="Paid by" aria-invalid={Boolean(submission.errors.symbol)} value={symbol} onChange={(e) => change(setSymbol)(e.target.value)}>
              <option value="">Choose a holding</option>
              {holdings.map((h) => <option key={h.position_id} value={h.symbol}>{h.symbol} — {h.instrument_name}</option>)}
            </select>
            {fieldError('symbol')}
          </label>
          <label className="field">
            Received into
            <select aria-label="Received into" aria-invalid={Boolean(submission.errors.deposit_account_id)} value={accountId} onChange={(e) => change(setAccountId)(e.target.value)}>
              <option value="">{accountsQuery.loading ? 'Loading…' : 'Choose an account'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {formatMoney(a.balance_amount, a.currency_code)}</option>)}
            </select>
            {fieldError('deposit_account_id')}
          </label>
          <label className="field">
            Date
            <input aria-label="Dividend date" type="date" aria-invalid={Boolean(submission.errors.paid_on)} value={date} max={todayISO()} onChange={(e) => change(setDate)(e.target.value)} />
            {fieldError('paid_on')}
          </label>
        </div>
        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={submission.submitting}>{submission.submitting ? 'Saving…' : 'Record dividend'}</button>
        </div>
      </form>
    </div>
  );
}
