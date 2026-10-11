/**
 * Money helpers.
 *
 * Amounts travel as decimal strings. They are converted to a number only to be
 * formatted or to size a chart mark, never to compute a total that is shown as
 * a financial fact; those come from the backend.
 */
import type { CurrencyInfo } from '../types';

const FALLBACK: CurrencyInfo = { id: '', code: 'USD', symbol: '$', decimal_places: 2 };
let workspaceCurrency: CurrencyInfo = FALLBACK;

/** Called by the workspace provider whenever the active workspace changes. */
export function setWorkspaceCurrency(currency: CurrencyInfo | null | undefined): void {
  workspaceCurrency = currency ?? FALLBACK;
}

export function getWorkspaceCurrency(): CurrencyInfo {
  return workspaceCurrency;
}

export function formatMoney(value: number | string | null | undefined, currencyCode?: string | null): string {
  const numeric = Number(value ?? 0);
  const code = currencyCode || workspaceCurrency.code;
  const safe = Number.isFinite(numeric) ? numeric : 0;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(safe);
  } catch {
    return `${code} ${safe.toFixed(2)}`;
  }
}

/** For chart geometry and sign checks only. */
export function toNumber(value: number | string | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Validate what a person typed into an amount box. Returns the clean decimal
 * string to send, or an error message to show.
 */
export function parseAmountInput(input: string, decimals = workspaceCurrency.decimal_places): { value?: string; error?: string } {
  const cleaned = input.trim().replace(/,/g, '');
  if (!cleaned) return { error: 'Enter an amount.' };
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { error: 'Enter the amount as a number, for example 1500.00.' };
  const [, fraction = ''] = cleaned.split('.');
  if (fraction.length > decimals) {
    return { error: decimals === 0 ? 'This currency has no decimal places.' : `Use at most ${decimals} decimal places.` };
  }
  if (!/[1-9]/.test(cleaned)) return { error: 'Amount must be greater than zero.' };
  return { value: cleaned };
}
