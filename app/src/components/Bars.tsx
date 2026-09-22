import type { Bucket } from '../data/types';
import { money0, pct, share } from '../data/format';

interface MixBarProps {
  capital: number;
  operating: number;
  relocation: number;
  committed: number;
}

/**
 * The project's composition bar in the list.
 *
 * Sized with `flex-grow` from raw dollar values, never from percentage widths on
 * inline spans — a percentage width on an inline box computes to zero and the bar
 * silently disappears. Zero-valued segments are omitted from the DOM entirely, so
 * the aria-label is what names them.
 */
export function MixBar({ capital, operating, relocation, committed }: MixBarProps) {
  const denom = committed > 0 ? committed : 1;

  const parts = [
    { cls: 'm-cap', value: capital },
    { cls: 'm-ope', value: operating },
    { cls: 'm-oth', value: relocation },
  ].filter((p) => p.value > 0);

  const label =
    `Composition of committed value: capital ${pct(share(capital, denom))}, ` +
    `operating ${pct(share(operating, denom))}, relocation ${pct(share(relocation, denom))}.`;

  return (
    <div className="mix" role="img" aria-label={label} title={label}>
      {parts.map((p) => (
        <span
          key={p.cls}
          className={p.cls}
          style={{ flexGrow: Number(((p.value / denom) * 100).toFixed(4)) }}
        />
      ))}
    </div>
  );
}

/**
 * The budget-vs-committed bar in the panel. Segments are raw dollars, including the remainder.
 *
 * ★ `remaining` is the *budget* left uncommitted, and it is nullable on purpose. A level whose
 *   accounts carry no Oracle budget row has no remainder because it has no denominator, and the bar
 *   then says only what it knows: the purpose split of the committed money. The label follows suit
 *   — “unallocated $0” would report a budget that was never read as a budget of zero, which is a
 *   different and false statement.
 */
export function UsageBar({ buckets, remaining }: { buckets: Bucket[]; remaining: number | null }) {
  const rest = remaining === null ? 0 : Math.max(remaining, 0);

  const label =
    buckets.length === 0
      ? 'No committed value in this project.'
      : `${buckets.map((b) => `${b.meta.label} ${money0(b.committed)}`).join(', ')}${
          remaining === null
            ? '. No Oracle budget row to measure against.'
            : `, unallocated ${money0(rest)}.`
        }`;

  return (
    <div className="usage" role="img" aria-label={label} title={label}>
      {buckets.map((b) => (
        <span
          key={b.purpose}
          className={`u-${b.meta.series}`}
          style={{ flexGrow: Math.max(b.committed, 0) }}
        />
      ))}
      <span className="u-rest" style={{ flexGrow: rest }} />
    </div>
  );
}

/**
 * A single cost code's share of its own budget group.
 *
 * It is deliberately not clamped at 100% and has no overflow marker — the mockup
 * had none either — but the width is capped so a bar can never paint outside its
 * track. The exact share is always printed beside it.
 */
export function ShareBar({ value, series }: { value: number; series: string }) {
  const width = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="line__bar">
      <span
        className={`line__fill u-${series}`}
        style={{ width: `${width.toFixed(2)}%` }}
        aria-hidden="true"
      />
    </div>
  );
}
