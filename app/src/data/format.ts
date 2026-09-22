/** Formatting helpers, ported from the mockups so figures read identically. */

const USD2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Always two decimals — drawer headings, cost-code lines, tooltips. */
export const money = (n: number): string => USD2.format(Number(n) || 0);

/** Whole dollars — table cells, KPI tiles, stat values. */
export const money0 = (n: number): string => USD0.format(Math.round(Number(n) || 0));

/**
 * Abbreviated, used only for the secondary sub-line in the table so the money
 * columns stay narrow. The exact figure always appears in the column above it.
 */
export const moneyShort = (n: number): string => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return money0(v);
};

export const num = (n: number): string => new Intl.NumberFormat('en-US').format(Number(n) || 0);

/**
 * A ledger identifier — the digits and nothing else.
 *
 * ★ AN ID IS NOT A QUANTITY, AND GROUPING IT CHANGES THE VALUE. `num()` renders
 *   vendor 3667648 as "3,667,648", which reads as three million six hundred
 *   thousand. Nobody reads an Oracle id that way: `VENDOR_ID` is a label, and the
 *   commas both suggest a magnitude and make the string hard to paste into the
 *   query that would look it up. Digits only, always.
 */
export const ident = (n: number): string => String(Number(n) || 0);

export const pct = (n: number): string => `${((Number(n) || 0) * 100).toFixed(1)}%`;

/**
 * One decimal renders a real 0.05% as "0.0%" and a real 99.95% as "100.0%" —
 * "there is none" and "there is all of it". Neither is true.
 */
export const pctSlim = (n: number): string => {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.001) return '<0.1%';
  if (v > 0.999 && v < 1) return '>99.9%';
  return pct(v);
};

/** A percentage from an already-computed ratio of two totals; never divides by zero. */
export const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** `2026-04-06` → `2026-04-06`. Kept trivial so the source format is never guessed. */
export const isoDay = (value: string): string => String(value ?? '').slice(0, 10);

/** `2026-04` → `Apr 26`. */
export const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${String(y).slice(2)}`;
};

/**
 * `2026-04` → `April 2026`. `''` for anything unparseable.
 *
 * The empty string is deliberate rather than incidental: `Date` turns a missing month into
 * `Invalid Date`, which used to reach the dashboard's opening sentence when the account scope removed
 * every line. A function that formats a month should not be able to emit a sentence fragment claiming
 * a date is invalid; callers now get `''` and are expected to branch on it, which is what the
 * dashboard does.
 */
export const monthLong = (ym: string): string => {
  const [y, m] = String(ym ?? '').split('-');
  if (!/^\d{4}$/.test(y ?? '') || !/^\d{1,2}$/.test(m ?? '')) return '';
  const d = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleString('en-US', { month: 'long' })} ${y}`;
};

export const daysBetween = (fromIso: string, toIso: string): number => {
  const a = Date.parse(`${isoDay(fromIso)}T00:00:00Z`);
  const b = Date.parse(`${isoDay(toIso)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
};

export const pluralise = (n: number, one: string, many = `${one}s`): string =>
  `${num(n)} ${n === 1 ? one : many}`;
