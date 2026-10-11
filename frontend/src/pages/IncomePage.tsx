import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { PeriodTotal } from '../components/common/PeriodTotal';
import { TransactionBrowser } from '../components/transactions/TransactionBrowser';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { reportsApi } from '../lib/api/reportsApi';
import { periodFor } from '../lib/dates';

interface IncomePageProps {
  openIncome: () => void;
}

export function IncomePage({ openIncome }: IncomePageProps) {
  const { canCreateIncome } = useFinancialPermissions();
  const month = useTenantQuery(() => reportsApi.incomeByCategory(periodFor('THIS_MONTH')), [], { topics: ['reports'] });

  return (
    <>
      <PageHeader
        title="Income"
        subtitle="Money you received, by category."
        action={canCreateIncome ? <Button kind="primary" icon="income" onClick={openIncome}>Add income</Button> : undefined}
      />
      <PeriodTotal label="Income this month" amount={month.data?.total} loading={month.loading} error={month.error} tone="positive" />
      <TransactionBrowser
        types="INCOME,DIVIDEND"
        emptyTitle="No income recorded yet"
        emptyMessage="Record your first income to see it here."
        emptyAction={canCreateIncome ? <Button kind="primary" icon="plus" onClick={openIncome}>Add income</Button> : undefined}
      />
    </>
  );
}
