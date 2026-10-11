import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { LoadingSkeleton } from '../common/LoadingSkeleton';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';
import { TransactionTable } from './TransactionTable';
import { TransactionDetailModal } from '../modals/TransactionDetailModal';
import { transactionsApi } from '../../lib/api/transactionsApi';
import { useTenantQuery } from '../../hooks/useTenantQuery';
import type { Transaction } from '../../types';

const PAGE_SIZE = 25;

export interface TypeTab {
  id: string;
  label: string;
  /** Sent to the API as the type filter; empty means every type. */
  types: string;
}

interface TransactionBrowserProps {
  /** Restrict to these types when no tabs are shown (e.g. "INCOME"). */
  types?: string;
  tabs?: TypeTab[];
  accountId?: string;
  emptyTitle: string;
  emptyMessage: string;
  emptyAction?: ReactNode;
  forbiddenMessage?: string;
}

/**
 * Searchable, paged transaction history. Filtering, search and paging all happen
 * on the server, so what is shown is the same whatever page you are on.
 */
export function TransactionBrowser({ types = '', tabs, accountId, emptyTitle, emptyMessage, emptyAction, forbiddenMessage }: TransactionBrowserProps) {
  const [tab, setTab] = useState(tabs?.[0]?.id ?? '');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Transaction | null>(null);

  const activeTypes = tabs ? tabs.find((t) => t.id === tab)?.types ?? '' : types;

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const { data, loading, error, forbidden, reload } = useTenantQuery(
    () => transactionsApi.list({ type: activeTypes, account_id: accountId, q: search, limit: PAGE_SIZE, offset }),
    [activeTypes, accountId, search, offset],
    { topics: ['transactions'] }
  );

  const rows = data?.results ?? [];
  const total = data?.total ?? 0;
  const filtered = Boolean(search) || Boolean(tabs && activeTypes);

  return (
    <>
      <div className="toolbar" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="input-like" style={{ width: '320px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search transactions"
            style={{ border: 0, outline: 0, background: 'transparent', width: '100%', fontSize: '12px' }}
            placeholder="Search description, reference, category or contact"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        {tabs && (
          <div className="tabs" role="tablist" aria-label="Transaction type" style={{ margin: 0 }}>
            {tabs.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''}
                onClick={() => { setTab(item.id); setOffset(0); }}>
                {item.label}
              </button>
            ))}
          </div>
        )}
        <span className="toolbar-spacer" style={{ flex: 1 }} />
        {data && total > 0 && (
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }} aria-live="polite">
            {offset + 1}–{offset + rows.length} of {total}
          </p>
        )}
      </div>

      {loading && !data && <LoadingSkeleton lines={4} message="Loading transactions…" />}
      {forbidden && <div className="card app-state error-state" role="alert">{forbiddenMessage ?? 'You do not have permission to view transactions in this workspace.'}</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}

      {data && !error && rows.length === 0 && (
        filtered ? (
          <EmptyState title="Nothing matches" message="No transactions match this search or filter. Try a different one." />
        ) : (
          <div className="card empty-state" style={{ padding: '40px', textAlign: 'center' }}>
            <h3 style={{ margin: '0 0 6px' }}>{emptyTitle}</h3>
            <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: '12px' }}>{emptyMessage}</p>
            {emptyAction}
          </div>
        )
      )}

      {rows.length > 0 && <TransactionTable transactions={rows} onOpen={setSelected} />}

      {data && total > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <Button kind="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
          <Button kind="ghost" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
        </div>
      )}

      {selected && <TransactionDetailModal transaction={selected} close={() => setSelected(null)} />}
    </>
  );
}
