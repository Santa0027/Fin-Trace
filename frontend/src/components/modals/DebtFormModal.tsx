import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useSubmission } from '../common/useSubmission';
import { accountsApi } from '../../lib/api/accountsApi';
import { contactsApi } from '../../lib/api/contactsApi';
import { debtsApi } from '../../lib/api/debtsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { formatMoney, parseAmountInput } from '../../lib/money';
import { todayISO } from '../../lib/dates';

interface DebtFormModalProps {
  close: () => void;
  saved: () => void;
}

export function DebtFormModal({ close, saved }: DebtFormModalProps) {
  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const contactsQuery = useTenantQuery(() => contactsApi.list(), [], { topics: ['contacts'] });
  const accounts = useMemo(() => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account), [accountsQuery.data]);
  const contactNames = useMemo(() => (contactsQuery.data?.results ?? []).filter((c) => c.status === 'ACTIVE').map((c) => c.name), [contactsQuery.data]);

  const [type, setType] = useState<'PAYABLE' | 'RECEIVABLE'>('PAYABLE');
  const [contactName, setContactName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [startDate, setStartDate] = useState(todayISO);
  const [dueDate, setDueDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [notes, setNotes] = useState('');
  const submission = useSubmission('debt');
  const payable = type === 'PAYABLE';

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    submission.touched();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const amount = parseAmountInput(principal);
    if (amount.error) next.principal_amount = amount.error;
    if (!contactName.trim()) next.contact_name = payable ? 'Enter who you borrowed from.' : 'Enter who you lent to.';
    if (interestRate.trim() && !/^\d+(\.\d{1,4})?$/.test(interestRate.trim())) next.interest_rate = 'Enter the yearly rate as a number, for example 8.5.';
    if (!startDate) next.start_date = 'Choose a start date.';
    if (dueDate && startDate && dueDate < startDate) next.due_date = 'The due date cannot be before the start date.';
    submission.setErrors(next);
    if (Object.keys(next).length || !amount.value) return;

    const result = await submission.run(
      (key) =>
        debtsApi.create(
          {
            type,
            contact_name: contactName.trim(),
            principal_amount: amount.value as string,
            interest_rate: interestRate.trim() || undefined,
            start_date: startDate,
            due_date: dueDate || undefined,
            account_id: accountId || undefined,
            notes: notes.trim(),
          },
          key
        ),
      'The loan could not be saved.'
    );
    if (result) {
      notifyDataChanged(['debts', 'accounts', 'transactions', 'contacts', 'reports']);
      saved();
    }
  };

  const fieldError = (field: string) => (submission.errors[field] ? <small className="field-error" role="alert">{submission.errors[field]}</small> : null);

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label="Add loan" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>Add a loan</h2>
            <p>Track money you borrowed or lent. Borrowing is not income, and repaying it is not spending — only the interest is.</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>

        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {submission.error && <div className="auth-error" role="alert">{submission.error}</div>}

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend className="field" style={{ padding: 0 }}>Which way does the money go?</legend>
            <div className="tabs" style={{ margin: '6px 0 0' }}>
              <button type="button" aria-pressed={payable} className={payable ? 'active' : ''} onClick={() => change(setType)('PAYABLE')}>I borrowed</button>
              <button type="button" aria-pressed={!payable} className={!payable ? 'active' : ''} onClick={() => change(setType)('RECEIVABLE')}>I lent</button>
            </div>
          </fieldset>

          <label className="field">
            {payable ? 'Borrowed from' : 'Lent to'}
            <input aria-label={payable ? 'Borrowed from' : 'Lent to'} aria-invalid={Boolean(submission.errors.contact_name)} list="debt-contacts" value={contactName} maxLength={255}
              onChange={(e) => change(setContactName)(e.target.value)} placeholder="A person, bank or company" />
            <datalist id="debt-contacts">{contactNames.map((name) => <option key={name} value={name} />)}</datalist>
            {fieldError('contact_name')}
          </label>

          <div className="field-row">
            <label className="field">
              Amount
              <input aria-label="Loan amount" aria-invalid={Boolean(submission.errors.principal_amount)} value={principal} inputMode="decimal" autoComplete="off" placeholder="0.00"
                onChange={(e) => change(setPrincipal)(e.target.value)} />
              {fieldError('principal_amount')}
            </label>
            <label className="field">
              Interest rate, % per year <small>Optional</small>
              <input aria-label="Interest rate" aria-invalid={Boolean(submission.errors.interest_rate)} value={interestRate} inputMode="decimal" autoComplete="off" placeholder="0"
                onChange={(e) => change(setInterestRate)(e.target.value)} />
              {fieldError('interest_rate')}
            </label>
          </div>

          <label className="field">
            {payable ? 'Money was received into' : 'Money was paid from'}
            <select aria-label={payable ? 'Money was received into' : 'Money was paid from'} aria-invalid={Boolean(submission.errors.account_id)} value={accountId} onChange={(e) => change(setAccountId)(e.target.value)}>
              <option value="">Not tracked here (the loan already existed)</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name} · {formatMoney(account.balance_amount, account.currency_code)}</option>
              ))}
            </select>
            <small>
              {accountId
                ? payable ? 'This account’s balance will go up by the loan amount.' : 'This account’s balance will go down by the loan amount.'
                : 'No account balance changes; the loan is simply added to what you owe or are owed.'}
            </small>
            {fieldError('account_id')}
          </label>

          <div className="field-row">
            <label className="field">
              Start date
              <input aria-label="Start date" type="date" aria-invalid={Boolean(submission.errors.start_date)} value={startDate} max={todayISO()} onChange={(e) => change(setStartDate)(e.target.value)} />
              {fieldError('start_date')}
            </label>
            <label className="field">
              Due date <small>Optional</small>
              <input aria-label="Due date" type="date" aria-invalid={Boolean(submission.errors.due_date)} value={dueDate} min={startDate} onChange={(e) => change(setDueDate)(e.target.value)} />
              {fieldError('due_date')}
            </label>
          </div>

          <label className="field">
            Notes <small>Optional</small>
            <textarea aria-label="Notes" value={notes} maxLength={1000} onChange={(e) => change(setNotes)(e.target.value)} placeholder="e.g. Car loan, 60 monthly payments" />
          </label>
        </div>

        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={submission.submitting}>{submission.submitting ? 'Saving…' : 'Add loan'}</button>
        </div>
      </form>
    </div>
  );
}
