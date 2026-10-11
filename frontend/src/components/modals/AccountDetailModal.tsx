import { useState } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { TransactionBrowser } from '../transactions/TransactionBrowser';
import { accountsApi } from '../../lib/api/accountsApi';
import { errorMessage } from '../../lib/api/apiClient';
import { notifyDataChanged } from '../../hooks/useTenantQuery';
import { formatAccountType } from '../../lib/accountHelpers';
import { formatMoney, toNumber } from '../../lib/money';
import type { Account } from '../../types';

interface AccountDetailModalProps {
  account: Account;
  close: () => void;
  edit?: () => void;
  canEdit: boolean;
}

/** An account's balance and everything that has moved through it. */
export function AccountDetailModal({ account, close, edit, canEdit }: AccountDetailModalProps) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit && !account.is_system && account.is_active;
  const hasBalance = toNumber(account.balance_amount) !== 0;

  const archive = async () => {
    setArchiving(true);
    setError(null);
    try {
      await accountsApi.archive(account.id);
      notifyDataChanged(['accounts', 'reports']);
      close();
    } catch (err) {
      setError(errorMessage(err, 'The account could not be archived.'));
      setArchiving(false);
    }
  };

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <div className="action-modal card" role="dialog" aria-modal="true" aria-label={`${account.name} details`} onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: '760px', width: '100%' }}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">{formatAccountType(account.type)}{account.institution ? ` · ${account.institution}` : ''}</p>
            <h2 style={{ margin: '2px 0' }}>{account.name}</h2>
            <strong className="mono" style={{ fontSize: '22px' }}>{formatMoney(account.balance_amount, account.currency_code)}</strong>
            <small style={{ display: 'block', color: 'var(--muted)' }}>
              {account.category === 'LIABILITY' ? 'Currently owed' : 'Current balance'}
              {!account.is_active ? ' · Archived' : ''}
            </small>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="modal-form" style={{ padding: '16px 24px', maxHeight: '60vh', overflowY: 'auto' }}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          {account.notes && <p style={{ fontSize: '12px', color: 'var(--text-2)' }}>{account.notes}</p>}
          {confirmingArchive && (
            <div className="callout" role="group" aria-label="Confirm archive" style={{ padding: '12px', marginBottom: '12px' }}>
              <strong style={{ display: 'block', marginBottom: '4px' }}>Archive {account.name}?</strong>
              <p style={{ margin: 0, fontSize: '12px' }}>
                Its history is kept, but you will no longer be able to record new transactions on it.
                {hasBalance && ` It still has a balance of ${formatMoney(account.balance_amount, account.currency_code)}, which will keep counting towards your net worth.`}
              </p>
            </div>
          )}
          <TransactionBrowser
            accountId={account.id}
            emptyTitle="No transactions on this account yet"
            emptyMessage="Income, expenses and transfers involving this account will appear here."
          />
        </div>

        <div className="drawer-foot">
          {confirmingArchive ? (
            <>
              <Button onClick={() => setConfirmingArchive(false)} disabled={archiving}>Keep account</Button>
              <Button kind="danger" disabled={archiving} onClick={() => void archive()}>{archiving ? 'Archiving…' : 'Archive account'}</Button>
            </>
          ) : (
            <>
              <Button onClick={close}>Close</Button>
              {editable && <Button kind="danger" onClick={() => setConfirmingArchive(true)}>Archive…</Button>}
              {editable && edit && <Button kind="primary" icon="edit" onClick={edit}>Edit</Button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
