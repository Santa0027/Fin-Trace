import { Button } from '../common/Button';
import { LoadingSkeleton } from '../common/LoadingSkeleton';
import { ErrorState } from '../common/ErrorState';
import { brokerApi } from '../../lib/api/brokerApi';
import { downloadCsv } from '../../lib/csv';
import { useTenantQuery } from '../../hooks/useTenantQuery';
import { formatMoney, toNumber } from '../../lib/money';
import { formatDate } from '../../lib/dates';
import type { BrokerAnalytics } from '../../types';

const cell = { padding: '9px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
const left = { ...cell, textAlign: 'left' as const, paddingLeft: '16px', whiteSpace: 'normal' as const };
const tone = (value: number | string | null | undefined) => (toNumber(value) > 0 ? 'good' : toNumber(value) < 0 ? 'text-danger' : '');
const signed = (value: string | number, currency: string) => `${toNumber(value) > 0 ? '+' : toNumber(value) < 0 ? '−' : ''}${formatMoney(Math.abs(toNumber(value)), currency)}`;
const percent = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`);
const TONE_MARK = { good: '▲', warn: '!', info: '•' } as const;

function Stat({ label, value, sub, className = '' }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <strong className={`mono ${className}`} style={{ display: 'block', fontSize: '18px' }}>{value}</strong>
      {sub && <small style={{ color: 'var(--muted)' }}>{sub}</small>}
    </div>
  );
}

export function exportPortfolioCsv(data: BrokerAnalytics): void {
  const rows = data.holdings ?? [];
  const stamp = (data.connection?.last_synced_at ?? '').slice(0, 10) || 'latest';
  downloadCsv(`zerodha-portfolio-${stamp}.csv`, [
    ['Type', 'Symbol', 'Name', 'Exchange', 'Folio', 'ISIN', 'Quantity', 'Average price', 'Last price', 'Invested', 'Current value', 'Profit/loss', 'Profit/loss %', "Today's change", 'Share of portfolio %'],
    ...rows.map((row) => [
      row.asset_class === 'EQUITY' ? 'Stock/ETF (Kite)' : 'Mutual fund (Coin)', row.symbol, row.name, row.exchange, row.folio, row.isin, row.quantity, row.average_price,
      row.last_price, row.invested_value, row.current_value, row.pnl, row.pnl_percent, row.day_change, row.allocation_percent,
    ]),
    [],
    ['Total', '', '', '', '', '', '', '', '', data.summary?.invested_value, data.summary?.current_value, data.summary?.pnl, data.summary?.pnl_percent, data.summary?.day_change, 100],
  ]);
}

/**
 * Analysis of the connected Zerodha portfolio: how concentrated it is, how it has
 * moved, what is committed through SIPs. Every figure comes from the backend.
 */
export function BrokerAnalysis() {
  const { data, loading, error, forbidden, reload } = useTenantQuery(() => brokerApi.analytics(), [], { topics: ['broker'] });

  if (loading && !data) return <LoadingSkeleton lines={5} message="Analysing your portfolio…" />;
  if (forbidden) return <div className="card app-state error-state" role="alert">You do not have permission to view investments in this workspace.</div>;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const analysis = data.analysis;
  if (!data.connection || !analysis) {
    return (
      <p className="card" style={{ padding: '24px', fontSize: '13px' }}>
        There is no Zerodha portfolio to analyse yet. Connect your account under Investments → Zerodha portfolio, then refresh.
      </p>
    );
  }

  const { currency } = data;
  const { concentration, performance, totals, sips, positions, holding_changes: changes } = analysis;
  const periods = analysis.periods.filter((period) => period.available);
  const topHoldings = [...(data.holdings ?? [])].slice(0, 8);
  const otherShare = Math.max(0, 100 - topHoldings.reduce((sum, row) => sum + row.allocation_percent, 0));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <small style={{ color: 'var(--muted)' }}>
          {data.connection.status === 'SAMPLE' ? 'Sample data from the demo seed. ' : ''}
          Based on Zerodha's figures{analysis.as_of ? ` as of ${new Date(analysis.as_of).toLocaleString()}` : ''}. Not part of your FinTrace net worth.
        </small>
        <Button kind="secondary" icon="download" onClick={() => exportPortfolioCsv(data)}>Export holdings (CSV)</Button>
      </div>

      {analysis.insights.length > 0 && (
        <section className="card" aria-label="What stands out" style={{ padding: '16px 20px', marginBottom: '14px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>What stands out</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '12.5px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {analysis.insights.map((note) => (
              <li key={note.text} style={{ display: 'flex', gap: '8px' }}>
                <span aria-hidden="true" className={note.tone === 'good' ? 'good' : note.tone === 'warn' ? 'text-danger' : ''} style={{ width: '12px', flexShrink: 0, fontWeight: 700 }}>{TONE_MARK[note.tone]}</span>
                <span>{note.tone === 'warn' && <span className="sr-only">Worth attention: </span>}{note.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-label="Totals" style={{ padding: '18px 24px', marginBottom: '14px', display: 'flex', gap: '36px', flexWrap: 'wrap' }}>
        <Stat label="Holdings value" value={formatMoney(totals.holdings_value, currency)} sub={`${concentration.holding_count} holdings`} />
        <Stat label="Uninvested cash" value={totals.cash_available === null ? '—' : formatMoney(totals.cash_available, currency)} sub={totals.cash_available === null ? 'Not reported by Zerodha' : 'In the trading account'} />
        <Stat label="Holdings + cash" value={totals.total_with_cash === null ? '—' : formatMoney(totals.total_with_cash, currency)} />
        <Stat label="In profit / in loss" value={`${performance.winners} / ${performance.losers}`} sub={`${signed(performance.gains, currency)} and ${signed(performance.losses, currency)}`} />
        {totals.open_positions_pnl !== null && <Stat label="Open positions" value={signed(totals.open_positions_pnl, currency)} sub={`${positions.length} open`} className={tone(totals.open_positions_pnl)} />}
      </section>

      <section className="card" aria-label="Change over time" style={{ marginBottom: '14px', overflowX: 'auto' }}>
        <div style={{ padding: '14px 16px 4px' }}>
          <h2 style={{ fontSize: '14px', margin: 0 }}>Change over time</h2>
          <small style={{ color: 'var(--muted)' }}>Market movement is the change in value after taking out money you added or withdrew.</small>
        </div>
        {periods.length === 0 ? (
          <p style={{ padding: '8px 16px 16px', fontSize: '12px', color: 'var(--muted)' }}>
            FinTrace records one snapshot each day you sync. Come back after syncing on another day to see how the portfolio moved.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '620px' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th scope="col" style={left}>Period</th>
                <th scope="col" style={cell}>Value then</th>
                <th scope="col" style={cell}>Change in value</th>
                <th scope="col" style={cell}>Money added</th>
                <th scope="col" style={{ ...cell, paddingRight: '16px' }}>Market movement</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.code} style={{ borderTop: '1px solid var(--border)' }}>
                  <th scope="row" style={{ ...left, fontWeight: 400 }}>{period.label}<small style={{ display: 'block', color: 'var(--muted)' }}>from {formatDate(period.from_date)}</small></th>
                  <td className="mono" style={cell}>{formatMoney(period.value_then, currency)}</td>
                  <td className={`mono ${tone(period.value_change)}`} style={cell}>{signed(period.value_change ?? 0, currency)}</td>
                  <td className="mono" style={cell}>{signed(period.net_invested ?? 0, currency)}</td>
                  <td className={`mono ${tone(period.market_movement)}`} style={{ ...cell, paddingRight: '16px' }}>
                    <strong>{signed(period.market_movement ?? 0, currency)}</strong>
                    <small style={{ display: 'block' }}>{percent(period.market_movement_percent)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="dashboard-grid" style={{ marginBottom: '14px' }}>
        <section className="card" aria-label="Concentration" style={{ padding: '16px 20px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 10px' }}>How concentrated it is</h2>
          <dl style={{ margin: 0, fontSize: '12px' }}>
            {[
              ['Largest holding', `${concentration.largest.name || concentration.largest.symbol} · ${concentration.largest.allocation_percent.toFixed(1)}%`],
              ['Largest 3 together', `${concentration.top_3_percent.toFixed(1)}%`],
              ['Largest 5 together', `${concentration.top_5_percent.toFixed(1)}%`],
              ['Spread is like', `${concentration.effective_holdings} equal holdings (you have ${concentration.holding_count})`],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <dt style={{ color: 'var(--muted)' }}>{label}</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="card" aria-label="Share of each holding" style={{ padding: '16px 20px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 10px' }}>Share of each holding</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '12px' }}>
            {topHoldings.map((row) => (
              <li key={row.id} style={{ marginBottom: '7px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name || row.symbol}</span>
                  <span className="mono">{row.allocation_percent.toFixed(1)}%</span>
                </div>
                <div aria-hidden="true" style={{ height: '5px', background: 'var(--surface-3)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, row.allocation_percent)}%`, background: row.asset_class === 'EQUITY' ? 'var(--primary)' : '#4b88bd' }} />
                </div>
              </li>
            ))}
            {otherShare > 0.05 && <li style={{ color: 'var(--muted)' }}>Everything else: {otherShare.toFixed(1)}%</li>}
          </ul>
          <small style={{ color: 'var(--muted)' }}>Green: stocks and ETFs. Blue: mutual funds.</small>
        </section>
      </div>

      {changes.rows.length > 0 && (
        <section className="card" aria-label="Movement by holding" style={{ marginBottom: '14px', overflowX: 'auto' }}>
          <div style={{ padding: '14px 16px 4px' }}>
            <h2 style={{ fontSize: '14px', margin: 0 }}>Movement by holding since {formatDate(changes.from_date)}</h2>
            <small style={{ color: 'var(--muted)' }}>Which holdings drove the change, after taking out anything you bought or sold.</small>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '560px' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th scope="col" style={left}>Holding</th>
                <th scope="col" style={cell}>Value then</th>
                <th scope="col" style={cell}>Value now</th>
                <th scope="col" style={{ ...cell, paddingRight: '16px' }}>Market movement</th>
              </tr>
            </thead>
            <tbody>
              {changes.rows.map((row) => (
                <tr key={`${row.asset_class}-${row.symbol}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <th scope="row" style={{ ...left, fontWeight: 400 }}>{row.name || row.symbol}</th>
                  <td className="mono" style={cell}>{row.value_then === null ? 'New' : formatMoney(row.value_then, currency)}</td>
                  <td className="mono" style={cell}>{formatMoney(row.value_now, currency)}</td>
                  <td className={`mono ${tone(row.market_movement)}`} style={{ ...cell, paddingRight: '16px' }}>
                    {row.market_movement === null ? '—' : <>{signed(row.market_movement, currency)}<small style={{ display: 'block' }}>{percent(row.market_movement_percent)}</small></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card" aria-label="SIPs" style={{ marginBottom: '14px', overflowX: 'auto' }}>
        <div style={{ padding: '14px 16px 4px', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '14px', margin: 0 }}>SIPs on Coin</h2>
            <small style={{ color: 'var(--muted)' }}>Regular mutual fund investments set up with Zerodha.</small>
          </div>
          {sips.active_count > 0 && (
            <div style={{ textAlign: 'right' }}>
              <strong className="mono">{formatMoney(sips.monthly_commitment, currency)}</strong> <small>a month</small>
              <small style={{ display: 'block', color: 'var(--muted)' }}>{formatMoney(sips.yearly_commitment, currency)} a year across {sips.active_count} active</small>
            </div>
          )}
        </div>
        {sips.rows.length === 0 ? (
          <p style={{ padding: '8px 16px 16px', fontSize: '12px', color: 'var(--muted)' }}>No SIPs were reported for this account.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '560px' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th scope="col" style={left}>Fund</th>
                <th scope="col" style={cell}>Amount</th>
                <th scope="col" style={cell}>How often</th>
                <th scope="col" style={cell}>Next</th>
                <th scope="col" style={{ ...cell, paddingRight: '16px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sips.rows.map((sip) => (
                <tr key={sip.sip_id || `${sip.symbol}-${sip.instalment_amount}`} style={{ borderTop: '1px solid var(--border)', opacity: sip.status === 'ACTIVE' ? 1 : 0.6 }}>
                  <th scope="row" style={{ ...left, fontWeight: 400 }}>{sip.fund || sip.symbol}<small style={{ display: 'block', color: 'var(--muted)' }}>{sip.completed_instalments} paid{sip.pending_instalments >= 0 ? `, ${sip.pending_instalments} to go` : ', runs until cancelled'}</small></th>
                  <td className="mono" style={cell}>{formatMoney(sip.instalment_amount, currency)}</td>
                  <td style={cell}>{sip.frequency ? sip.frequency[0].toUpperCase() + sip.frequency.slice(1) : '—'}</td>
                  <td style={cell}>{sip.status === 'ACTIVE' ? formatDate(sip.next_instalment) : '—'}</td>
                  <td style={{ ...cell, paddingRight: '16px' }}>{sip.status ? sip.status[0] + sip.status.slice(1).toLowerCase() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {positions.length > 0 && (
        <section className="card" aria-label="Open positions" style={{ marginBottom: '14px', overflowX: 'auto' }}>
          <div style={{ padding: '14px 16px 4px' }}>
            <h2 style={{ fontSize: '14px', margin: 0 }}>Open positions</h2>
            <small style={{ color: 'var(--muted)' }}>Trades still open in the account (intraday or derivatives). Not counted in holdings value.</small>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '520px' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th scope="col" style={left}>Instrument</th>
                <th scope="col" style={cell}>Quantity</th>
                <th scope="col" style={cell}>Average</th>
                <th scope="col" style={cell}>Last price</th>
                <th scope="col" style={{ ...cell, paddingRight: '16px' }}>Profit / loss</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((row) => (
                <tr key={`${row.symbol}-${row.product}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <th scope="row" style={{ ...left, fontWeight: 400 }}>{row.symbol}<small style={{ display: 'block', color: 'var(--muted)' }}>{[row.exchange, row.product].filter(Boolean).join(' · ')}</small></th>
                  <td className="mono" style={cell}>{Number(row.quantity)}</td>
                  <td className="mono" style={cell}>{formatMoney(row.average_price, currency)}</td>
                  <td className="mono" style={cell}>{formatMoney(row.last_price, currency)}</td>
                  <td className={`mono ${tone(row.pnl)}`} style={{ ...cell, paddingRight: '16px' }}>{signed(row.pnl, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
