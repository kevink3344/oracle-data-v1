import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/** Narrower than this and the panel's own tables start to clip; at 1200px the
    panel is already wider than the content column it is describing. */
export const DRAWER_MIN_W = 320;
export const DRAWER_MAX_W = 1200;

/** Arrow-key nudge in px, and the same nudge with Shift held. */
const STEP = 16;
const STEP_LARGE = 64;

export const clampWidth = (w: number): number =>
  Math.round(Math.min(DRAWER_MAX_W, Math.max(DRAWER_MIN_W, w)));

/**
 * Read a remembered panel width. `null` means nothing usable is stored, which
 * has to stay distinct from 0 so the caller can fall back to letting the
 * stylesheet own the width — and keep its responsive defaults working.
 */
export function readStoredWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    // A missing key returned above, so anything else has to be a real number —
    // otherwise a half-written value would collapse the panel to 0px rather
    // than falling back to the stylesheet's default.
    if (!Number.isFinite(n)) return null;
    return clampWidth(n);
  } catch {
    // file:// and hardened privacy modes can throw on storage access
    return null;
  }
}

/** Persist a chosen width, or clear it when passing `null`. */
export function storeWidth(key: string, w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(clampWidth(w)));
  } catch {
    /* storage unavailable — the width still applies for this session */
  }
}

type Props = {
  /** Width currently in force, in px. Used as the base for keyboard nudges. */
  value: number;
  onChange: (width: number) => void;
  onReset: () => void;
  onDraggingChange: (dragging: boolean) => void;
  /** The id of the element this grip sizes, and what a screen reader calls it. */
  controls?: string;
  label?: string;
};

/**
 * The drag handle on the details panel's left edge, plus its keyboard
 * equivalent. `role="separator"` with a value is the ARIA window-splitter
 * pattern, so screen readers announce it with the width it controls.
 */
export default function ResizeGrip({
  value,
  onChange,
  onReset,
  onDraggingChange,
  controls = 'project-detail',
  label = 'Resize the project details panel',
}: Props) {
  // Held in a ref so an unmount mid-drag cannot leave window listeners behind.
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    // `button` is 0 for touch and pen as well, so this keeps right-click out
    // without needing a separate touch path.
    if (e.button !== 0) return;
    e.preventDefault();

    const pointerId = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(pointerId);
    } catch {
      /* unsupported engine — the window listeners below still do the work */
    }

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // The panel is pinned to the right edge of the viewport, so its width is
      // exactly the distance from the pointer to that edge. Deriving it from
      // the pointer position rather than accumulating per-frame deltas keeps
      // the edge under the cursor even when frames are dropped.
      onChange(clampWidth(window.innerWidth - ev.clientX));
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stopRef.current = null;
      onDraggingChange(false);
    };

    stopRef.current = stop;
    // Captured pointer events still bubble, so listening on window covers both
    // the captured case and the case where capture was unavailable.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    onDraggingChange(true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // `value` is 0 only before the panel has been measured, so fall back to the
    // minimum rather than nudging up from a number that was never on screen.
    const base = value > 0 ? value : DRAWER_MIN_W;
    const step = e.shiftKey ? STEP_LARGE : STEP;

    // The grip sits on the panel's LEFT edge, so moving it left makes the panel
    // wider — the arrows follow the edge, not the width.
    if (e.key === 'ArrowLeft') onChange(clampWidth(base + step));
    else if (e.key === 'ArrowRight') onChange(clampWidth(base - step));
    else if (e.key === 'Home') onChange(DRAWER_MIN_W);
    else if (e.key === 'End') onChange(DRAWER_MAX_W);
    else if (e.key === 'Enter' || e.key === ' ') onReset();
    else return;

    e.preventDefault();
  };

  return (
    <div
      className="drawer__grip"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={label}
      aria-valuemin={DRAWER_MIN_W}
      aria-valuemax={DRAWER_MAX_W}
      aria-valuenow={value > 0 ? value : DRAWER_MIN_W}
      title="Drag to resize · double-click to reset"
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
