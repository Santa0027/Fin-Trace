import { useState } from 'react';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSkeleton } from '../common/LoadingSkeleton';
import { ErrorState } from '../common/ErrorState';
import { ApiError, errorMessage } from '../../lib/api/apiClient';
import { brokerApi } from '../../lib/api/brokerApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { useFinancialPermissions } from '../../hooks/useFinancialPermissions';
import { formatMoney, toNumber } from '../../lib/money';
import { formatDate } from '../../lib/dates';
import { BrokerAnalysis } from './BrokerAnalysis';
import type { BrokerHolding, BrokerPortfolio as Portfolio } from '../../types';

const cell = { padding: '10px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
const tone = (value: number | string | null | undefined) => (toNumber(value) > 0 ? 'good' : toNumber(value) < 0 ? 'text-danger' : '');
const signed = (value: string | number, currency: string) => `${toNumber(value) > 0 ? '+' : toNumber(value) < 0 ? '−' : ''}${formatMoney(Math.abs(toNumber(value)), currency)}`;
const percent = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`);
const units = (value: string) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });

function Tile({ label, value, sub, className = '', large = false }: { label: string; value: string; sub?: string; className?: string; large?: boolean }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <strong className={`mono ${className}`} style={{ display: 'block', fontSize: large ? '30px' : '18px', lineHeight: 1.15 }}>{value}</strong>
      {sub && <small className={className} style={{ color: className ? undefined : 'var(--muted)' }}>{sub}</small>}
    </div>
  );
}

/** Value over time, from one point per day FinTrace synced. */
function ValueHistory({ history, currency }: { history: NonNullable<Portfolio['history']>; currency: string }) {
  if (history.length < 2) return null;
  const width = 640;
  const height = 120;
  const values = history.flatMap((point) => [toNumber(point.current_value), toNumber(point.invested_value)]);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const line = (key: 'current_value' | 'invested_value') =>
    history.map((point, i) => `${(i / (history.length - 1)) * width},${height - ((toNumber(point[key]) - min) / span) * (height - 8) - 4}`).join(' ');
  const first = history[0];
  const last = history[history.length - 1];
  return (
    <section className="card" aria-label="Portfolio value over time" style={{ padding: '16px 20px', marginBottom: '14px' }}>
      <div className="card-head">
        <h2 style={{ fontSize: '14px', margin: 0 }}>Value over time</h2>
        <div className="legend" style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
          <span><i style={{ display: 'inline-block', width: 10, height: 2, background: 'var(--primary)', marginRight: 4, verticalAlign: 'middle' }} />Current value</span>
          <span><i style={{ display: 'inline-block', width: 10, height: 2, background: 'var(--muted)', marginRight: 4, verticalAlign: 'middle' }} />Invested</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="none" style={{ width: '100%', height: '120px' }}
        aria-label={`Value went from ${formatMoney(first.current_value, currency)} on ${formatDate(first.snapshot_date)} to ${formatMoney(last.current_value, currency)} on ${formatDate(last.snapshot_date)}`}>
        <polyline points={line('invested_value')} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <polyline points={line('current_value')} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--muted)' }}>
        <span>{formatDate(first.snapshot_date)}</span>
        <span>One point per day synced</span>
        <span>{formatDate(last.snapshot_date)}</span>
      </div>
    </section>
  );
}

function HoldingsTable({ title, caption, rows, currency, fund }: { title: string; caption: string; rows: BrokerHolding[]; currency: string; fund: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section className="card" aria-label={title} style={{ marginBottom: '14px', overflowX: 'auto' }}>
      <div style={{ padding: '14px 16px 4px' }}>
        <h2 style={{ fontSize: '14px', margin: 0 }}>{title}</h2>
        <small style={{ color: 'var(--muted)' }}>{caption}</small>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '760px' }}>
        <thead>
          <tr style={{ color: 'var(--muted)' }}>
            <th scope="col" style={{ ...cell, textAlign: 'left', paddingLeft: '16px' }}>{fund ? 'Fund' : 'Instrument'}</th>
            <th scope="col" style={cell}>{fund ? 'Units' : 'Qty'}</th>
            <th scope="col" style={cell}>{fund ? 'Avg NAV' : 'Avg price'}</th>
            <th scope="col" style={cell}>{fund ? 'NAV' : 'Last price'}</th>
            <th scope="col" style={cell}>Invested</th>
            <th scope="col" style={cell}>Current value</th>
            <th scope="col" style={cell}>Profit / loss</th>
            {!fund && <th scope="col" style={cell}>Today</th>}
            <th scope="col" style={{ ...cell, paddingRight: '16px' }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
              <th scope="row" style={{ ...cell, textAlign: 'left', paddingLeft: '16px', fontWeight: 400 }}>
                <strong style={{ display: 'block', whiteSpace: 'normal' }}>{fund ? row.name || row.symbol : row.symbol}</strong>
                <small style={{ color: 'var(--muted)' }}>{fund ? `Folio ${row.folio || '—'}` : row.exchange}</small>
              </th>
              <td className="mono" style={cell}>{units(row.quantity)}</td>
              <td className="mono" style={cell}>{formatMoney(row.average_price, currency)}</td>
              <td className="mono" style={cell}>{formatMoney(row.last_price, currency)}</td>
              <td className="mono" style={cell}>{formatMoney(row.invested_value, currency)}</td>
              <td className="mono" style={cell}><strong>{formatMoney(row.current_value, currency)}</strong></td>
              <td className={`mono ${tone(row.pnl)}`} style={cell}>{signed(row.pnl, currency)}<small style={{ display: 'block' }}>{percent(row.pnl_percent)}</small></td>
              {!fund && (
                <td className={`mono ${tone(row.day_change)}`} style={cell}>
                  {row.day_change === null ? '—' : signed(row.day_change, currency)}
                  {row.day_change !== null && <small style={{ display: 'block' }}>{percent(row.day_change_percent)}</small>}
                </td>
              )}
              <td className="mono" style={{ ...cell, paddingRight: '16px' }}>{row.allocation_percent.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The user's Zerodha portfolio: Kite holdings (stocks, ETFs) and Coin holdings (mutual funds), at market prices. */
export function BrokerPortfolio() {
  const { canManageBroker } = useFinancialPermissions();
  const { data, loading, error, forbidden, reload } = useTenantQuery(() => brokerApi.portfolio(), [], { topics: ['broker'] });
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [section, setSection] = useState<'OVERVIEW' | 'ANALYSIS'>('OVERVIEW');

  const connect = async () => {
    setBusy('connect');
    setActionError(null);
    try {
      const { login_url } = await brokerApi.connect();
      window.location.assign(login_url); // Zerodha's own sign-in page; FinTrace never sees the password
    } catch (err) {
      setActionError(errorMessage(err, 'Could not start the Zerodha sign-in.'));
      setBusy(null);
    }
  };

  const run = async (action: 'sync' | 'disconnect') => {
    setBusy(action);
    setActionError(null);
    try {
      await (action === 'sync' ? brokerApi.sync() : brokerApi.disconnect());
      setConfirmDisconnect(false);
    } catch (err) {
      setActionError(errorMessage(err, action === 'sync' ? 'Could not refresh from Zerodha.' : 'Could not disconnect.'));
      // An expired session changes the connection's status; show that too.
      if (!(err instanceof ApiError) || err.status !== 409) setConfirmDisconnect(false);
    } finally {
      notifyDataChanged(['broker']);
      setBusy(null);
    }
  };

  if (loading && !data) return <LoadingSkeleton lines={4} message="Loading your Zerodha portfolio…" />;
  if (forbidden) return <div className="card app-state error-state" role="alert">You do not have permission to view investments in this workspace.</div>;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { connection, currency } = data;
  const status = connection?.status;
  const live = status === 'CONNECTED';

  if (!connection || status === 'DISCONNECTED') {
    return (
      <section className="card" aria-label="Connect Zerodha" style={{ padding: '24px', maxWidth: '640px' }}>
        <h2 style={{ fontSize: '16px', marginTop: 0 }}>Connect your Zerodha account</h2>
        <p style={{ fontSize: '13px' }}>
          See your Kite holdings (stocks and ETFs) and Coin holdings (mutual funds) here, with current value, profit and loss, and allocation.
        </p>
        <ul style={{ fontSize: '12px', color: 'var(--text-2)', paddingLeft: '18px' }}>
          <li>Read-only. FinTrace cannot place orders or move money.</li>
          <li>You sign in on Zerodha's own page; FinTrace never sees your password or PIN.</li>
          <li>Zerodha signs every connected app out each morning, so you reconnect when you want fresh figures.</li>
        </ul>
        {actionError && <div className="auth-error" role="alert">{actionError}</div>}
        {!data.configured ? (
          <p className="callout" role="status" style={{ fontSize: '12px', padding: '10px 14px' }}>
            This server has no Zerodha API credentials yet. Whoever runs it needs to add <code>KITE_API_KEY</code> and <code>KITE_API_SECRET</code> (from developers.kite.trade) and restart.
          </p>
        ) : canManageBroker ? (
          <Button kind="primary" icon="plug" disabled={busy !== null} onClick={() => void connect()}>{busy === 'connect' ? 'Opening Zerodha…' : 'Connect Zerodha'}</Button>
        ) : (
          <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Ask a workspace member who can edit investments to connect it.</p>
        )}
      </section>
    );
  }

  const summary = data.summary;
  const holdings = data.holdings ?? [];
  const equity = holdings.filter((row) => row.asset_class === 'EQUITY');
  const funds = holdings.filter((row) => row.asset_class === 'MUTUAL_FUND');

  return (
    <>
      <section className="card" aria-label="Zerodha connection" style={{ padding: '14px 20px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong style={{ fontSize: '13px' }}>Zerodha{connection.broker_user_name ? ` · ${connection.broker_user_name}` : ''}</strong>{' '}
          <StatusBadge status={status === 'SAMPLE' ? 'SAMPLE DATA' : status === 'EXPIRED' ? 'SESSION ENDED' : 'CONNECTED'} />
          <small style={{ display: 'block', color: 'var(--muted)' }}>
            {connection.last_synced_at ? `Figures as of ${new Date(connection.last_synced_at).toLocaleString()}` : 'Not synced yet'}
          </small>
        </div>
        {canManageBroker && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {live && <Button kind="primary" icon="refresh" disabled={busy !== null} onClick={() => void run('sync')}>{busy === 'sync' ? 'Refreshing…' : 'Refresh now'}</Button>}
            {status === 'EXPIRED' && data.configured && <Button kind="primary" icon="plug" disabled={busy !== null} onClick={() => void connect()}>{busy === 'connect' ? 'Opening Zerodha…' : 'Reconnect'}</Button>}
            {status === 'SAMPLE' && data.configured && <Button kind="primary" icon="plug" disabled={busy !== null} onClick={() => void connect()}>Connect real account</Button>}
            {status !== 'SAMPLE' && <Button kind="ghost" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>}
          </div>
        )}
      </section>

      {status === 'SAMPLE' && <p className="callout" role="status" style={{ fontSize: '12px', padding: '10px 14px', marginBottom: '14px' }}>This is sample data from the demo seed, not a real Zerodha account.</p>}
      {status === 'EXPIRED' && <p className="callout" role="status" style={{ fontSize: '12px', padding: '10px 14px', marginBottom: '14px' }}>Your Zerodha session has ended, as it does every morning. These are the last figures FinTrace synced; reconnect to refresh them.</p>}
      {actionError && <div className="auth-error" role="alert">{actionError}</div>}
      {connection.last_error && !actionError && live && <div className="auth-error" role="alert">The last refresh failed: {connection.last_error}</div>}

      {confirmDisconnect && (
        <div className="callout" role="group" aria-label="Confirm disconnect" style={{ padding: '12px 14px', marginBottom: '14px' }}>
          <strong>Disconnect Zerodha?</strong>
          <p style={{ fontSize: '12px', margin: '4px 0 8px' }}>FinTrace forgets its access and signs out of Zerodha. The last synced figures stay until you connect again.</p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button kind="danger" disabled={busy !== null} onClick={() => void run('disconnect')}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</Button>
            <Button disabled={busy !== null} onClick={() => setConfirmDisconnect(false)}>Keep connected</Button>
          </div>
        </div>
      )}

      {summary && holdings.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Portfolio view" style={{ marginBottom: '12px' }}>
          <button type="button" role="tab" aria-selected={section === 'OVERVIEW'} className={section === 'OVERVIEW' ? 'active' : ''} onClick={() => setSection('OVERVIEW')}>Holdings</button>
          <button type="button" role="tab" aria-selected={section === 'ANALYSIS'} className={section === 'ANALYSIS' ? 'active' : ''} onClick={() => setSection('ANALYSIS')}>Analysis, SIPs and positions</button>
        </div>
      )}

      {section === 'ANALYSIS' && summary && holdings.length > 0 ? (
        <BrokerAnalysis />
      ) : !summary || holdings.length === 0 ? (
        <p className="card" style={{ padding: '24px', fontSize: '13px' }}>
          {connection.last_synced_at ? 'Zerodha reports no holdings in this account.' : 'Nothing has been synced yet. Refresh to load your holdings.'}
        </p>
      ) : (
        <>
          <section className="card" aria-label="Portfolio summary" style={{ padding: '20px 24px', marginBottom: '14px', display: 'flex', gap: '40px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Tile large label="Current value" value={formatMoney(summary.current_value, currency)} sub={`${summary.holding_count} holding${summary.holding_count === 1 ? '' : 's'} at market price`} />
            <Tile label="Invested" value={formatMoney(summary.invested_value, currency)} />
            <Tile label="Total profit / loss" value={signed(summary.pnl, currency)} sub={percent(summary.pnl_percent)} className={tone(summary.pnl)} />
            <Tile label="Today (stocks and ETFs)" value={summary.day_change === null ? '—' : signed(summary.day_change, currency)}
              sub={summary.day_change === null ? 'No intraday prices' : percent(summary.day_change_percent)} className={tone(summary.day_change)} />
          </section>

          <div className="dashboard-grid" style={{ marginBottom: '14px' }}>
            <section className="card" aria-label="Split by type" style={{ padding: '16px 20px' }}>
              <h2 style={{ fontSize: '14px', margin: '0 0 10px' }}>Where it is held</h2>
              {(data.by_class ?? []).map((row) => (
                <div key={row.asset_class} style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                    <span>{row.label} · {row.holding_count}</span>
                    <span className="mono">{formatMoney(row.current_value, currency)} · {row.allocation_percent.toFixed(1)}%</span>
                  </div>
                  <div aria-hidden="true" style={{ height: '6px', background: 'var(--surface-3)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, row.allocation_percent)}%`, background: 'var(--primary)' }} />
                  </div>
                  <small className={tone(row.pnl)}>{signed(row.pnl, currency)} ({percent(row.pnl_percent)})</small>
                </div>
              ))}
            </section>
            <section className="card" aria-label="Best and worst" style={{ padding: '16px 20px' }}>
              <h2 style={{ fontSize: '14px', margin: '0 0 10px' }}>Best and worst performers</h2>
              {[...(data.top_gainers ?? []), ...(data.top_losers ?? [])].length === 0 ? (
                <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Nothing has moved yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '12px' }}>
                  {[...(data.top_gainers ?? []), ...(data.top_losers ?? [])].map((row) => (
                    <li key={row.symbol} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                      <span>{row.name || row.symbol}</span>
                      <span className={`mono ${tone(row.pnl)}`}>{signed(row.pnl, currency)} · {percent(row.pnl_percent)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <ValueHistory history={data.history ?? []} currency={currency} />
          <HoldingsTable title="Stocks and ETFs" caption="From Kite" rows={equity} currency={currency} fund={false} />
          <HoldingsTable title="Mutual funds" caption="From Coin" rows={funds} currency={currency} fund />
          <p style={{ fontSize: '11px', color: 'var(--muted)' }}>
            These are Zerodha's figures at market prices. They are shown here for reference and are not added to your FinTrace accounts, net worth or reports.
          </p>
        </>
      )}
    </>
  );
}
