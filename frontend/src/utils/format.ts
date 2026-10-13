const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Display only. Money stays a decimal string everywhere else; never do arithmetic on these numbers. */
export function formatINR(amount: string | null | undefined, exact = false): string {
  if (amount === null || amount === undefined) return '—';
  const n = Number(amount);
  const hasPaise = !Number.isInteger(n);
  return exact || hasPaise ? inrExact.format(n) : inr.format(n);
}

/** Lot numbers are the auction id padded like a catalogue entry. */
export const lotNumber = (id: number) => `Lot ${String(id).padStart(3, '0')}`;

const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** Times arrive in UTC (ISO) and are shown in the viewer's local timezone. */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatDate = (iso: string) => dateOnly.format(new Date(iso));

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export interface Remaining {
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function splitDuration(ms: number): Remaining {
  const t = Math.max(0, ms);
  return {
    totalMs: t,
    days: Math.floor(t / 86_400_000),
    hours: Math.floor((t % 86_400_000) / 3_600_000),
    minutes: Math.floor((t % 3_600_000) / 60_000),
    seconds: Math.floor((t % 60_000) / 1000),
  };
}

/** "2d 4h", "3h 12m", "4m 09s", "42s" — precise near the end, coarse far away. */
export function formatRemaining(ms: number): string {
  const r = splitDuration(ms);
  if (r.days > 0) return `${r.days}d ${r.hours}h`;
  if (r.hours > 0) return `${r.hours}h ${r.minutes}m`;
  if (r.minutes > 0) return `${r.minutes}m ${String(r.seconds).padStart(2, '0')}s`;
  return `${r.seconds}s`;
}
