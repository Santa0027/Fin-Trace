import { formatMoney, toNumber } from '../../lib/money';

export { formatMoney };

interface MoneyDisplayProps {
  value: number | string | null | undefined;
  /** ISO code; defaults to the active workspace's currency. */
  currency?: string | null;
  signed?: boolean;
  className?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}

export function MoneyDisplay({ value, currency, signed = false, className = '', tone }: MoneyDisplayProps) {
  const numeric = toNumber(value);
  const formatted = formatMoney(Math.abs(numeric), currency);
  let sign = '';
  let autoTone = tone;

  if (signed) {
    if (numeric > 0) {
      sign = '+';
      if (!autoTone) autoTone = 'positive';
    } else if (numeric < 0) {
      sign = '−';
      if (!autoTone) autoTone = 'negative';
    }
  }

  const toneClass = autoTone === 'positive' ? 'good positive' : autoTone === 'negative' ? 'text-danger' : '';

  return (
    <span className={`mono amount ${toneClass} ${className}`}>
      {sign}
      {formatted}
    </span>
  );
}
