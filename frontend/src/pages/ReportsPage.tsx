import { useMemo, useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { CashflowChart } from '../components/dashboard/CashflowChart';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { reportsApi } from '../lib/api/reportsApi';
import { downloadCsv } from '../lib/csv';
import { BrokerAnalysis } from '../components/investments/BrokerAnalysis';
import { PERIOD_PRESETS, formatDate, periodFor, type PeriodPreset } from '../lib/dates';
import { formatMoney, toNumber } from '../lib/money';
import type { CategoryBreakdown } from '../types';

type Tab = 'CASHFLOW' | 'SPENDING' | 'INCOME' | 'BALANCES' | 'PORTFOLIO';
const TABS: { id: Tab; label: string }[] = [
  { id: 'CASHFLOW', label: 'Cash flow' },
  { id: 'SPENDING', label: 'Spending' },
  { id: 'INCOME', label: 'Income' },
  { id: 'BALANCES', label: 'Net worth' },
  { id: 'PORTFOLIO', label: 'Zerodha portfolio' },
];

function BreakdownTable({ breakdown, noun }: { breakdown: CategoryBreakdown; noun: string }) {
  if (breakdown.results.length === 0) {
    return <p className="card" style={{ padding: '24px', color: 'var(--muted)', fontSize: '12px' }}>No {noun} recorded in this period.</p>;
  }
  return (
    <table className="card data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
          <th scope="col" style={{ padding: '12px 16px' }}>Category</th>
          <th scope="col" style={{ textAlign: 'right' }}>Transactions</th>
          <th scope="col" style={{ textAlign: 'right' }}>Share</th>
          <th scope="col" style={{ textAlign: 'right', paddingRight: '16px' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.results.map((row) => (
          <tr key={row.category_id ?? row.category} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={{ padding: '10px 16px' }}>{row.category}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{row.count}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{row.percentage}%</td>
            <td className="mono" style={{ textAlign: 'right', paddingRight: '16px' }}>{formatMoney(row.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr style={{ borderTop: '2px solid var(--border)' }}>
          <th scope="row" style={{ padding: '10px 16px', textAlign: 'left' }}>Total</th>
          <td /><td />
          <td className="mono" style={{ textAlign: 'right', paddingRight: '16px' }}><strong>{formatMoney(breakdown.total)}</strong></td>
        </tr>
      </tfoot>
    </table>
  );
}

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('CASHFLOW');
  const [preset, setPreset] = useState<PeriodPreset>('THIS_MONTH');
  const period = useMemo(() => periodFor(preset), [preset]);

  // The same endpoint as the dashboard, so the two can never disagree.
  const { data, loading, error, forbidden, reload } = useTenantQuery(
    () => reportsApi.dashboard(period, 12),
    [period.date_from, period.date_to],
    { topics: ['accounts', 'transactions', 'reports'] }
  );

  const exportCsv = () => {
    if (!data) return;
    const stamp = `${data.period.date_from}_to_${data.period.date_to}`;
    if (tab === 'CASHFLOW') {
      downloadCsv('fintrace-cash-flow.csv', [['Month', 'Income', 'Expenses', 'Net'], ...data.cashflow.map((p) => [p.month, p.income, p.expenses, p.net])]);
    } else if (tab === 'BALANCES') {
      downloadCsv('fintrace-net-worth.csv', [
        ['Account', 'Kind', 'Currency', 'Balance', `Balance (${data.currency.code})`],
        ...data.accounts.map((a) => [a.name, a.category === 'ASSET' ? 'Have' : 'Owe', a.currency_code, a.balance_amount, a.balance_base_amount]),
      ]);
    } else {
      const breakdown = tab === 'SPENDING' ? data.spending_by_category : data.income_by_category;
      downloadCsv(`fintrace-${tab.toLowerCase()}-${stamp}.csv`, [['Category', 'Transactions', 'Share %', 'Amount'], ...breakdown.results.map((r) => [r.category, r.count, r.percentage, r.amount]), ['Total', '', '', breakdown.total]]);
    }
  };

  const usesPeriod = tab === 'SPENDING' || tab === 'INCOME';
  const assets = data?.accounts.filter((a) => a.category === 'ASSET') ?? [];
  const liabilities = data?.accounts.filter((a) => a.category === 'LIABILITY') ?? [];

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Figures calculated from your recorded transactions. Reversed transactions cancel out; transfers are not income or spending."
        action={tab === 'PORTFOLIO' ? undefined : <Button kind="secondary" icon="download" disabled={!data} onClick={exportCsv}>Export CSV</Button>}
      />

      <div className="toolbar" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="tabs" role="tablist" aria-label="Report" style={{ margin: 0 }}>
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {usesPeriod && (
          <label style={{ fontSize: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            Period
            <select aria-label="Period" value={preset} onChange={(e) => setPreset(e.target.value as PeriodPreset)}>
              {PERIOD_PRESETS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
      </div>

      {tab === 'PORTFOLIO' && <BrokerAnalysis />}

      {tab !== 'PORTFOLIO' && loading && !data && <LoadingSkeleton lines={5} message="Calculating report…" />}
      {tab !== 'PORTFOLIO' && forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view reports in this workspace.</div>}
      {tab !== 'PORTFOLIO' && error && !forbidden && <ErrorState error={error} onRetry={reload} />}

      {tab !== 'PORTFOLIO' && data && (
        <div style={{ opacity: loading ? 0.6 : 1 }} aria-busy={loading}>
          {usesPeriod && <p style={{ fontSize: '12px', color: 'var(--muted)' }}>{formatDate(data.period.date_from)} – {formatDate(data.period.date_to)}</p>}
          {tab === 'CASHFLOW' && (
            <>
              <CashflowChart points={data.cashflow} />
              <table className="card data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <caption className="sr-only">Income, expenses and net by month</caption>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                    <th scope="col" style={{ padding: '12px 16px' }}>Month</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Income</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Expenses</th>
                    <th scope="col" style={{ textAlign: 'right', paddingRight: '16px' }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cashflow.map((p) => (
                    <tr key={p.month_start} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 16px' }}>{p.month}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(p.income)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(p.expenses)}</td>
                      <td className={`mono ${toNumber(p.net) >= 0 ? 'good' : 'text-danger'}`} style={{ textAlign: 'right', paddingRight: '16px' }}>{formatMoney(p.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {tab === 'SPENDING' && <BreakdownTable breakdown={data.spending_by_category} noun="expenses" />}
          {tab === 'INCOME' && <BreakdownTable breakdown={data.income_by_category} noun="income" />}
          {tab === 'BALANCES' && (
            <div className="card" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', gap: '40px', flexWrap: 'wrap', marginBottom: '16px' }}>
                <div><span className="eyebrow">Net worth</span><strong className="mono" style={{ display: 'block', fontSize: '24px' }}>{formatMoney(data.totals.net_worth)}</strong></div>
                <div><span className="eyebrow">What you have</span><strong className="mono" style={{ display: 'block', fontSize: '18px' }}>{formatMoney(data.totals.assets)}</strong></div>
                <div><span className="eyebrow">What you owe</span><strong className="mono" style={{ display: 'block', fontSize: '18px' }}>{formatMoney(data.totals.liabilities)}</strong></div>
              </div>
              {[['What you have', assets] as const, ['What you owe', liabilities] as const].map(([title, list]) => (
                <section key={title} aria-label={title} style={{ marginBottom: '12px' }}>
                  <h3 style={{ fontSize: '12px', color: 'var(--muted)', margin: '0 0 4px' }}>{title}</h3>
                  {list.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Nothing here.</p>
                  ) : (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {list.map((a) => (
                        <li key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                          <span>{a.name}{!a.is_active ? ' (archived)' : ''}</span>
                          <span className="mono">{formatMoney(a.balance_amount, a.currency_code)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
              <small style={{ color: 'var(--muted)' }}>Totals are in {data.currency.code}. Investments are counted at what you paid for them.</small>
            </div>
          )}
        </div>
      )}
    </>
  );
}
