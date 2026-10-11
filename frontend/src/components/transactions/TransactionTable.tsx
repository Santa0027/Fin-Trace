import { Icon } from '../common/Icon';
import { StatusBadge } from '../common/StatusBadge';
import { presentTransaction } from '../../lib/transactionHelpers';
import { formatDate } from '../../lib/dates';
import type { IconName, Transaction } from '../../types';

const COLUMNS = 'minmax(180px, 1.8fr) 1fr 1.2fr .9fr 1fr';

const TYPE_ICON: Partial<Record<Transaction['type'], IconName>> = {
  INCOME: 'income',
  DIVIDEND: 'income',
  EXPENSE: 'expense',
  TRANSFER: 'swap',
  REVERSAL: 'refresh',
  DEBT_PAYMENT: 'debt',
  INVESTMENT_BUY: 'trend',
  INVESTMENT_SELL: 'trend',
};

interface TransactionTableProps {
  transactions: Transaction[];
  onOpen: (transaction: Transaction) => void;
}

/** A list of transactions in everyday terms: what, which category, which account, how much. */
export function TransactionTable({ transactions, onOpen }: TransactionTableProps) {
  return (
    <div className="card transactions-card full" role="table" aria-label="Transactions">
      <div className="transaction-head" role="row" style={{ display: 'grid', gridTemplateColumns: COLUMNS, alignItems: 'center', padding: '12px 16px' }}>
        <span role="columnheader">Description</span>
        <span role="columnheader">Category</span>
        <span role="columnheader">Account</span>
        <span role="columnheader">Type</span>
        <span role="columnheader" style={{ textAlign: 'right' }}>Amount</span>
      </div>
      {transactions.map((tx) => {
        const view = presentTransaction(tx);
        const toneClass = view.tone === 'positive' ? 'good' : view.tone === 'negative' ? 'text-danger' : '';
        return (
          <button
            type="button"
            role="row"
            className="transaction-row clickable"
            key={tx.id}
            onClick={() => onOpen(tx)}
            aria-label={`${view.label}: ${tx.description || tx.reference || 'no description'}, ${view.formattedAmount}`}
            style={{ display: 'grid', gridTemplateColumns: COLUMNS, alignItems: 'center', padding: '12px 16px', width: '100%', textAlign: 'left', background: 'transparent', border: 0, borderTop: '1px solid var(--border)', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
          >
            <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
              <span className="metric-icon" aria-hidden="true" style={{ flexShrink: 0 }}>
                <Icon name={TYPE_ICON[tx.type] ?? 'swap'} size={18} />
              </span>
              <div style={{ overflow: 'hidden' }}>
                <strong style={{ display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tx.description || tx.reference || view.label}
                </strong>
                <small style={{ color: 'var(--muted)', fontSize: '11px' }}>
                  {formatDate(tx.occurred_at)}
                  {tx.reference ? ` · ${tx.reference}` : ''}
                </small>
              </div>
            </div>
            <span role="cell" style={{ fontSize: '12px' }}>{view.categoryLabel}</span>
            <span role="cell" style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{view.accountLabel}</span>
            <span role="cell" style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px' }}>{view.label}</span>
              {tx.is_reversed && <StatusBadge status="REVERSED" />}
              {tx.status !== 'COMPLETED' && <StatusBadge status={tx.status} />}
            </span>
            <strong role="cell" className={`mono amount ${toneClass}`} style={{ textAlign: 'right', textDecoration: tx.is_reversed ? 'line-through' : undefined }}>
              {view.formattedAmount}
            </strong>
          </button>
        );
      })}
    </div>
  );
}
