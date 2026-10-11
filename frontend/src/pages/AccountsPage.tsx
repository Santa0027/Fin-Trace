import { useMemo, useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { Icon } from '../components/common/Icon';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { AccountFormModal } from '../components/modals/AccountFormModal';
import { AccountDetailModal } from '../components/modals/AccountDetailModal';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { useTenant } from '../providers/TenantProvider';
import { accountsApi } from '../lib/api/accountsApi';
import { formatAccountType, isBalanceSheetAccount } from '../lib/accountHelpers';
import { formatMoney } from '../lib/money';
import type { Account } from '../types';

type Filter = 'ALL' | 'ASSET' | 'LIABILITY' | 'ARCHIVED';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ALL', label: 'Active' },
  { id: 'ASSET', label: 'What you have' },
  { id: 'LIABILITY', label: 'What you owe' },
  { id: 'ARCHIVED', label: 'Archived' },
];

export function AccountsPage() {
  const { canCreateAccounts, canUpdateAccounts } = useFinancialPermissions();
  const { currentCompany } = useTenant();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const { data, loading, error, forbidden, reload } = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const currenciesQuery = useTenantQuery(() => accountsApi.currencies(), []);

  const accounts = useMemo(() => (data?.results ?? []).filter(isBalanceSheetAccount), [data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((account) => {
      if (filter === 'ARCHIVED' ? account.is_active : !account.is_active) return false;
      if ((filter === 'ASSET' || filter === 'LIABILITY') && account.category !== filter) return false;
      return !q || account.name.toLowerCase().includes(q) || account.institution.toLowerCase().includes(q);
    });
  }, [accounts, search, filter]);
  const selected = accounts.find((account) => account.id === selectedId) ?? null;

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Where your money is kept and what you owe. Balances come from your recorded transactions."
        action={canCreateAccounts ? <Button kind="primary" icon="plus" onClick={openCreate}>Add account</Button> : undefined}
      />

      <div className="toolbar">
        <label className="input-like" style={{ width: '280px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name="search" />
          <input type="search" aria-label="Search accounts" style={{ border: 0, outline: 0, background: 'transparent', width: '100%', fontSize: '12px' }}
            placeholder="Search by name or bank" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="tabs" role="tablist" aria-label="Account filter" style={{ margin: 0 }}>
          {FILTERS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <LoadingSkeleton lines={4} message="Loading accounts…" />}
      {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view accounts in this workspace.</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}

      {data && !error && accounts.length === 0 && (
        <EmptyState
          title="No accounts yet"
          message="Add a bank account, cash, or a credit card to start recording income and expenses."
          actionText={canCreateAccounts ? 'Add your first account' : undefined}
          actionIcon="plus"
          onAction={canCreateAccounts ? openCreate : undefined}
        />
      )}
      {data && accounts.length > 0 && visible.length === 0 && (
        <EmptyState message={filter === 'ARCHIVED' ? 'No archived accounts.' : 'No accounts match this search or filter.'} />
      )}

      {visible.length > 0 && (
        <div className="card data-table account-table">
          <div className="table-header" style={{ gridTemplateColumns: '2fr 1.2fr 1fr 1.2fr' }}>
            <span>Account</span>
            <span>Type</span>
            <span>Currency</span>
            <span style={{ textAlign: 'right' }}>Balance</span>
          </div>
          {visible.map((account, i) => (
            <button type="button" className="table-row clickable" key={account.id} onClick={() => setSelectedId(account.id)}
              style={{ gridTemplateColumns: '2fr 1.2fr 1fr 1.2fr', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', background: 'transparent', border: 0, borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
              <div className="table-account">
                <span className={`bank b${i % 4}`} aria-hidden="true">{account.name.slice(0, 3).toUpperCase()}</span>
                <span>
                  <strong>{account.name}</strong>
                  <small>{account.institution || (account.is_system ? 'Managed by FinTrace' : '')}</small>
                </span>
              </div>
              <span>{formatAccountType(account.type)}</span>
              <span>{account.currency_code}</span>
              <strong className="mono" style={{ textAlign: 'right' }}>
                {formatMoney(account.balance_amount, account.currency_code)}
                {account.category === 'LIABILITY' && <small style={{ display: 'block', fontWeight: 400, color: 'var(--muted)' }}>owed</small>}
              </strong>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <AccountDetailModal
          account={selected}
          close={() => setSelectedId(null)}
          canEdit={canUpdateAccounts}
          edit={() => {
            setEditing(selected);
            setSelectedId(null);
            setFormOpen(true);
          }}
        />
      )}

      {formOpen && (
        <AccountFormModal
          account={editing}
          currencies={currenciesQuery.data?.results ?? []}
          defaultCurrencyId={currentCompany?.currency.id ?? ''}
          close={() => setFormOpen(false)}
          saved={() => setFormOpen(false)}
        />
      )}
    </>
  );
}
