import { useMemo, useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { CashflowChart } from '../components/dashboard/CashflowChart';
import { CategoryBreakdownCard } from '../components/dashboard/CategoryBreakdownCard';
import { TransactionTable } from '../components/transactions/TransactionTable';
import { TransactionDetailModal } from '../components/modals/TransactionDetailModal';
import { useAuth } from '../providers/AuthProvider';
import { useTenant } from '../providers/TenantProvider';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { reportsApi } from '../lib/api/reportsApi';
import { PERIOD_PRESETS, formatDate, periodFor, type PeriodPreset } from '../lib/dates';
import { formatMoney, toNumber } from '../lib/money';
import type { DashboardSummary, Transaction } from '../types';

interface DashboardPageProps {
  setPage: (page: string) => void;
  openExpense: () => void;
  openIncome: () => void;
  openChooser: () => void;
}

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'text-danger' }) {
  return (
    <div>
      <span style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.05em' }}>{label}</span>
      <strong className={`mono ${tone ?? ''}`} style={{ fontSize: '18px', display: 'block' }}>{value}</strong>
      {hint && <small style={{ color: 'var(--muted)', fontSize: '11px' }}>{hint}</small>}
    </div>
  );
}

/** Plain statements computed from the same figures shown on the page. Nothing is estimated. */
function observations(summary: DashboardSummary): string[] {
  const notes: string[] = [];
  const { totals, spending_by_category: spending, cashflow } = summary;
  if (totals.savings_rate !== null) {
    notes.push(
      totals.savings_rate >= 0
        ? `You kept ${totals.savings_rate}% of what you earned in this period.`
        : `You spent ${Math.abs(totals.savings_rate)}% more than you earned in this period.`
    );
  }
  const top = spending.results[0];
  if (top) notes.push(`${top.category} was your largest expense: ${formatMoney(top.amount)}, ${top.percentage}% of spending.`);
  if (cashflow.length >= 2) {
    const current = toNumber(cashflow[cashflow.length - 1].expenses);
    const previous = toNumber(cashflow[cashflow.length - 2].expenses);
    if (previous > 0) {
      const change = Math.round(((current - previous) / previous) * 100);
      if (change !== 0) {
        notes.push(`Spending so far in ${cashflow[cashflow.length - 1].month} is ${Math.abs(change)}% ${change > 0 ? 'higher' : 'lower'} than all of ${cashflow[cashflow.length - 2].month}.`);
      }
    }
  }
  if (toNumber(summary.debts.payable) > 0) {
    notes.push(`You have ${formatMoney(summary.debts.payable)} of loan principal still to repay across ${summary.debts.active_count} active loan${summary.debts.active_count === 1 ? '' : 's'}.`);
  }
  return notes;
}

export function DashboardPage({ setPage, openExpense, openIncome, openChooser }: DashboardPageProps) {
  const { user } = useAuth();
  const { currentCompany, isLoadingCompanies } = useTenant();
  const { canCreateIncome, canCreateExpenses, canTransfer } = useFinancialPermissions();
  const [preset, setPreset] = useState<PeriodPreset>('THIS_MONTH');
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [includeBroker, setIncludeBroker] = useState<boolean>(false);

  const period = useMemo(() => periodFor(preset), [preset]);
  const { data, loading, error, forbidden, reload } = useTenantQuery(
    () => reportsApi.dashboard(period),
    [period.date_from, period.date_to],
    { topics: ['accounts', 'transactions', 'reports', 'debts', 'investments'] }
  );

  const firstName = user?.first_name || user?.username || '';
  const canAdd = canCreateIncome || canCreateExpenses || canTransfer;

  if (!currentCompany) {
    return (
      <>
        <PageHeader title={firstName ? `Welcome, ${firstName}` : 'Welcome'} subtitle="Choose a workspace to see your finances." />
        {isLoadingCompanies ? (
          <LoadingSkeleton lines={2} message="Loading your workspaces…" />
        ) : (
          <EmptyState title="No workspace selected" message="You are not in a workspace yet. Pick one from the menu at the top, or ask an administrator to add you to one." />
        )}
      </>
    );
  }

  const header = (
    <PageHeader
      title={firstName ? `Hello, ${firstName}` : 'Dashboard'}
      subtitle={`Your finances in ${currentCompany.name}.`}
      action={
        <div className="title-actions">
          {canCreateIncome && <Button kind="secondary" icon="income" onClick={openIncome}>Add income</Button>}
          {canCreateExpenses && <Button kind="primary" icon="card" onClick={openExpense}>Add expense</Button>}
        </div>
      }
    />
  );

  if (!data) {
    return (
      <>
        {header}
        {loading && <LoadingSkeleton lines={5} message="Loading your dashboard…" />}
        {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view the dashboard in this workspace.</div>}
        {error && !forbidden && <ErrorState error={`Unable to load the dashboard. ${error}`} onRetry={reload} />}
      </>
    );
  }

  const { totals } = data;
  const net = toNumber(totals.net_cash_flow);
  const owned = data.accounts.filter((a) => a.category === 'ASSET' && a.is_active);
  const owed = data.accounts.filter((a) => a.category === 'LIABILITY' && toNumber(a.balance_base_amount) !== 0);
  const isNew = data.accounts.length === 0 && data.recent_transactions.length === 0;
  const notes = observations(data);
  const periodLabel = `${formatDate(data.period.date_from)} – ${formatDate(data.period.date_to)}`;
  const hasBroker = Boolean(data.broker && toNumber(data.broker.current_value) > 0);
  const activeNetWorth = includeBroker && hasBroker ? (data.broker?.combined_net_worth || totals.net_worth_with_broker || (toNumber(totals.net_worth) + toNumber(data.broker!.current_value)).toFixed(2)) : totals.net_worth;
  const activeAssets = includeBroker && hasBroker ? (data.broker?.combined_assets || totals.assets_with_broker || (toNumber(totals.assets) + toNumber(data.broker!.current_value)).toFixed(2)) : totals.assets;

  return (
    <>
      {header}
      {error && <ErrorState error={`Showing the last figures we loaded. ${error}`} onRetry={reload} />}

      {isNew ? (
        <EmptyState
          title="Let's set up your finances"
          message="Start by adding an account, such as your bank account or cash. Then record income and expenses against it."
          actionText="Add an account"
          actionIcon="plus"
          onAction={() => setPage('Accounts')}
        />
      ) : (
        <>
          <section className="card" aria-label="Net worth" style={{ padding: '20px 24px', marginBottom: '14px', display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <span className="eyebrow">{includeBroker && hasBroker ? 'Combined net worth' : 'Net worth today'}</span>
                <strong className="mono" style={{ fontSize: '34px', display: 'block', lineHeight: 1.1 }}>{formatMoney(activeNetWorth)}</strong>
                <small style={{ color: 'var(--muted)' }}>
                  {includeBroker && hasBroker
                    ? `Includes ledger accounts and Zerodha (${formatMoney(data.broker!.current_value, data.broker!.currency)})`
                    : `What you have minus what you owe, in ${data.currency.code}`}
                </small>
              </div>
              <Figure label="What you have" value={formatMoney(activeAssets)} hint={includeBroker && hasBroker ? `${owned.length} account${owned.length === 1 ? '' : 's'} + Zerodha` : `${owned.length} account${owned.length === 1 ? '' : 's'}`} />
              <Figure label="What you owe" value={formatMoney(totals.liabilities)} hint={toNumber(data.debts.payable) > 0 ? `incl. ${formatMoney(data.debts.payable)} in loans` : undefined} />
              {hasBroker && (
                <Figure
                  label="Zerodha portfolio"
                  value={formatMoney(data.broker!.current_value, data.broker!.currency)}
                  hint={includeBroker ? `Included (${data.broker!.holding_count} holdings)` : `Toggle to include (${data.broker!.holding_count} holdings)`}
                  tone={toNumber(data.broker!.pnl) >= 0 ? 'good' : 'text-danger'}
                />
              )}
              {data.investments.holding_count > 0 && (
                <Figure label="Invested (at cost)" value={formatMoney(data.investments.cost_basis)} hint={`${data.investments.holding_count} holding${data.investments.holding_count === 1 ? '' : 's'}`} />
              )}
            </div>
            {hasBroker && (
              <div style={{ alignSelf: 'flex-start', marginLeft: 'auto' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '4px 10px', borderRadius: '8px', background: 'var(--bg-subtle, rgba(0,0,0,0.03))', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600 }}>Zerodha in Net Worth:</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={includeBroker}
                    aria-label="Include Zerodha in net worth"
                    onClick={() => setIncludeBroker(!includeBroker)}
                    style={{
                      padding: '3px 8px',
                      fontSize: '11px',
                      borderRadius: '6px',
                      border: 'none',
                      background: includeBroker ? 'var(--primary)' : 'var(--border)',
                      color: includeBroker ? '#fff' : 'inherit',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    {includeBroker ? 'Included' : 'Off'}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card" aria-label="This period" style={{ padding: '16px 24px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '12px' }}>
              <div>
                <span className="eyebrow">Period</span>
                <strong style={{ display: 'block', fontSize: '13px' }}>{periodLabel}</strong>
              </div>
              <div className="range" role="group" aria-label="Period" style={{ padding: '4px' }}>
                {PERIOD_PRESETS.map((option) => (
                  <button key={option.value} type="button" aria-pressed={preset === option.value} className={preset === option.value ? 'active' : ''}
                    onClick={() => setPreset(option.value)} style={{ fontSize: '11px', padding: '6px 10px' }}>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '40px', flexWrap: 'wrap', opacity: loading ? 0.6 : 1 }} aria-busy={loading}>
              <Figure label="Earned" value={formatMoney(totals.income)} tone="good" />
              <Figure label="Spent" value={formatMoney(totals.expenses)} tone="text-danger" />
              <Figure label={net >= 0 ? 'Saved' : 'Overspent'} value={formatMoney(Math.abs(net))} tone={net >= 0 ? 'good' : 'text-danger'} hint="Earned minus spent. Transfers are not counted." />
              <Figure label="Savings rate" value={totals.savings_rate === null ? '—' : `${totals.savings_rate}%`} hint={totals.savings_rate === null ? 'No income in this period' : 'Share of income kept'} />
            </div>
          </section>

          {data.broker && (
            <section className="card" aria-label="Zerodha portfolio" style={{ padding: '16px 24px', marginBottom: '14px', display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <span className="eyebrow">Zerodha portfolio{data.broker.status === 'SAMPLE' ? ' (sample data)' : ''}</span>
                  <strong className="mono" style={{ fontSize: '22px', display: 'block' }}>{formatMoney(data.broker.current_value, data.broker.currency)}</strong>
                  <small style={{ color: 'var(--muted)' }}>
                    {data.broker.holding_count} holdings at market price
                    {data.broker.last_synced_at ? `, as of ${formatDate(data.broker.last_synced_at)}` : ''}
                    {data.broker.status === 'EXPIRED' ? ' (reconnect to refresh)' : ''}
                  </small>
                </div>
                <Figure label="Profit / loss" tone={toNumber(data.broker.pnl) >= 0 ? 'good' : 'text-danger'}
                  value={`${toNumber(data.broker.pnl) >= 0 ? '+' : '−'}${formatMoney(Math.abs(toNumber(data.broker.pnl)), data.broker.currency)}`}
                  hint={data.broker.pnl_percent === null ? undefined : `${data.broker.pnl_percent}% on ${formatMoney(data.broker.invested_value, data.broker.currency)} invested`} />
                {data.broker.day_change !== null && (
                  <Figure label="Today" tone={toNumber(data.broker.day_change) >= 0 ? 'good' : 'text-danger'}
                    value={`${toNumber(data.broker.day_change) >= 0 ? '+' : '−'}${formatMoney(Math.abs(toNumber(data.broker.day_change)), data.broker.currency)}`} hint="Stocks and ETFs" />
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <Button kind="ghost" onClick={() => setPage('Investments')}>Open portfolio</Button>
                <small style={{ display: 'block', color: 'var(--muted)', maxWidth: '220px' }}>
                  {includeBroker
                    ? 'Included in Combined Net Worth above.'
                    : 'Shown for reference. Not included in net worth above.'}
                </small>
              </div>
            </section>
          )}

          <CashflowChart points={data.cashflow} />

          <div className="dashboard-grid" style={{ marginBottom: '14px' }}>
            <CategoryBreakdownCard title="Where your money went" eyebrow="Spending by category" color="var(--coral)" breakdown={data.spending_by_category}
              emptyMessage="No expenses recorded in this period." />
            <CategoryBreakdownCard title="Where your money came from" eyebrow="Income by category" color="var(--primary)" breakdown={data.income_by_category}
              emptyMessage="No income recorded in this period." />
          </div>

          <section className="card" aria-label="Accounts" style={{ padding: '20px', marginBottom: '14px' }}>
            <div className="card-head">
              <div>
                <span className="eyebrow">Accounts</span>
                <h2 style={{ fontSize: '16px', margin: '2px 0 3px' }}>Balances</h2>
              </div>
              <Button kind="ghost" onClick={() => setPage('Accounts')}>All accounts</Button>
            </div>
            {owned.length + owed.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: '12px' }}>No accounts available. Create an account before recording income.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {[...owned, ...owed].slice(0, 8).map((account) => (
                  <li key={account.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <span>
                      {account.name}
                      {account.category === 'LIABILITY' && <small style={{ color: 'var(--muted)' }}> · owed</small>}
                    </span>
                    <strong className="mono">{formatMoney(account.balance_amount, account.currency_code)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {notes.length > 0 && (
            <section className="card" aria-label="Observations" style={{ padding: '20px', marginBottom: '14px' }}>
              <span className="eyebrow">Worth noticing</span>
              <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </section>
          )}

          <div className="card-head" style={{ marginBottom: '8px' }}>
            <h2 style={{ fontSize: '16px', margin: 0 }}>Recent transactions</h2>
            <Button kind="ghost" onClick={() => setPage('Transactions')}>View all</Button>
          </div>
          {data.recent_transactions.length === 0 ? (
            <EmptyState
              message="No transactions yet. Record your first transaction."
              actionText={canAdd ? 'Add transaction' : undefined}
              actionIcon="plus"
              onAction={canAdd ? openChooser : undefined}
            />
          ) : (
            <TransactionTable transactions={data.recent_transactions} onOpen={setSelected} />
          )}
        </>
      )}

      {selected && <TransactionDetailModal transaction={selected} close={() => setSelected(null)} />}
    </>
  );
}
