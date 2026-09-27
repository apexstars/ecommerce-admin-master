const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function money(cents: number, currency = 'usd') {
  let f = moneyFormatters.get(currency);
  if (!f) moneyFormatters.set(currency, (f = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() })));
  return f.format(cents / 100);
}

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatDate = (iso: string) => dateOnly.format(new Date(iso));

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string | null) {
  if (!iso) return 'Never';
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 60) return 'Just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86400) return rtf.format(Math.round(seconds / 86400), 'day');
  return formatDate(iso);
}

export const percent = (ratio: number) =>
  new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(ratio));

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
