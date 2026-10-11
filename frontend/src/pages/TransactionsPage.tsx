import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { TransactionBrowser, type TypeTab } from '../components/transactions/TransactionBrowser';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';

interface TransactionsPageProps {
  openExpense: () => void;
  openIncome: () => void;
  openTransfer: () => void;
  openChooser: () => void;
}

const TABS: TypeTab[] = [
  { id: 'ALL', label: 'All', types: '' },
  { id: 'INCOME', label: 'Income', types: 'INCOME,DIVIDEND' },
  { id: 'EXPENSE', label: 'Expenses', types: 'EXPENSE' },
  { id: 'TRANSFER', label: 'Transfers', types: 'TRANSFER' },
  { id: 'OTHER', label: 'Loans & investments', types: 'DEBT_PAYMENT,INVESTMENT_BUY,INVESTMENT_SELL' },
  { id: 'REVERSAL', label: 'Reversals', types: 'REVERSAL' },
];

export function TransactionsPage({ openExpense, openIncome, openTransfer, openChooser }: TransactionsPageProps) {
  const { canCreateIncome, canCreateExpenses, canTransfer } = useFinancialPermissions();
  const canAdd = canCreateIncome || canCreateExpenses || canTransfer;

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="Everything that moved money in, out of, or between your accounts."
        action={
          <div className="title-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {canCreateIncome && <Button kind="secondary" icon="income" onClick={openIncome}>Add income</Button>}
            {canCreateExpenses && <Button kind="secondary" icon="card" onClick={openExpense}>Add expense</Button>}
            {canTransfer && <Button kind="secondary" icon="swap" onClick={openTransfer}>Transfer money</Button>}
          </div>
        }
      />
      <TransactionBrowser
        tabs={TABS}
        emptyTitle="No transactions yet"
        emptyMessage="Record your first income, expense or transfer and it will appear here."
        emptyAction={canAdd ? <Button kind="primary" icon="plus" onClick={openChooser}>Add transaction</Button> : undefined}
      />
    </>
  );
}
