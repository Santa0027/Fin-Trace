import type { Account, AccountType } from '../types';

export interface AccountTypeOption {
  value: AccountType;
  label: string;
  group: 'What you have' | 'What you owe';
  description: string;
  openingLabel: string;
}

/**
 * The kinds of account a person can add. How each behaves in the books (which
 * side increases it) is derived by the backend from the type; it is never asked for.
 */
export const ACCOUNT_TYPE_OPTIONS: AccountTypeOption[] = [
  { value: 'BANK', label: 'Bank account', group: 'What you have', description: 'Checking, savings or current account', openingLabel: 'Current balance' },
  { value: 'CASH', label: 'Cash', group: 'What you have', description: 'Physical cash you keep', openingLabel: 'Cash in hand' },
  { value: 'WALLET', label: 'Digital wallet', group: 'What you have', description: 'Prepaid or payment-app balance', openingLabel: 'Current balance' },
  { value: 'BROKER', label: 'Brokerage account', group: 'What you have', description: 'Uninvested cash held with a broker', openingLabel: 'Cash balance' },
  { value: 'CREDIT_CARD', label: 'Credit card', group: 'What you owe', description: 'A card balance you pay off', openingLabel: 'Amount currently owed' },
  { value: 'LIABILITY', label: 'Other money owed', group: 'What you owe', description: 'An overdraft, line of credit or similar', openingLabel: 'Amount currently owed' },
];

const LABELS: Partial<Record<AccountType, string>> = {
  ...Object.fromEntries(ACCOUNT_TYPE_OPTIONS.map((option) => [option.value, option.label])),
  INVESTMENT: 'Investments',
  FOREX: 'Foreign currency',
  OTHER: 'Other',
  EQUITY: 'Opening balances',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
};

export function formatAccountType(type: AccountType): string {
  return LABELS[type] ?? type;
}

/** Accounts people recognise as theirs: what they have and what they owe. */
export function isBalanceSheetAccount(account: Account): boolean {
  return account.category === 'ASSET' || account.category === 'LIABILITY';
}
