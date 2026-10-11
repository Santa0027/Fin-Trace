import { formatMoney } from '../../lib/money';
import type { CategoryBreakdown } from '../../types';

interface CategoryBreakdownCardProps {
  title: string;
  eyebrow: string;
  emptyMessage: string;
  color: string;
  breakdown: CategoryBreakdown;
}

/** Where money came from or went, largest first. Percentages and totals are computed by the backend. */
export function CategoryBreakdownCard({ title, eyebrow, emptyMessage, color, breakdown }: CategoryBreakdownCardProps) {
  return (
    <section className="card spending" aria-label={title} style={{ padding: '20px' }}>
      <div className="card-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2 style={{ fontSize: '16px', margin: '2px 0 3px' }}>{title}</h2>
        </div>
        <strong className="mono" style={{ fontSize: '16px' }}>{formatMoney(breakdown.total)}</strong>
      </div>
      {breakdown.results.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: '12px', padding: '16px 0' }}>{emptyMessage}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {breakdown.results.slice(0, 6).map((row) => (
            <li key={row.category_id ?? row.category}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                <span>{row.category}</span>
                <span className="mono">{formatMoney(row.amount)} · {row.percentage}%</span>
              </div>
              <div aria-hidden="true" style={{ height: '6px', background: 'var(--surface-3)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, row.percentage))}%`, background: color, borderRadius: '3px' }} />
              </div>
            </li>
          ))}
          {breakdown.results.length > 6 && (
            <li style={{ fontSize: '11px', color: 'var(--muted)' }}>and {breakdown.results.length - 6} more — see Reports for the full list</li>
          )}
        </ul>
      )}
    </section>
  );
}
