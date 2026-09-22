import type { ReactNode } from 'react';
import type { PurposeCode } from '../data/types';
import { PURPOSE_META } from '../data/taxonomy';

export type ChipVariant = 'ok' | 'info' | 'warn' | 'err' | 'neu' | 'cap' | 'ope' | 'oth';

interface ChipProps {
  variant?: ChipVariant;
  dot?: boolean;
  title?: string;
  children: ReactNode;
}

export function Chip({ variant = 'neu', dot = false, title, children }: ChipProps) {
  return (
    <span className={`chip chip--${variant}`} title={title}>
      {dot ? <i className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Active / Dormant is derived from order recency, never from Oracle's STATUS column. */
export function StatusChip({
  status,
  quietDays,
}: {
  status: 'active' | 'dormant';
  quietDays: number;
}) {
  const title =
    status === 'active'
      ? `Last order ${quietDays} day${quietDays === 1 ? '' : 's'} before the extract cut-off — inside the 90-day window.`
      : `No order for ${quietDays} days — outside the 90-day active window.`;

  return (
    <Chip variant={status === 'active' ? 'info' : 'neu'} dot title={title}>
      {status}
    </Chip>
  );
}

export function PurposeChip({ purpose, title }: { purpose: PurposeCode; title?: string }) {
  const meta = PURPOSE_META[purpose];
  return (
    <Chip variant={meta.chip as ChipVariant} dot title={title ?? meta.label}>
      {meta.label}
    </Chip>
  );
}
