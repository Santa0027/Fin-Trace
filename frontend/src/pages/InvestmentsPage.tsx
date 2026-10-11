import { useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { BrokerPortfolio } from '../components/investments/BrokerPortfolio';
import { TradeModal } from '../components/modals/TradeModal';
import { DividendModal } from '../components/modals/DividendModal';
import { useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { investmentsApi } from '../lib/api/investmentsApi';
import { formatMoney, toNumber } from '../lib/money';
import { formatDate } from '../lib/dates';
import type { Dividend, Holding, Trade } from '../types';

export function InvestmentsPage() {
  const { canCreateInvestments } = useFinancialPermissions();
  const [view, setView] = useState<'BROKER' | 'RECORDED'>('BROKER');
  const [tradeOpen, setTradeOpen] = useState(false);
  const [dividendOpen, setDividendOpen] = useState(false);

  const holdingsQuery = useTenantQuery(() => investmentsApi.holdings(), [], { topics: ['investments'] });
  const tradesQuery = useTenantQuery(() => investmentsApi.trades(20), [], { topics: ['investments'] });
  const dividendsQuery = useTenantQuery(() => investmentsApi.dividends(20), [], { topics: ['investments'] });

  const holdings = holdingsQuery.data?.results ?? [];
  const trades = tradesQuery.data?.results ?? [];
  const dividends = dividendsQuery.data?.results ?? [];

  return (
    <>
      <PageHeader
        title="Investments"
        subtitle={view === 'BROKER'
          ? 'Your Zerodha portfolio at market prices: stocks and ETFs from Kite, mutual funds from Coin.'
          : 'Trades you recorded in FinTrace. These are part of your accounts and net worth, shown at what you paid.'}
        action={
          view === 'RECORDED' && canCreateInvestments ? (
            <div className="title-actions">
              {holdings.length > 0 && <Button kind="secondary" icon="income" onClick={() => setDividendOpen(true)}>Record dividend</Button>}
              <Button kind="primary" icon="plus" onClick={() => setTradeOpen(true)}>Record trade</Button>
            </div>
          ) : undefined
        }
      />

      <div className="tabs" role="tablist" aria-label="Investments view">
        <button type="button" role="tab" aria-selected={view === 'BROKER'} className={view === 'BROKER' ? 'active' : ''} onClick={() => setView('BROKER')}>Zerodha portfolio</button>
        <button type="button" role="tab" aria-selected={view === 'RECORDED'} className={view === 'RECORDED' ? 'active' : ''} onClick={() => setView('RECORDED')}>Recorded in FinTrace</button>
      </div>

      {view === 'BROKER' && <BrokerPortfolio />}
      {view === 'RECORDED' && <RecordedInvestments holdingsQuery={holdingsQuery} tradesQuery={tradesQuery} dividendsQuery={dividendsQuery} holdings={holdings} trades={trades} dividends={dividends} canCreateInvestments={canCreateInvestments} openTrade={() => setTradeOpen(true)} />}

      {tradeOpen && <TradeModal holdings={holdings} close={() => setTradeOpen(false)} saved={() => setTradeOpen(false)} />}
      {dividendOpen && <DividendModal holdings={holdings} close={() => setDividendOpen(false)} saved={() => setDividendOpen(false)} />}
    </>
  );
}

type Query<T> = { data: T | undefined; loading: boolean; error: string | null; forbidden: boolean; reload: () => Promise<void> };

function RecordedInvestments({ holdingsQuery, tradesQuery, dividendsQuery, holdings, trades, dividends, canCreateInvestments, openTrade }: {
  holdingsQuery: Query<unknown>; tradesQuery: Query<unknown>; dividendsQuery: Query<unknown>;
  holdings: Holding[]; trades: Trade[]; dividends: Dividend[]; canCreateInvestments: boolean; openTrade: () => void;
}) {
  const setTradeOpen = (_open: boolean) => openTrade();
  return (
    <>
      {holdingsQuery.loading && !holdingsQuery.data && <LoadingSkeleton lines={4} message="Loading holdings…" />}
      {holdingsQuery.forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view investments in this workspace.</div>}
      {holdingsQuery.error && !holdingsQuery.forbidden && <ErrorState error={holdingsQuery.error} onRetry={holdingsQuery.reload} />}

      {holdingsQuery.data && !holdingsQuery.error && holdings.length === 0 && (
        <EmptyState title="No holdings yet" message="Record your first purchase to start tracking what you own and what you paid for it."
          actionText={canCreateInvestments ? 'Record a purchase' : undefined} actionIcon="plus" onAction={canCreateInvestments ? () => setTradeOpen(true) : undefined} />
      )}

      {holdings.length > 0 && (
        <table className="card data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginBottom: '14px' }}>
          <caption className="sr-only">Holdings</caption>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th scope="col" style={{ padding: '12px 16px' }}>Investment</th>
              <th scope="col">Portfolio</th>
              <th scope="col" style={{ textAlign: 'right' }}>Quantity</th>
              <th scope="col" style={{ textAlign: 'right' }}>Average cost</th>
              <th scope="col" style={{ textAlign: 'right', paddingRight: '16px' }}>Total cost</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.position_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '12px 16px' }}><strong>{h.symbol}</strong><small style={{ display: 'block', color: 'var(--muted)' }}>{h.instrument_name}</small></td>
                <td>{h.portfolio_name}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{Number(h.quantity)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{formatMoney(h.average_cost, h.currency_code)}</td>
                <td className="mono" style={{ textAlign: 'right', paddingRight: '16px' }}><strong>{formatMoney(h.cost_value, h.currency_code)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(tradesQuery.error || dividendsQuery.error) && (
        <ErrorState error={`Could not load investment activity. ${tradesQuery.error ?? dividendsQuery.error}`} onRetry={() => { void tradesQuery.reload(); void dividendsQuery.reload(); }} />
      )}

      {trades.length > 0 && (
        <section className="card" aria-label="Recent trades" style={{ padding: '16px 20px', marginBottom: '14px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Recent trades</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {trades.map((t) => {
              const gain = toNumber(t.realized_pnl);
              return (
                <li key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                  <span>
                    <strong>{t.trade_type === 'BUY' ? 'Bought' : 'Sold'} {Number(t.quantity)} {t.symbol}</strong> at {formatMoney(t.price, t.currency_code)}
                    <small style={{ display: 'block', color: 'var(--muted)' }}>{formatDate(t.traded_at)}{t.cash_account_name ? ` · ${t.cash_account_name}` : ''}</small>
                  </span>
                  <span style={{ textAlign: 'right' }}>
                    <strong className="mono">{formatMoney(t.gross_amount, t.currency_code)}</strong>
                    {t.trade_type === 'SELL' && gain !== 0 && (
                      <small className={gain > 0 ? 'good' : 'text-danger'} style={{ display: 'block' }}>{gain > 0 ? 'Gain' : 'Loss'} {formatMoney(Math.abs(gain), t.currency_code)}</small>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {dividends.length > 0 && (
        <section className="card" aria-label="Recent dividends" style={{ padding: '16px 20px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Recent dividends</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {dividends.map((d) => (
              <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                <span><strong>{d.symbol}</strong>{d.is_reversed && <small> · reversed</small>}<small style={{ display: 'block', color: 'var(--muted)' }}>{formatDate(d.paid_on)}{d.cash_account_name ? ` · ${d.cash_account_name}` : ''}</small></span>
                <strong className={`mono ${d.is_reversed ? '' : 'good'}`} style={{ textDecoration: d.is_reversed ? 'line-through' : undefined }}>+{formatMoney(d.amount, d.currency_code)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

    </>
  );
}
