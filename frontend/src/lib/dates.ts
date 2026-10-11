/** Date helpers. Dates sent to the API are plain calendar days (YYYY-MM-DD). */
import type { Period } from './api/reportsApi';

let workspaceTimezone: string | undefined;

/** Called by the workspace provider; "today" and "this month" then mean the workspace's own calendar. */
export function setWorkspaceTimezone(timezone: string | null | undefined): void {
  workspaceTimezone = timezone || undefined;
}

function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The current calendar day in the workspace timezone, as a local-midnight Date. */
function workspaceNow(now = new Date()): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: workspaceTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return new Date(pick('year'), pick('month') - 1, pick('day'));
  } catch {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
}

/** Today in the workspace's timezone (not UTC, and not necessarily the browser's). */
export function todayISO(): string {
  return iso(workspaceNow());
}

export type PeriodPreset = 'THIS_MONTH' | 'LAST_MONTH' | '3M' | '6M' | 'YTD' | '1Y';

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'LAST_MONTH', label: 'Last month' },
  { value: '3M', label: '3 months' },
  { value: '6M', label: '6 months' },
  { value: 'YTD', label: 'This year' },
  { value: '1Y', label: '12 months' },
];

export function periodFor(preset: PeriodPreset, at = new Date()): Period {
  const now = workspaceNow(at);
  const startOfMonth = (monthsBack: number) => new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  switch (preset) {
    case 'LAST_MONTH':
      return { date_from: iso(startOfMonth(1)), date_to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case '3M':
      return { date_from: iso(startOfMonth(2)), date_to: iso(now) };
    case '6M':
      return { date_from: iso(startOfMonth(5)), date_to: iso(now) };
    case 'YTD':
      return { date_from: iso(new Date(now.getFullYear(), 0, 1)), date_to: iso(now) };
    case '1Y':
      return { date_from: iso(startOfMonth(11)), date_to: iso(now) };
    case 'THIS_MONTH':
    default:
      return { date_from: iso(startOfMonth(0)), date_to: iso(now) };
  }
}

/** Format an API date or timestamp for display without shifting the calendar day. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
