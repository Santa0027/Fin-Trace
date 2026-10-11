import { useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { StatusBadge } from '../components/common/StatusBadge';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { RecurringFormModal } from '../components/modals/RecurringFormModal';
import { notifyDataChanged, useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { recurringApi } from '../lib/api/recurringApi';
import { ApiError, errorMessage, newIdempotencyKey } from '../lib/api/apiClient';
import { formatMoney } from '../lib/money';
import { formatDate, todayISO } from '../lib/dates';
import type { RecurringTransaction } from '../types';

const FREQUENCY_LABEL: Record<string, string> = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' };
const KIND_LABEL: Record<string, string> = { INCOME: 'Income', EXPENSE: 'Expense', TRANSFER: 'Transfer' };

function route(item: RecurringTransaction): string {
  if (item.transaction_type === 'TRANSFER') return `${item.source_account_name ?? '—'} → ${item.destination_account_name ?? '—'}`;
  const account = item.transaction_type === 'INCOME' ? item.destination_account_name : item.source_account_name;
  return [account, item.category_name].filter(Boolean).join(' · ');
}

export function RecurringPage() {
  const { canCreateRecurring, canUpdateRecurring, canRunRecurring } = useFinancialPermissions();
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One key per item and due date: a second click, or a retry after a dropped
  // connection, replays the same posting instead of making another.
  const [keys, setKeys] = useState<Record<string, string>>({});

  const { data, loading, error, forbidden, reload } = useTenantQuery(() => recurringApi.list(), [], { topics: ['recurring'] });
  const items = data?.results ?? [];
  const today = todayISO();

  const act = async (item: RecurringTransaction, action: 'post' | 'skip' | 'toggle') => {
    if (busyId) return;
    setBusyId(item.id);
    setActionError(null);
    setNotice(null);
    const slot = `${item.id}:${item.next_run_at}:${action}`;
    const key = keys[slot] ?? newIdempotencyKey('recurring');
    setKeys((current) => ({ ...current, [slot]: key }));
    try {
      if (action === 'toggle') {
        await recurringApi.update(item.id, { is_active: !item.is_active });
        notifyDataChanged(['recurring']);
      } else {
        const result = await recurringApi.run(item.id, action, key);
        const next = result.next_run_at ? ` Next: ${formatDate(result.next_run_at)}.` : ' That was the last one.';
        setNotice(action === 'post' ? `${item.description} recorded for ${formatDate(result.scheduled_for)}.${next}` : `${item.description} skipped for ${formatDate(result.scheduled_for)}.${next}`);
        notifyDataChanged(action === 'post' ? ['recurring', 'accounts', 'transactions', 'income', 'expenses', 'reports'] : ['recurring']);
      }
    } catch (err) {
      setActionError(`${item.description}: ${errorMessage(err, 'this could not be done.')}`);
      if (!(err instanceof ApiError && err.retryable)) setKeys(({ [slot]: _used, ...rest }) => rest);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Recurring"
        subtitle="Regular income, bills and transfers. Record each one when it is due, or skip it."
        action={canCreateRecurring ? <Button kind="primary" icon="plus" onClick={() => setFormOpen(true)}>Add recurring item</Button> : undefined}
      />

      {loading && !data && <LoadingSkeleton lines={4} message="Loading recurring items…" />}
      {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view recurring items in this workspace.</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}
      {actionError && <div className="auth-error" role="alert">{actionError}</div>}
      {notice && <p className="callout" role="status" style={{ fontSize: '12px', padding: '10px 14px', marginBottom: '14px' }}>{notice}</p>}

      {data && !error && items.length === 0 && (
        <EmptyState title="Nothing recurring yet" message="Add rent, salary, subscriptions or a regular savings transfer to see what is coming up."
          actionText={canCreateRecurring ? 'Add recurring item' : undefined} actionIcon="plus" onAction={canCreateRecurring ? () => setFormOpen(true) : undefined} />
      )}

      {items.length > 0 && (
        <ul className="card" aria-label="Recurring items" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item) => {
            const due = item.is_active && item.next_run_at <= today;
            const busy = busyId === item.id;
            return (
              <li key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '12px 16px', borderTop: '1px solid var(--border)', opacity: item.is_active ? 1 : 0.6 }}>
                <span>
                  <strong style={{ display: 'block', fontSize: '13px' }}>{item.description || KIND_LABEL[item.transaction_type]}</strong>
                  <small style={{ color: 'var(--muted)' }}>
                    {KIND_LABEL[item.transaction_type]} · {FREQUENCY_LABEL[item.frequency] ?? item.frequency}
                    {route(item) ? ` · ${route(item)}` : ''}
                  </small>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ textAlign: 'right' }}>
                    <strong className="mono" style={{ display: 'block' }}>{formatMoney(item.amount, item.currency_code)}</strong>
                    <small style={{ color: due ? 'var(--coral)' : 'var(--muted)' }}>{item.is_active ? `${due ? 'Due' : 'Next'} ${formatDate(item.next_run_at)}` : 'Paused'}</small>
                  </span>
                  {!item.is_active && <StatusBadge status="PAUSED" />}
                  {item.is_active && canRunRecurring && (
                    <>
                      <Button kind={due ? 'primary' : 'secondary'} disabled={busy} ariaLabel={`Record ${item.description} now`} onClick={() => void act(item, 'post')}>
                        {busy ? 'Working…' : due ? 'Record now' : 'Record early'}
                      </Button>
                      {due && <Button kind="ghost" disabled={busy} ariaLabel={`Skip ${item.description} this time`} onClick={() => void act(item, 'skip')}>Skip</Button>}
                    </>
                  )}
                  {canUpdateRecurring && (
                    <Button kind="ghost" icon={item.is_active ? 'pause' : 'play'} disabled={busy}
                      ariaLabel={`${item.is_active ? 'Pause' : 'Resume'} ${item.description}`} onClick={() => void act(item, 'toggle')}>
                      {item.is_active ? 'Pause' : 'Resume'}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {formOpen && <RecurringFormModal close={() => setFormOpen(false)} saved={() => setFormOpen(false)} />}
    </>
  );
}
