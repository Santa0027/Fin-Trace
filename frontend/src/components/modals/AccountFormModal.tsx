import { useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { accountsApi } from '../../lib/api/accountsApi';
import { errorMessage, fieldErrors } from '../../lib/api/apiClient';
import { notifyDataChanged } from '../../hooks/useTenantQuery';
import { ACCOUNT_TYPE_OPTIONS } from '../../lib/accountHelpers';
import { parseAmountInput } from '../../lib/money';
import { todayISO } from '../../lib/dates';
import type { Account, Currency } from '../../types';

interface AccountFormModalProps {
  account: Account | null;
  currencies: Currency[];
  defaultCurrencyId: string;
  close: () => void;
  saved: () => Promise<void> | void;
}

export function AccountFormModal({ account, currencies, defaultCurrencyId, close, saved }: AccountFormModalProps) {
  const isEdit = Boolean(account);
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<string>(account?.type ?? 'BANK');
  const [currencyId, setCurrencyId] = useState(account?.currency_id ?? defaultCurrencyId);
  const [openingBalance, setOpeningBalance] = useState('');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.account_number ?? '');
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const typeOption = ACCOUNT_TYPE_OPTIONS.find((option) => option.value === type);
  const currency = currencies.find((c) => c.id === currencyId);
  const groups = ['What you have', 'What you owe'] as const;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter a name for this account.';
    if (!isEdit && !currencyId) next.currency_id = 'Choose a currency.';
    let opening: string | undefined;
    if (!isEdit && openingBalance.trim() && !/^0+(\.0+)?$/.test(openingBalance.trim())) {
      const parsed = parseAmountInput(openingBalance, currency?.decimal_places);
      if (parsed.error) next.opening_balance = parsed.error;
      opening = parsed.value;
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    setError(null);
    try {
      const details = { name: name.trim(), institution: institution.trim(), account_number: accountNumber.trim(), notes: notes.trim() };
      if (account) {
        await accountsApi.update(account.id, details);
      } else {
        await accountsApi.create({ ...details, type, currency_id: currencyId, opening_balance: opening, opening_date: opening ? todayISO() : undefined });
      }
      notifyDataChanged(['accounts', 'transactions', 'reports']);
      await saved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err, 'The account could not be saved.'));
    } finally {
      setSubmitting(false);
    }
  };

  const fieldError = (field: string) => (errors[field] ? <small className="field-error" role="alert">{errors[field]}</small> : null);

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit account' : 'Add account'} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>{isEdit ? 'Edit account' : 'Add account'}</h2>
            <p>{isEdit ? 'Update how this account is labelled.' : 'An account is anywhere you keep money or owe money.'}</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {error && <div className="auth-error" role="alert">{error}</div>}

          <label className="field">
            Account name
            <input autoFocus aria-label="Account name" aria-invalid={Boolean(errors.name)} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder="e.g. Everyday checking" />
            {fieldError('name')}
          </label>

          {!isEdit && (
            <>
              <label className="field">
                What kind of account is it?
                <select aria-label="Account type" value={type} onChange={(e) => setType(e.target.value)}>
                  {groups.map((group) => (
                    <optgroup key={group} label={group}>
                      {ACCOUNT_TYPE_OPTIONS.filter((option) => option.group === group).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {typeOption && <small>{typeOption.description}</small>}
                {fieldError('type')}
              </label>

              <div className="field-row">
                <label className="field">
                  Currency
                  <select aria-label="Currency" aria-invalid={Boolean(errors.currency_id)} value={currencyId} onChange={(e) => setCurrencyId(e.target.value)}>
                    {!currencyId && <option value="">Choose a currency</option>}
                    {currencies.map((c) => (
                      <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                    ))}
                  </select>
                  {fieldError('currency_id')}
                </label>
                <label className="field">
                  {typeOption?.openingLabel ?? 'Current balance'} <small>Optional</small>
                  <input aria-label="Opening balance" aria-invalid={Boolean(errors.opening_balance)} value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" />
                  {fieldError('opening_balance')}
                </label>
              </div>
            </>
          )}

          <div className="field-row">
            <label className="field">
              Bank or provider <small>Optional</small>
              <input aria-label="Bank or provider" value={institution} onChange={(e) => setInstitution(e.target.value)} maxLength={255} />
            </label>
            <label className="field">
              Account number <small>Optional</small>
              <input aria-label="Account number" aria-invalid={Boolean(errors.account_number)} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} maxLength={100} placeholder="Last 4 digits is enough" />
              {fieldError('account_number')}
            </label>
          </div>

          <label className="field">
            Notes <small>Optional</small>
            <textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
          </label>
        </div>

        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add account'}
          </button>
        </div>
      </form>
    </div>
  );
}
