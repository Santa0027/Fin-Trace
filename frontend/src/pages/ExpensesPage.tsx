import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { PeriodTotal } from '../components/common/PeriodTotal';
import { TransactionBrowser } from '../components/transactions/TransactionBrowser';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { reportsApi } from '../lib/api/reportsApi';
import { periodFor } from '../lib/dates';

interface ExpensesPageProps {
  openExpense: () => void;
}

export function ExpensesPage({ openExpense }: ExpensesPageProps) {
  const { canCreateExpenses } = useFinancialPermissions();
  const month = useTenantQuery(() => reportsApi.spendingByCategory(periodFor('THIS_MONTH')), [], { topics: ['reports'] });

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Money you spent, by category."
        action={canCreateExpenses ? <Button kind="primary" icon="card" onClick={openExpense}>Add expense</Button> : undefined}
      />
      <PeriodTotal label="Spent this month" amount={month.data?.total} loading={month.loading} error={month.error} tone="negative" />
      <TransactionBrowser
        types="EXPENSE"
        emptyTitle="No expenses recorded yet"
        emptyMessage="Record your first expense to see it here."
        emptyAction={canCreateExpenses ? <Button kind="primary" icon="plus" onClick={openExpense}>Add expense</Button> : undefined}
      />
    </>
  );
}
