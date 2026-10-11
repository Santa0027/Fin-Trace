import { useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { StatusBadge } from '../components/common/StatusBadge';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { DebtFormModal } from '../components/modals/DebtFormModal';
import { DebtRepaymentModal } from '../components/modals/DebtRepaymentModal';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { debtsApi } from '../lib/api/debtsApi';
import { formatMoney, toNumber } from '../lib/money';
import { formatDate } from '../lib/dates';
import type { Debt } from '../types';

function DebtCard({ debt, canRepay, onRepay }: { debt: Debt; canRepay: boolean; onRepay: () => void }) {
  const payable = debt.type === 'PAYABLE';
  const principal = toNumber(debt.principal_amount);
  const progress = principal > 0 ? Math.min(100, Math.round((toNumber(debt.repaid_principal) / principal) * 100)) : 0;
  return (
    <li className="card" style={{ padding: '18px 20px', listStyle: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <span className="eyebrow">{payable ? 'You owe' : 'Owed to you'}</span>
          <h3 style={{ margin: '2px 0', fontSize: '15px' }}>{debt.contact_name ?? 'Unnamed contact'}</h3>
          <small style={{ color: 'var(--muted)' }}>
            {toNumber(debt.interest_rate) > 0 ? `${Number(debt.interest_rate)}% per year · ` : ''}
            Started {formatDate(debt.start_date)}
            {debt.due_date ? ` · Due ${formatDate(debt.due_date)}` : ''}
          </small>
        </div>
        <div style={{ textAlign: 'right' }}>
          <strong className="mono" style={{ fontSize: '20px', display: 'block' }}>{formatMoney(debt.outstanding_principal, debt.currency_code)}</strong>
          <small style={{ color: 'var(--muted)' }}>outstanding of {formatMoney(debt.principal_amount, debt.currency_code)}</small>
        </div>
      </div>
      <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${progress}% repaid`}
        style={{ height: '6px', background: 'var(--surface-3)', borderRadius: '3px', overflow: 'hidden', margin: '12px 0 8px' }}>
        <div style={{ width: `${progress}%`, height: '100%', background: 'var(--primary)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ color: 'var(--muted)' }}>
          {progress}% repaid
          {toNumber(debt.interest_paid) > 0 ? ` · ${formatMoney(debt.interest_paid, debt.currency_code)} interest ${payable ? 'paid' : 'received'}` : ''}
          {debt.last_repaid_on ? ` · Last payment ${formatDate(debt.last_repaid_on)}` : ''}
        </span>
        <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {debt.status !== 'ACTIVE' && <StatusBadge status={debt.status} />}
          {debt.status === 'ACTIVE' && canRepay && (
            <Button kind="secondary" onClick={onRepay}>{payable ? 'Record repayment' : 'Record money received'}</Button>
          )}
        </span>
      </div>
      {debt.notes && <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-2)' }}>{debt.notes}</p>}
    </li>
  );
}

export function DebtsPage() {
  const { canCreateDebts, canRepayDebts } = useFinancialPermissions();
  const [formOpen, setFormOpen] = useState(false);
  const [repaying, setRepaying] = useState<Debt | null>(null);
  const { data, loading, error, forbidden, reload } = useTenantQuery(() => debtsApi.list(), [], { topics: ['debts'] });

  const debts = data?.results ?? [];
  const active = debts.filter((d) => d.status === 'ACTIVE');
  const settled = debts.filter((d) => d.status !== 'ACTIVE');

  return (
    <>
      <PageHeader
        title="Loans"
        subtitle="Money you borrowed and money you lent, with what is still outstanding."
        action={canCreateDebts ? <Button kind="primary" icon="plus" onClick={() => setFormOpen(true)}>Add loan</Button> : undefined}
      />

      {loading && !data && <LoadingSkeleton lines={4} message="Loading loans…" />}
      {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view loans in this workspace.</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}

      {data && !error && debts.length === 0 && (
        <EmptyState title="No loans tracked" message="Add a loan, mortgage or money you lent to someone to follow what is still outstanding."
          actionText={canCreateDebts ? 'Add loan' : undefined} actionIcon="plus" onAction={canCreateDebts ? () => setFormOpen(true) : undefined} />
      )}

      {active.length > 0 && (
        <ul aria-label="Active loans" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {active.map((debt) => <DebtCard key={debt.id} debt={debt} canRepay={canRepayDebts} onRepay={() => setRepaying(debt)} />)}
        </ul>
      )}
      {settled.length > 0 && (
        <>
          <h2 style={{ fontSize: '13px', color: 'var(--muted)', margin: '20px 0 8px' }}>Settled</h2>
          <ul aria-label="Settled loans" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {settled.map((debt) => <DebtCard key={debt.id} debt={debt} canRepay={false} onRepay={() => undefined} />)}
          </ul>
        </>
      )}

      {formOpen && <DebtFormModal close={() => setFormOpen(false)} saved={() => setFormOpen(false)} />}
      {repaying && <DebtRepaymentModal debt={repaying} close={() => setRepaying(null)} saved={() => setRepaying(null)} />}
    </>
  );
}
