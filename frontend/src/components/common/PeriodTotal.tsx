import { formatMoney } from '../../lib/money';

interface PeriodTotalProps {
  label: string;
  /** From the backend; undefined while loading or if it could not be loaded. */
  amount: string | undefined;
  loading: boolean;
  error: string | null;
  tone?: 'positive' | 'negative';
}

/** A single headline figure. Shows "—" rather than a zero when the figure is not known. */
export function PeriodTotal({ label, amount, loading, error, tone }: PeriodTotalProps) {
  return (
    <div className="card" style={{ padding: '16px 20px', marginBottom: '14px' }}>
      <span className="eyebrow">{label}</span>
      <strong className={`mono ${tone === 'positive' ? 'good' : tone === 'negative' ? 'text-danger' : ''}`} style={{ display: 'block', fontSize: '24px' }} aria-busy={loading}>
        {amount !== undefined ? formatMoney(amount) : loading ? '…' : '—'}
      </strong>
      {error && <small role="alert" style={{ color: 'var(--coral)' }}>Could not load this total. {error}</small>}
    </div>
  );
}
