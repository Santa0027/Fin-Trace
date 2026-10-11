import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { TransactionBrowser } from '../components/transactions/TransactionBrowser';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';

interface TransfersPageProps {
  openTransfer: () => void;
}

export function TransfersPage({ openTransfer }: TransfersPageProps) {
  const { canTransfer } = useFinancialPermissions();

  return (
    <>
      <PageHeader
        title="Transfers"
        subtitle="Money moved between your own accounts. Transfers are never counted as income or spending."
        action={canTransfer ? <Button kind="primary" icon="swap" onClick={openTransfer}>Transfer money</Button> : undefined}
      />
      <TransactionBrowser
        types="TRANSFER"
        emptyTitle="No transfers yet"
        emptyMessage="Move money between two of your accounts and it will appear here."
        emptyAction={canTransfer ? <Button kind="primary" icon="plus" onClick={openTransfer}>Transfer money</Button> : undefined}
      />
    </>
  );
}
