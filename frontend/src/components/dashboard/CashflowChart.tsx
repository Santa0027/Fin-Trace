import { formatMoney, toNumber } from '../../lib/money';
import type { CashflowPoint } from '../../types';

/** Income and expenses side by side for each month. Bar heights are for comparison; the figures are exact. */
export function CashflowChart({ points }: { points: CashflowPoint[] }) {
  const max = Math.max(...points.map((p) => Math.max(toNumber(p.income), toNumber(p.expenses))), 0);
  const height = (value: string) => (max > 0 ? `${Math.max(0, (toNumber(value) / max) * 100)}%` : '0%');

  return (
    <section className="card chart-card" aria-label="Income and expenses by month" style={{ padding: '20px', marginBottom: '14px' }}>
      <div className="card-head">
        <div>
          <span className="eyebrow">Month by month</span>
          <h2 style={{ fontSize: '16px', margin: '2px 0 3px' }}>Income and expenses</h2>
        </div>
        <div className="legend" style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
          <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--primary)', marginRight: 4 }} />Income</span>
          <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--coral)', marginRight: 4 }} />Expenses</span>
        </div>
      </div>
      {max === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: '12px', padding: '24px 0', textAlign: 'center' }}>
          No income or expenses recorded in these months yet.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${points.length}, 1fr)`, gap: '12px', alignItems: 'end' }}>
          {points.map((point) => (
            <div key={point.month_start} style={{ textAlign: 'center' }} title={`${point.month}: income ${formatMoney(point.income)}, expenses ${formatMoney(point.expenses)}`}>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', justifyContent: 'center', height: '140px' }} aria-hidden="true">
                <span style={{ width: '18px', height: height(point.income), background: 'var(--primary)', borderRadius: '4px 4px 0 0' }} />
                <span style={{ width: '18px', height: height(point.expenses), background: 'var(--coral)', borderRadius: '4px 4px 0 0' }} />
              </div>
              <strong style={{ display: 'block', fontSize: '11px', marginTop: '6px' }}>{point.month}</strong>
              <small className={`mono ${toNumber(point.net) >= 0 ? 'good' : 'text-danger'}`} style={{ fontSize: '10px' }}>
                {toNumber(point.net) >= 0 ? '+' : '−'}{formatMoney(Math.abs(toNumber(point.net)))}
              </small>
              <span className="sr-only">
                {point.month}: income {formatMoney(point.income)}, expenses {formatMoney(point.expenses)}, net {formatMoney(point.net)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
