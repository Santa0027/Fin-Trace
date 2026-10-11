import { useState } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSkeleton } from '../common/LoadingSkeleton';
import { ApiError, errorMessage, newIdempotencyKey } from '../../lib/api/apiClient';
import { transactionsApi } from '../../lib/api/transactionsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { useFinancialPermissions } from '../../hooks/useFinancialPermissions';
import { presentTransaction } from '../../lib/transactionHelpers';
import { formatMoney } from '../../lib/money';
import { formatDate } from '../../lib/dates';
import type { Transaction } from '../../types';

interface TransactionDetailModalProps {
  transaction: Transaction;
  close: () => void;
}

/** What the "record a corrected one" follow-up should open for each type. */
const REENTRY_ACTION: Partial<Record<Transaction['type'], string>> = {
  INCOME: 'Add income',
  EXPENSE: 'Add expense',
  TRANSFER: 'Transfer money',
};

/** Why some entries are corrected another way; the backend refuses these too. */
const NOT_REVERSIBLE: Partial<Record<Transaction['type'], string>> = {
  REVERSAL: 'This entry is itself a reversal. To restore the original, record it again.',
  INVESTMENT_BUY: 'A trade is corrected with the opposite trade: sell what was bought.',
  INVESTMENT_SELL: 'A trade is corrected with the opposite trade: buy back what was sold.',
};

export function TransactionDetailModal({ transaction, close }: TransactionDetailModalProps) {
  const { canReverseTransactions } = useFinancialPermissions();
  const { data, loading, error: loadError, reload } = useTenantQuery(() => transactionsApi.get(transaction.id), [transaction.id], { topics: ['transactions'] });
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEntries, setShowEntries] = useState(false);
  const [reverseKey, setReverseKey] = useState(() => newIdempotencyKey('reverse'));

  const tx = data ?? transaction;
  const view = presentTransaction(tx);
  const notReversibleReason = NOT_REVERSIBLE[tx.type];
  const canReverse = canReverseTransactions && tx.status === 'COMPLETED' && !tx.is_reversed && !notReversibleReason;
  const reentry = REENTRY_ACTION[tx.type];

  const reverse = async (thenReenter: boolean) => {
    if (reversing) return;
    setReversing(true);
    setError(null);
    try {
      await transactionsApi.reverse(tx.id, reverseKey, reason.trim());
      notifyDataChanged(['accounts', 'transactions', 'income', 'expenses', 'reports', 'debts', 'investments']);
      close();
      if (thenReenter && reentry) window.dispatchEvent(new CustomEvent('fintrace-action', { detail: reentry }));
    } catch (err) {
      setError(errorMessage(err, 'The reversal could not be completed.'));
      if (!(err instanceof ApiError && err.retryable)) setReverseKey(newIdempotencyKey('reverse'));
    } finally {
      setReversing(false);
    }
  };

  const facts: [string, string][] = [
    ['Date', formatDate(tx.occurred_at)],
    ['Type', view.label],
    ['Category', tx.category_name ?? '—'],
    [tx.type === 'TRANSFER' ? 'From' : 'Paid from', tx.source_account_name ?? '—'],
    [tx.type === 'TRANSFER' ? 'To' : 'Received into', tx.destination_account_name ?? '—'],
    ['Contact', tx.contact_name ?? '—'],
    ['Reference', tx.reference || '—'],
  ];

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <div className="action-modal card" role="dialog" aria-modal="true" aria-label="Transaction details" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: '540px' }}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">{view.label}</p>
            <h2 style={{ margin: '2px 0' }}>{tx.description || tx.reference || view.label}</h2>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <strong className={`mono amount ${view.tone === 'positive' ? 'good' : view.tone === 'negative' ? 'text-danger' : ''}`} style={{ fontSize: '20px' }}>
                {view.formattedAmount}
              </strong>
              {tx.is_reversed && <StatusBadge status="REVERSED" />}
              {tx.status !== 'COMPLETED' && <StatusBadge status={tx.status} />}
            </div>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {loading && !data && <LoadingSkeleton lines={2} message="Loading details…" />}
          {loadError && (
            <div className="auth-error" role="alert">
              Could not load the latest details. {loadError}{' '}
              <button type="button" className="link-button" onClick={() => void reload()}>Retry</button>
            </div>
          )}
          {error && <div className="auth-error" role="alert">{error}</div>}

          <dl style={{ margin: 0 }}>
            {facts.map(([label, value]) => (
              <div className="info-row" key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <dt style={{ color: 'var(--muted)', fontSize: '12px' }}>{label}</dt>
                <dd style={{ margin: 0, fontSize: '12px', textAlign: 'right' }}>{value}</dd>
              </div>
            ))}
          </dl>

          {tx.type === 'DEBT_PAYMENT' && confirming && (
            <p style={{ marginTop: '8px', fontSize: '12px' }}>The loan's outstanding amount will go back up by what this payment had cleared.</p>
          )}

          {tx.is_reversed && (
            <p className="callout" style={{ marginTop: '12px', fontSize: '12px' }}>
              This transaction was reversed. Both it and its reversal stay in your history, and they cancel each other out in balances and reports.
            </p>
          )}

          {tx.entries.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <button type="button" className="link-button" aria-expanded={showEntries} onClick={() => setShowEntries(!showEntries)}>
                {showEntries ? 'Hide' : 'Show'} accounting entries
              </button>
              {showEntries && (
                <table style={{ width: '100%', marginTop: '8px', fontSize: '11px', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                      <th scope="col">Account</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Debit</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tx.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.account_name}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{Number(entry.debit_amount) > 0 ? formatMoney(entry.debit_amount, tx.currency_code) : ''}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{Number(entry.credit_amount) > 0 ? formatMoney(entry.credit_amount, tx.currency_code) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {confirming && (
            <div className="callout" role="group" aria-label="Confirm reversal" style={{ marginTop: '16px', padding: '12px' }}>
              <strong style={{ display: 'block', marginBottom: '4px' }}>Reverse this transaction?</strong>
              <p style={{ margin: '0 0 8px', fontSize: '12px' }}>
                The original is kept and an opposite entry dated today is added, so your balances return to what they were. This cannot be undone.
              </p>
              <label className="field">
                Reason <small>Optional</small>
                <input aria-label="Reason for reversal" value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); setReverseKey(newIdempotencyKey('reverse')); }} placeholder="e.g. entered the wrong amount" />
              </label>
            </div>
          )}

          {!canReverse && notReversibleReason && canReverseTransactions && !tx.is_reversed && (
            <p style={{ marginTop: '12px', fontSize: '11px', color: 'var(--muted)' }}>{notReversibleReason}</p>
          )}
        </div>

        <div className="drawer-foot">
          {!confirming && <Button onClick={close}>Close</Button>}
          {!confirming && canReverse && (
            <Button kind="danger" onClick={() => setConfirming(true)}>Reverse or correct…</Button>
          )}
          {confirming && (
            <>
              <Button onClick={() => setConfirming(false)} disabled={reversing}>Keep it</Button>
              {reentry && (
                <Button kind="secondary" disabled={reversing} onClick={() => void reverse(true)}>
                  {reversing ? 'Reversing…' : 'Reverse and re-enter'}
                </Button>
              )}
              <Button kind="danger" disabled={reversing} onClick={() => void reverse(false)}>
                {reversing ? 'Reversing…' : 'Reverse'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
