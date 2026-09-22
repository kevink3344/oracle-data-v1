import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * A pan and zoom viewer for one image.
 *
 * ★ THE WHEEL IS NOT A ZOOM GESTURE UNLESS A MODIFIER IS HELD, and this is the
 *   same decision `VendorSiteMap` records as `scrollZoom: false`. This viewer
 *   lives inside the drawer's own scroll container, so a bare wheel over the
 *   image would zoom the image instead of scrolling the panel — the reader would
 *   lose their place, watch the image jump, and never be told why. Command or
 *   Control with the wheel is honoured because the modifier states the intent,
 *   and a trackpad pinch arrives as exactly that event, so pinch-to-zoom works
 *   for free. The buttons are the accessible replacement, and they work from the
 *   keyboard.
 *
 * ★ THE PERCENTAGE IS THE SHARE OF THE IMAGE'S OWN PIXELS, not of the fitted
 *   size. 100% means one image pixel per screen pixel; the fitted size of a
 *   photograph is usually a small fraction, so the readout opens well below
 *   100% and that is the honest number rather than a broken one. The hint under
 *   the frame says so in words, because a reader who expects "100% = normal"
 *   would otherwise read the opening figure as a fault.
 *
 * ★ THE OFFSET IS CLAMPED AT EVERY MUTATION rather than once at the end, which
 *   is what makes a drag behave: the image never leaves a gap at one edge and
 *   then snaps back. When a scaled axis is smaller than the frame that axis is
 *   centred instead of clamped, so an image narrower than the viewport cannot be
 *   pushed off to one side.
 *
 * ★ A SCALE THAT LANDS ON FIT IS STORED AS `null`, so the view keeps following
 *   the frame. Pinning the fitted number instead would freeze the zoom at the
 *   old size the moment the reader resized the panel.
 */
type Props = {
  src: string;
  alt: string;
  /**
   * Changing this returns the view to fit. Pass the identity of whatever the
   * image is *of* — a different check, a different record — so the next subject
   * opens whole rather than inheriting the last one's pan.
   */
  resetKey?: string | number | null;
  /** Names the viewer for assistive technology, e.g. "Check image viewer". */
  label?: string;
};

/** The most a reader may magnify, as a multiple of the image's own pixels. */
const MAX_SCALE = 4;

/** One press of zoom in or out multiplies the current scale by this. */
const STEP = 1.5;

/** Arrow-key pan distances, and the second for Shift. */
const PAN_KEY_STEP = 24;
const PAN_KEY_STEP_LARGE = 96;

/** Pointer travel tolerated before a press counts as a drag rather than a click. */
const DRAG_SLOP = 3;

/** A scale within this of the fitted size is treated as "at fit". */
const SAME = 1e-4;

type Size = { w: number; h: number };
type Offset = { x: number; y: number };

const fitScale = (nat: Size, box: Size): number => Math.min(box.w / nat.w, box.h / nat.h);

/**
 * The smallest scale the reader may zoom out to. Usually the fitted size, so a
 * large image can never be made smaller than the frame. For an image smaller
 * than its frame the fitted size is above 1, and the floor drops to the image's
 * own size — which keeps "Actual size" meaningful instead of a button that
 * silently lands somewhere above 100%.
 */
const minScale = (nat: Size, box: Size): number => Math.min(fitScale(nat, box), 1);

const clampScale = (s: number, nat: Size, box: Size): number =>
  Math.min(MAX_SCALE, Math.max(minScale(nat, box), s));

/** Where the image sits for a given scale, in frame coordinates. */
const clampOffset = (x: number, y: number, s: number, nat: Size, box: Size): Offset => {
  const sw = nat.w * s;
  const sh = nat.h * s;
  return {
    x: sw <= box.w ? (box.w - sw) / 2 : Math.min(0, Math.max(box.w - sw, x)),
    y: sh <= box.h ? (box.h - sh) / 2 : Math.min(0, Math.max(box.h - sh, y)),
  };
};

export default function ZoomImage({ src, alt, resetKey = null, label = 'Image viewer' }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const hintId = useRef(`zoom-hint-${Math.random().toString(36).slice(2, 8)}`).current;
  /**
   * The wheel handler runs outside React's render, so it reads the current view
   * through refs rather than from the render it was created in.
   */
  const applyRef = useRef<((next: number, anchor?: Offset) => void) | null>(null);
  const scaleRef = useRef(1);

  /** The image's own pixel size, read from the file once it loads. */
  const [nat, setNat] = useState<Size | null>(null);
  /** The frame's content box, kept current by a ResizeObserver. */
  const [box, setBox] = useState<Size | null>(null);
  /** null means "fit" — the view follows the frame rather than pinning a scale. */
  const [zoom, setZoom] = useState<number | null>(null);
  /** null means "centred"; only read while zoomed away from fit. */
  const [pan, setPan] = useState<Offset | null>(null);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);

  const ready = nat !== null && box !== null && !failed;

  const geom = useMemo(() => {
    if (nat === null || box === null) return null;
    const fit = fitScale(nat, box);
    const scale = zoom === null ? fit : Math.max(zoom, fit);
    const offset = clampOffset(pan?.x ?? 0, pan?.y ?? 0, scale, nat, box);
    const max = minScale(nat, box);
    return {
      fit,
      scale,
      offset,
      atFit: zoom === null,
      canZoomOut: scale > max + SAME,
      canZoomIn: scale < MAX_SCALE - SAME,
      atActual: Math.abs(scale - 1) < SAME,
      // Panning needs something to pan to: a fitted image is exactly as wide or
      // as tall as the frame and has nowhere to go.
      canPan: nat.w * scale > box.w + 0.5 || nat.h * scale > box.h + 0.5,
    };
  }, [nat, box, zoom, pan]);

  // The frame's size is stable — the stylesheet fixes its height — so it is
  // measurable before the image arrives, and while the drawer is still off
  // screen (a `visibility: hidden` element keeps its layout box).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = () =>
      setBox((b) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        return b !== null && b.w === w && b.h === h ? b : { w, h };
      });
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
  }, []);

  const readNatural = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    setNat({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  // An image restored from cache can finish before the effect runs, so this is
  // the belt to `onLoad`'s braces rather than a duplicate of it.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) readNatural();
  }, [readNatural, src]);

  /** A new subject opens fitted, whole, and centred. */
  useEffect(() => {
    setZoom(null);
    setPan(null);
  }, [resetKey, src]);

  /**
   * Resizing the frame re-fits a fitted image and re-clamps a zoomed one. It
   * also has to raise a scale the frame has outgrown: dragging the panel wider
   * can push the fitted size above a zoom the reader set on the narrow panel.
   */
  useEffect(() => {
    if (nat === null || box === null) return;
    const fit = fitScale(nat, box);
    if (zoom === null || zoom <= fit + SAME) {
      setZoom(null);
      setPan(null);
      return;
    }
    setPan((p) => clampOffset(p?.x ?? 0, p?.y ?? 0, zoom, nat, box));
  }, [nat, box, zoom]);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('is-panning');
    return () => document.body.classList.remove('is-panning');
  }, [dragging]);

  // The drag listeners live on the window, so they have to be torn down if the
  // panel closes mid-drag as well as on unmount.
  useEffect(() => () => stopRef.current?.(), []);

  /**
   * Zoom to `next`, keeping the image point under `anchor` where it is. Without
   * an anchor the frame's centre is used, so a button press magnifies the part
   * of the image the reader is looking at rather than the corner.
   */
  const applyZoom = useCallback(
    (next: number, anchor?: Offset) => {
      if (nat === null || box === null) return;
      const fit = fitScale(nat, box);
      const s = clampScale(next, nat, box);
      if (Math.abs(s - fit) < SAME) {
        setZoom(null);
        setPan(null);
        return;
      }
      const current = zoom === null ? fit : Math.max(zoom, fit);
      const at = anchor ?? { x: box.w / 2, y: box.h / 2 };
      const from = pan ?? clampOffset(0, 0, current, nat, box);
      const ix = (at.x - from.x) / current;
      const iy = (at.y - from.y) / current;
      setZoom(s);
      setPan(clampOffset(at.x - ix * s, at.y - iy * s, s, nat, box));
    },
    [nat, box, zoom, pan],
  );

  // The wheel listener is attached once for the life of the frame, so it reaches
  // the current view through refs instead of being re-attached on every frame of
  // a drag.
  useEffect(() => {
    applyRef.current = applyZoom;
    scaleRef.current = geom === null ? 1 : geom.scale;
  }, [applyZoom, geom]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      // No modifier means the reader is scrolling the panel, and the image has
      // no business taking that gesture.
      if (!ev.ctrlKey && !ev.metaKey) return;
      const apply = applyRef.current;
      if (apply === null) return;
      const rect = el.getBoundingClientRect();
      ev.preventDefault();
      apply(scaleRef.current * Math.exp(-ev.deltaY * 0.002), {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const startPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || geom === null || !geom.canPan) return;
    const n = nat;
    const b = box;
    if (n === null || b === null) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(pointerId);
    } catch {
      // An engine without pointer capture still pans: the window listeners
      // below see the moves regardless.
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const fromX = geom.offset.x;
    const fromY = geom.offset.y;
    const s = geom.scale;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        moved = true;
        setDragging(true);
      }
      setPan(clampOffset(fromX + dx, fromY + dy, s, n, b));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stopRef.current = null;
      setDragging(false);
    };
    stopRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const toFit = () => {
    setZoom(null);
    setPan(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || geom === null) return;
    const n = nat;
    const b = box;
    if (n === null || b === null) return;
    const big = e.shiftKey ? PAN_KEY_STEP_LARGE : PAN_KEY_STEP;
    switch (e.key) {
      case '+':
      case '=':
        applyZoom(geom.scale * STEP);
        break;
      case '-':
      case '_':
        applyZoom(geom.scale / STEP);
        break;
      case '0':
      case 'Home':
        toFit();
        break;
      case '1':
        applyZoom(1);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        // ★ AT FIT THERE IS NOTHING TO PAN, SO THE KEY IS LEFT ALONE and the
        // drawer's scroll container gets it back. Swallowing the arrow keys on
        // a fitted image would strand a keyboard reader in a box that cannot
        // move and no longer scrolls the panel they came to read.
        if (!geom.canPan) return;
        const dx = e.key === 'ArrowLeft' ? -big : e.key === 'ArrowRight' ? big : 0;
        const dy = e.key === 'ArrowUp' ? -big : e.key === 'ArrowDown' ? big : 0;
        setPan(clampOffset(geom.offset.x + dx, geom.offset.y + dy, geom.scale, n, b));
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (geom === null) return;
    if (!geom.atFit) {
      toFit();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    applyZoom(geom.fit * 2, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const imgStyle: CSSProperties | undefined =
    ready && nat !== null && geom !== null
      ? {
          width: `${nat.w}px`,
          height: `${nat.h}px`,
          transform: `translate(${geom.offset.x}px, ${geom.offset.y}px) scale(${geom.scale})`,
        }
      : undefined;

  const frameClass = [
    'chkzoom__frame',
    ready ? 'is-ready' : '',
    geom?.canPan ? 'is-pannable' : '',
    dragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="chkzoom">
      {failed ? null : (
        <div className="chkzoom__bar">
          <button
            type="button"
            className="chkzoom__btn"
            onClick={() => geom && applyZoom(geom.scale / STEP)}
            disabled={geom === null || !geom.canZoomOut}
            aria-label="Zoom out"
            title="Zoom out (−)"
          >
            <span aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            className="chkzoom__btn"
            onClick={() => geom && applyZoom(geom.scale * STEP)}
            disabled={geom === null || !geom.canZoomIn}
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            <span aria-hidden="true">+</span>
          </button>
          <span
            className="chkzoom__level"
            aria-live="polite"
            aria-atomic="true"
            title="Share of the image's own pixel size"
          >
            {geom === null ? '—' : `${Math.round(geom.scale * 100)}%`}
          </span>
          <button
            type="button"
            className="chkzoom__btn chkzoom__btn--text"
            onClick={toFit}
            disabled={geom === null || geom.atFit}
            title="Fit the whole image in the frame (0)"
          >
            Fit
          </button>
          <button
            type="button"
            className="chkzoom__btn chkzoom__btn--text"
            onClick={() => applyZoom(1)}
            disabled={geom === null || geom.atActual}
            title="One image pixel per screen pixel (1)"
          >
            Actual size
          </button>
        </div>
      )}

      <div
        ref={frameRef}
        className={frameClass}
        tabIndex={0}
        role="group"
        aria-label={label}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onPointerDown={startPan}
        onDoubleClick={onDoubleClick}
      >
        {failed ? (
          <p className="chkzoom__failed">
            This image could not be loaded, so there is nothing to zoom. The rest of the panel is
            unaffected.
          </p>
        ) : (
          <img
            ref={imgRef}
            className="chkzoom__img"
            src={src}
            alt={alt}
            style={imgStyle}
            draggable={false}
            onLoad={readNatural}
            onError={() => setFailed(true)}
          />
        )}
      </div>

      <p className="chkzoom__hint" id={hintId}>
        {geom?.canPan
          ? 'Drag the image to pan, or use the arrow keys. Zoom out returns the whole image to view.'
          : 'Zoom in with the buttons, the plus and minus keys, or Command or Control with the wheel. Once it is larger than this frame, drag it or use the arrow keys to pan. The percentage is the share of the image’s own pixels, so the fitted view of a large image reads well below 100%.'}
      </p>
    </div>
  );
}
