import { useState } from 'react';
import { deletePin, pinKey, savePin, usePins, type PinCategory } from '../data/pins';

/**
 * ── ★ THE GLYPH IS DRAWN, NOT TYPED, AND IT REPLACED A STAR ──────────────────
 * The control used to print `☆` / `★`. Everything around it says **pin** — the
 * route is `/pinned`, the store is `pins`, this file is `PinButton`, and the
 * empty state tells the reader to "use Pin on a project…". A star is the
 * vocabulary of a *favourite*, so the one word the app never uses was the one
 * word the control showed, and a reader told to look for a pin had to translate.
 *
 * It is an inline SVG rather than the `📌` character for the same reason the
 * close button is: an emoji renders as a colour glyph on some platforms and a
 * monochrome box on others, so it cannot follow `currentColor` into either theme
 * — and the pinned state *is* a colour change here.
 *
 * The outline/filled pair carries the state, exactly as ☆/★ did: **filled means
 * pinned**. The `is-pinned` class colours it; the fill is what keeps the
 * distinction readable for someone who cannot see the colour.
 */
function PushPin({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* head → waist → flange, one closed outline.
          ★ THE TWO WIDTHS ARE THE WHOLE GLYPH: a wide flat cap (4.6→11.4), the
          narrowest line at the neck (6.8→9.2), then the widest at the flange
          (3.2→12.8). Widening the flange further, or narrowing the cap, tips the
          read from "pushpin" towards "golf tee" — the first draft used 6.4 and
          10.4 (a 1.63 ratio) and did exactly that at 14px. Now 6.8 and 9.6, a
          1.41 ratio, with the needle taking the bottom 41% of the height. */}
      <path
        d="M4.6 1.9H11.4V4.2L9.2 6.5L12.8 8.3H3.2L6.8 6.5L4.6 4.2Z"
        fill={filled ? 'currentColor' : 'none'}
      />
      {/* the needle, from the middle of the flange's bottom edge */}
      <path d="M8 8.3v5.6" />
    </svg>
  );
}

export default function PinButton({ category, entityKey, title, subtitle, href }: {
  category: PinCategory;
  entityKey: string;
  title: string;
  subtitle?: string;
  href: string;
}) {
  const { pins } = usePins();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinned = pins.some((pin) => pinKey(pin.category, pin.entityKey) === pinKey(category, entityKey));

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (pinned) await deletePin(category, entityKey);
      else await savePin({ category, entityKey, title, subtitle: subtitle ?? '', href });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ★ THE VISIBLE LABEL IS GONE, SO THE ACCESSIBLE ONE HAS TO CARRY THE STATE.
   * Dropping the "Pin"/"Pinned" text is what lets the control be 30px wide
   * beside the close button — but it also removes the only place the state was
   * written in words. `aria-label` therefore flips with `pinned`, which is what
   * the visible text used to do, and `aria-pressed` still states the toggle
   * itself. The item's own name is appended, or a list of these would be a list
   * of identical buttons. The `title` keeps the hover answer the text gave.
   */
  const label = pinned ? 'Remove pin' : 'Pin this item';

  return (
    <span className="pin-control">
      <button
        type="button"
        className={`pin-button${pinned ? ' is-pinned' : ''}`}
        onClick={toggle}
        disabled={busy}
        aria-pressed={pinned}
        aria-label={`${label} — ${title}`}
        title={error ?? label}
      >
        <PushPin filled={pinned} />
      </button>
      {error ? <span className="pin-control__error" role="status">{error}</span> : null}
    </span>
  );
}