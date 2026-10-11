import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useSubmission } from '../common/useSubmission';
import { accountsApi } from '../../lib/api/accountsApi';
import { debtsApi } from '../../lib/api/debtsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { formatMoney, parseAmountInput, toNumber } from '../../lib/money';
import { todayISO } from '../../lib/dates';
import type { Debt } from '../../types';

interface DebtRepaymentModalProps {
  debt: Debt;
  close: () => void;
  saved: () => void;
}

export function DebtRepaymentModal({ debt, close, saved }: DebtRepaymentModalProps) {
  const payable = debt.type === 'PAYABLE';
  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const accounts = useMemo(
    () => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account && a.currency_id === debt.currency_id),
    [accountsQuery.data, debt.currency_id]
  );

  const [principal, setPrincipal] = useState('');
  const [interest, setInterest] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayISO);
  const [notes, setNotes] = useState('');
  const submission = useSubmission('debt-repayment');

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    submission.touched();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const hasPrincipal = principal.trim() !== '';
    const hasInterest = interest.trim() !== '';
    const principalValue = hasPrincipal ? parseAmountInput(principal) : { value: '0' };
    const interestValue = hasInterest ? parseAmountInput(interest) : { value: '0' };
    if (principalValue.error) next.principal_amount = principalValue.error;
    if (interestValue.error) next.interest_amount = interestValue.error;
    if (!hasPrincipal && !hasInterest) next.principal_amount = 'Enter how much was paid.';
    if (principalValue.value && toNumber(principalValue.value) > toNumber(debt.outstanding_principal)) {
      next.principal_amount = `Only ${formatMoney(debt.outstanding_principal, debt.currency_code)} is still outstanding. Put anything above that under interest.`;
    }
    if (!accountId) next.account_id = 'Choose an account.';
    if (!date) next.repaid_on = 'Choose a date.';
    submission.setErrors(next);
    if (Object.keys(next).length) return;

    const result = await submission.run(
      (key) =>
        debtsApi.repay(
          debt.id,
          { account_id: accountId, principal_amount: principalValue.value as string, interest_amount: interestValue.value as string, repaid_on: date, notes: notes.trim() },
          key
        ),
      'The payment could not be recorded.'
    );
    if (result) {
      notifyDataChanged(['debts', 'accounts', 'transactions', 'reports']);
      saved();
    }
  };

  const fieldError = (field: string) => (submission.errors[field] ? <small className="field-error" role="alert">{submission.errors[field]}</small> : null);
  const accountLabel = payable ? 'Paid from' : 'Received into';

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label="Record loan payment" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>{payable ? 'Record a repayment' : 'Record money received'}</h2>
            <p>
              {payable ? 'Loan from' : 'Loan to'} {debt.contact_name ?? 'contact'} · {formatMoney(debt.outstanding_principal, debt.currency_code)} outstanding
            </p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>

        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {submission.error && <div className="auth-error" role="alert">{submission.error}</div>}
          {!accountsQuery.loading && accounts.length === 0 && (
            <div className="auth-error" role="alert">No active account in {debt.currency_code} is available. Add one under Accounts first.</div>
          )}

          <div className="field-row">
            <label className="field">
              Amount towards the loan
              <input autoFocus aria-label="Principal amount" aria-invalid={Boolean(submission.errors.principal_amount)} value={principal} inputMode="decimal" autoComplete="off" placeholder="0.00"
                onChange={(e) => change(setPrincipal)(e.target.value)} />
              <small>Reduces what is outstanding.</small>
              {fieldError('principal_amount')}
            </label>
            <label className="field">
              Interest <small>Optional</small>
              <input aria-label="Interest amount" aria-invalid={Boolean(submission.errors.interest_amount)} value={interest} inputMode="decimal" autoComplete="off" placeholder="0.00"
                onChange={(e) => change(setInterest)(e.target.value)} />
              <small>{payable ? 'Counted as an expense.' : 'Counted as income.'}</small>
              {fieldError('interest_amount')}
            </label>
          </div>

          <label className="field">
            {accountLabel}
            <select aria-label={accountLabel} aria-invalid={Boolean(submission.errors.account_id)} value={accountId} onChange={(e) => change(setAccountId)(e.target.value)}>
              <option value="">{accountsQuery.loading ? 'Loading…' : 'Choose an account'}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name} · {formatMoney(account.balance_amount, account.currency_code)}</option>
              ))}
            </select>
            {fieldError('account_id')}
          </label>

          <label className="field">
            Date
            <input aria-label="Payment date" type="date" aria-invalid={Boolean(submission.errors.repaid_on)} value={date} max={todayISO()} onChange={(e) => change(setDate)(e.target.value)} />
            {fieldError('repaid_on')}
          </label>

          <label className="field">
            Notes <small>Optional</small>
            <input aria-label="Notes" value={notes} maxLength={255} onChange={(e) => change(setNotes)(e.target.value)} />
          </label>
        </div>

        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={submission.submitting || accounts.length === 0}>
            {submission.submitting ? 'Saving…' : payable ? 'Record repayment' : 'Record receipt'}
          </button>
        </div>
      </form>
    </div>
  );
}
