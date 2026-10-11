import { formatMoney } from './money';
import type { Transaction, TransactionType } from '../types';

/** How a transaction reads to a person. The type itself is decided by the backend. */
export interface TransactionPresentation {
  label: string;
  /** Signed, formatted amount: + money in, − money out, ⇄ moved between own accounts. */
  formattedAmount: string;
  tone: 'positive' | 'negative' | 'neutral';
  accountLabel: string;
  categoryLabel: string;
}

const LABELS: Record<TransactionType, string> = {
  INCOME: 'Income',
  EXPENSE: 'Expense',
  TRANSFER: 'Transfer',
  REVERSAL: 'Reversal',
  DEBT_PAYMENT: 'Loan payment',
  INVESTMENT_BUY: 'Investment purchase',
  INVESTMENT_SELL: 'Investment sale',
  DIVIDEND: 'Dividend',
  JOURNAL: 'Adjustment',
};

export function transactionTypeLabel(type: TransactionType): string {
  return LABELS[type] ?? 'Transaction';
}

export function presentTransaction(tx: Transaction): TransactionPresentation {
  const money = formatMoney(tx.amount, tx.currency_code);
  const from = tx.source_account_name;
  const to = tx.destination_account_name;
  const label = transactionTypeLabel(tx.type);

  switch (tx.type) {
    case 'INCOME':
    case 'DIVIDEND':
      return { label, formattedAmount: `+${money}`, tone: 'positive', accountLabel: to ?? '—', categoryLabel: tx.category_name ?? label };
    case 'EXPENSE':
      return { label, formattedAmount: `−${money}`, tone: 'negative', accountLabel: from ?? '—', categoryLabel: tx.category_name ?? label };
    case 'TRANSFER':
      return { label, formattedAmount: `⇄ ${money}`, tone: 'neutral', accountLabel: `${from ?? '—'} → ${to ?? '—'}`, categoryLabel: 'Transfer' };
    default:
      return {
        label,
        formattedAmount: money,
        tone: 'neutral',
        accountLabel: from && to ? `${from} → ${to}` : from ?? to ?? '—',
        categoryLabel: label,
      };
  }
}
