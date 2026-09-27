import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountColour, type LineageNode } from '../../data/lineage';
import { money0, num, pct, pluralise } from '../../data/format';
import {
  partitionSunburst,
  sunburstSelection,
  type SunburstArc,
  type SunburstTree,
} from '../../data/sunburst';

/**
 * The project burst — five concentric rings, Project → Account → PO line → Invoice → Check.
 *
 * ── ★★ THE GEOMETRY IS `d3.partition()`, THE DRAWING IS OURS ─────────────────
 *
 * `d3-force` and `dagre` are layout-only in this app and the same seam holds here: the
 * partition computes four numbers per node (`x0 x1 y0 y1`) and nothing else. The arc path
 * is hand-rolled in `arcPath()` below — about twenty lines — so `d3-shape` is not a
 * dependency and there is no renderer to fight.
 *
 * `partitionSunburst()` sizes the partition `[2π, 5]`, so `y ∈ [depth, depth + 1]` and the
 * radius of a band is just `y / span × R`. See `sunburst.ts` for the measure rule — the
 * one this whole view exists to express.
 *
 * ── ★★ WHAT A ZOOM IS: EVERY RECT IS RESCALED ABOUT THE FOCUS ────────────────
 *
 * Clicking an arc does not re-root the tree. Each node's rect is remapped into the frame
 * of the focus:
 *
 *     x ← clamp01((x − focus.x0) / (focus.x1 − focus.x0)) × 2π
 *     y ← max(0, y − focus.depth)
 *
 * A node wholly before the focus clamps to zero angular width; a node wholly after it
 * clamps to the full 2π. Its ANCESTORS collapse in the *radial* direction instead (both
 * ends shift to 0). So the focused node becomes the innermost full band, its descendants
 * fill the rings outside it, and everything else leaves the disc without any special
 * casing — the skip test (`width < MIN_WIDTH`, `thickness < 0.25`) is the whole of it.
 *
 * ── ★★ A FULL RING IS DRAWN AS TWO HALVES, AND THAT IS NOT AN OPTIMISATION ───
 *
 * The focused node always becomes a complete annulus. A single SVG arc whose end point
 * coincides with its start point renders **nothing at all**, silently — so `arcPath()`
 * splits any ring ≥ 2π into two 180° sectors. Without this the centre ring would vanish
 * at every zoom level including the first, with no error anywhere on the path.
 *
 * ── ★ THE ACCESSIBILITY ROLE, AND WHY IT IS NOT `role="img"` ─────────────────
 *
 * The arc paths are the interactive controls here: each is `tabindex="0"`, `role="button"`
 * and carries its own sentence. A `role="img"` on the `<svg>` would make every descendant
 * presentational and erase all of them from the accessibility tree, so the svg is a
 * `role="group"` with a label and the arcs stay reachable. The `.sr` table at the foot is
 * a per-RING summary rather than a repeat of all ~100 arcs, because each arc already
 * announces itself.
 */

/** One full turn. `d3.partition` hands out angles in radians over exactly this. */
const TAU = 2 * Math.PI;
/** Angular width (radians) below which an arc is not worth a path element. */
const MIN_WIDTH = 1e-4;
/** Radial thickness (px) below which an arc is not worth a path element. */
const MIN_THICK = 0.25;
/** An arc needs this much arc-length at its mid radius before it gets a text label. */
const LABEL_MIN_PX = 30;
const LABEL_FONT = 11;
/** Average glyph advance as a fraction of font size, for fitting a label to its arc. */
const GLYPH = 0.56;

/** A node's placed rectangle in the current zoom frame. */
interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Props {
  tree: SunburstTree;
  /** The project's account objects, in the order `accountColour` assigns colours by. */
  accounts: string[];
  onSelect: (node: LineageNode) => void;
  selectedId: string | null;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Remap every arc into the frame of the focus. Pure, so the tween can call it cheaply.
 */
function targetsFor(arcs: SunburstArc[], focus: SunburstArc): Map<string, Rect> {
  // The focus's own ORIGINAL span, which is what its children tile. Guarded because a
  // zero-amount line leaves it at 0, and dividing by it would give every child a NaN
  // rect — which SVG renders as nothing, i.e. a silent empty disc.
  const span = focus.x1 - focus.x0 || 1;
  const out = new Map<string, Rect>();
  for (const n of arcs) {
    out.set(n.data.id, {
      x0: clamp01((n.x0 - focus.x0) / span) * TAU,
      x1: clamp01((n.x1 - focus.x0) / span) * TAU,
      y0: Math.max(0, n.y0 - focus.depth),
      y1: Math.max(0, n.y1 - focus.depth),
    });
  }
  return out;
}

/** A point at `angle` (0 = 12 o'clock, increasing clockwise) and radius `r`. */
function pt(angle: number, r: number): string {
  return `${(Math.sin(angle) * r).toFixed(3)} ${(-Math.cos(angle) * r).toFixed(3)}`;
}

/**
 * One annular sector, outer edge first then back along the inner edge.
 *
 * ★ A sector reaching the centre has NO inner arc: both inner points are (0,0), and
 *   `A 0 0 …` is an invalid radius, not a short arc. It is a `L 0 0` instead.
 */
function sectorPath(inner: number, outer: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = pt(a0, outer);
  const o1 = pt(a1, outer);
  if (inner < 0.5) return `M${o0} A${outer} ${outer} 0 ${large} 1 ${o1} L0 0 Z`;
  const i1 = pt(a1, inner);
  const i0 = pt(a0, inner);
  return `M${o0} A${outer} ${outer} 0 ${large} 1 ${o1} L${i1} A${inner} ${inner} 0 ${large} 0 ${i0} Z`;
}

/**
 * The path for a band, splitting a complete ring in two.
 *
 * ★★ A FULL RING MUST BE TWO HALVES. An arc from `a` to `a + 2π` has identical start and
 *    end points, and SVG draws no arc for it — the shape is simply absent, with no error.
 *    The focused node is ALWAYS a full ring, so this is the normal case, not an edge case.
 */
function arcPath(inner: number, outer: number, a0: number, a1: number): string {
  if (a1 - a0 >= TAU - 1e-6) {
    const mid = a0 + Math.PI;
    return `${sectorPath(inner, outer, a0, mid)} ${sectorPath(inner, outer, mid, a1)}`;
  }
  return sectorPath(inner, outer, a0, a1);
}

/**
 * Shorten a label to the room its arc actually has, measured rather than guessed.
 *
 * ★ THE TEST IS THE ARC'S OWN LENGTH, not a list of which labels to draw. A label is
 *   shown when `span × midRadius ≥ LABEL_MIN_PX` — a geometric fact about that arc in
 *   the current frame — so the same view is correct at every zoom level, and it stays
 *   correct if the project or the ring count changes. A hand-kept list of "which rings
 *   get labels" would be right for exactly the project it was tuned on.
 */
function fit(text: string, availPx: number, fontPx: number): string {
  const max = Math.floor(availPx / (GLYPH * fontPx));
  if (max < 2) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One sentence for one arc — the `aria-label`, and the native `<title>` tooltip.
 *
 * ★ RING 4 IS DESCRIBED AS A SHARE OF ITS OWN LINE, because that is what its width is.
 *   `d.ratio` is the RAW share (which can exceed 1 — one line here reached 112%), while
 *   the arc is clamped to the line. Saying "112%" beside a wedge that is exactly full
 *   would describe a width the drawing does not have, so the drawn share is stated and
 *   the excess is named as the reason the wedge is full.
 */
function describeArc(node: SunburstArc): string {
  const d = node.data;
  const parent = node.parent?.data;
  // ★ `parent` IS `null` AT THE ROOT, NOT `undefined` — `node.parent?.data` collapses the
  //   two, so the guard has to read the collapsed value. Guarding the optional chain
  //   against `undefined` compiles only by accident and would divide by a null's value.
  const share = parent !== undefined && parent.value > 0 ? d.value / parent.value : null;
  switch (d.kind) {
    case 'project':
      return `${d.label} — the whole circle, ${money0(d.measure)} committed`;
    case 'account':
      return `Account ${d.label}: ${money0(d.measure)} in purchase orders${
        share === null ? '' : `, ${pct(share)} of the project`
      }`;
    case 'po':
      return `PO ${d.label} under account ${parent?.name ?? ''}: ${money0(d.measure)}${
        share === null ? '' : `, ${pct(share)} of that account`
      }${d.covered === null ? ', no invoice names this order' : ''}`;
    case 'invoice': {
      const drawn = d.over ? 1 : d.ratio ?? share ?? 0;
      const caveat = d.over
        ? `, which is the whole line — the invoices name ${pct(d.ratio ?? 0)} of it`
        : '';
      return `The ${num(d.invoices)} ${pluralise(d.invoices, 'invoice')} on PO ${
        parent?.name ?? ''
      }: ${money0(d.measure)} reached, ${pct(drawn)} of the line's amount${caveat}`;
    }
    case 'check':
      return `The ${num(d.checks)} ${pluralise(d.checks, 'check')} on PO ${
        parent?.name ?? ''
      }, one equal tick each`;
    default:
      return d.label;
  }
}

export default function LineageSunburst({ tree, accounts, onSelect, selectedId }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState({ w: 820, h: 620 });

  const meta = tree.meta;

  const laid = useMemo(() => partitionSunburst(tree.root), [tree]);
  const arcs = useMemo(() => laid.descendants(), [laid]);
  const byId = useMemo(() => {
    const map = new Map<string, SunburstArc>();
    for (const n of arcs) map.set(n.data.id, n);
    return map;
  }, [arcs]);

  const [focusId, setFocusId] = useState(() => tree.root.id);
  /** The geometry currently on screen — the tween's interpolation target, frame by frame. */
  const [view, setView] = useState<Map<string, Rect>>(() => targetsFor(laid.descendants(), laid));
  const viewRef = useRef(view);
  const pendingFocus = useRef<string | null>(null);

  /**
   * ★ REDUCED MOTION IS READ ONCE, NOT PER FRAME. The tween is a nicety; the view has to
   *   work the same way without it, so the only difference is that the four numbers jump.
   */
  const reduce = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  /**
   * ★ SIZED FROM ITS CONTAINER, MEASURED ONCE PER RESIZE — the `ResizeObserver` +
   *   `requestAnimationFrame` shape `TrendChart.tsx` and `LineageCanvas.tsx` both use.
   *   The rAF is deliberate: a `ResizeObserver` fires during layout, and setting state
   *   synchronously in that callback produces a render-loop warning.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setBox({
          w: Math.max(360, Math.round(el.clientWidth)),
          h: Math.max(360, Math.round(el.clientHeight) || 600),
        }),
      );
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  /**
   * ★★ THE TWEEN: EVERY ARC MOVES FROM WHERE IT IS TO WHERE IT BELONGS.
   *
   * Interpolating each node's own rect — rather than transitioning the four numbers of the
   * focus and recomputing — is what makes an arc that leaves the disc *shrink to nothing*
   * instead of jumping. Nodes with no previous rect start at zero width and grow, so a
   * zoom out reveals the rings it was hiding rather than flashing them in.
   *
   * ★ `targetsFor` reads `arcs` (the laid-out tree); when the project or the links change,
   *   an id that no longer exists falls back to the root layout below, so a stale focus
   *   self-heals instead of rendering an empty disc.
   */
  useEffect(() => {
    const focus = byId.get(focusId) ?? laid;
    const to = targetsFor(arcs, focus);
    const from = viewRef.current;

    if (reduce || from.size === 0) {
      viewRef.current = to;
      setView(to);
      return;
    }

    const started = performance.now();
    const duration = 600;
    let raf = 0;
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / duration);
      const e = 1 - (1 - t) ** 3;
      const next = new Map<string, Rect>();
      for (const [id, b] of to) {
        // ★ A NODE THAT WAS NOT ON SCREEN GROWS FROM NOTHING, at its own radius, rather
        //   than appearing at full width.
        const a = from.get(id) ?? { x0: b.x0, x1: b.x0, y0: b.y0, y1: b.y1 };
        next.set(id, {
          x0: lerp(a.x0, b.x0, e),
          x1: lerp(a.x1, b.x1, e),
          y0: lerp(a.y0, b.y0, e),
          y1: lerp(a.y1, b.y1, e),
        });
      }
      viewRef.current = next;
      setView(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [focusId, byId, arcs, laid, reduce]);

  /**
   * ★ DIAGNOSTIC FIRST, THEN THE MESSAGE. `d3.partition` divides by the parent's own
   *   measure, so a project whose committed total is zero produces a disc of zero-width
   *   arcs — every arc correct and the whole picture empty. Saying so is the difference
   *   between "this project has nothing to show" and "this view is broken".
   */
  const degenerate = meta.degenerate;

  const zoomTo = useCallback(
    (id: string, restoreFocus = false): void => {
      const node = byId.get(id);
      if (node === undefined) return;
      setFocusId(id);
      onSelect(sunburstSelection(node.data));
      if (restoreFocus) pendingFocus.current = id;
    },
    [byId, onSelect],
  );

  /**
   * ★ CLICKING THE FOCUS ITSELF GOES BACK ONE LEVEL. The reference has no such route: its
   *   only way out is the few-pixel centre of the disc. Making the current ring act as a
   *   "back" control costs nothing and removes that trap for mouse users; the keyboard
   *   has Escape and the breadcrumb has both.
   */
  const onArc = (node: SunburstArc): void => {
    const focus = byId.get(focusId) ?? laid;
    // ★ `null`, NOT `undefined`: the root's `parent` is `null`. An `undefined` test would
    //   let the root through and dereference a null on a click at the centre.
    if (node.data.id === focus.data.id && focus.parent !== null) {
      zoomTo(focus.parent.data.id, true);
      return;
    }
    zoomTo(node.data.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    if (e.key !== 'Escape') return;
    const focus = byId.get(focusId) ?? laid;
    if (focus.parent === null) return;
    // Only consumed when it actually climbs a level, so an outer Escape handler still
    // sees the key at the top of the disc.
    e.stopPropagation();
    zoomTo(focus.parent.data.id, true);
  };

  /**
   * ★ FOCUS IS RESTORED AFTER the transition has drawn the target, not before. On the way
   *   out the parent's ring is still zero-width in the first frame, so the element does
   *   not exist yet — clearing the request only once it is found makes the retry free.
   */
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const svg = svgRef.current;
    if (svg === null) return;
    const el = Array.from(svg.querySelectorAll<SVGPathElement>('path[data-nid]')).find(
      (p) => p.dataset.nid === id,
    );
    if (el === undefined) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
  }, [focusId, view]);

  const focusArc = byId.get(focusId) ?? laid;
  /** How many radial bands are in play — the divisor that keeps the disc full at every zoom. */
  const bands = focusArc.height + 1;
  const R = Math.max(60, Math.min(box.w, box.h) / 2 - 10);
  const cx = box.w / 2;
  const cy = box.h / 2;
  const radiusOf = (y: number): number => (y / bands) * R;

  const crumbs = focusArc.ancestors().reverse();
  const crumbNodes = crumbs.flatMap((n, i) => {
    const last = i === crumbs.length - 1;
    const node = last ? (
      <span key={n.data.id} className="lin__crumb lin__crumb--on" aria-current="true">
        {n.data.name}
      </span>
    ) : (
      <button
        key={n.data.id}
        type="button"
        className="lin__crumb"
        onClick={() => zoomTo(n.data.id, true)}
      >
        {n.data.name}
      </button>
    );
    return i === 0
      ? [node]
      : [
          <span key={`sep-${n.data.id}`} className="lin__crumbsep" aria-hidden="true">
            ›
          </span>,
          node,
        ];
  });

  return (
    <section className="lin__canvas lin__canvas--sunburst" aria-label="Project burst">
      <div className="lin__canvasbar">
        <span className="lin__mode">Project burst</span>
        <span className="lin__count">
          {num(meta.lineCount)} {pluralise(meta.lineCount, 'PO line')} across{' '}
          {num(meta.accountCount)} {pluralise(meta.accountCount, 'account')} ·{' '}
          {num(meta.invoiceCount)} {pluralise(meta.invoiceCount, 'invoice')} ·{' '}
          {num(meta.checkCount)} {pluralise(meta.checkCount, 'check')}
          {/* A zero-amount line draws no wedge at all — the partition gives every child of
              a zero-value parent zero width. Counted here so a missing wedge reads as a
              fact about the data rather than a gap in the drawing. */}
          {meta.zeroLines > 0 ? (
            <span className="lin__overflow">
              {' '}
              · {num(meta.zeroLines)} zero-amount {pluralise(meta.zeroLines, 'line')} cannot
              be drawn
            </span>
          ) : null}
        </span>
        <select
          className="lin__node-select"
          aria-label="Jump to a ring or an arc"
          value={focusArc.data.id}
          onChange={(e) => {
            const id = e.target.value;
            if (id !== '') zoomTo(id);
          }}
        >
          <option value="">Jump to…</option>
          {arcs.map((n) => (
            <option key={n.data.id} value={n.data.id}>
              {tree.rings[n.data.depth]?.title ?? ''} · {n.data.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost btn--sm lin__fit"
          title="Show the whole project again"
          onClick={() => zoomTo(laid.data.id, true)}
        >
          Whole project
        </button>
      </div>

      {/* ★ THE BREADCRUMB IS THE ROUTE THE REFERENCE IMAGE DOES NOT HAVE. In the reference
          the only way out of a zoomed ring is to click the few-pixel centre disc, which is
          undiscoverable and, at a small panel size, unclickable. */}
      <nav className="lin__crumbs" aria-label="Burst depth">
        {crumbNodes}
        <span className="sr" aria-live="polite">
          {degenerate ? '' : `Showing ${focusArc.data.label}`}
        </span>
      </nav>

      <div className="lin__burst" ref={wrapRef}>
        {degenerate ? (
          <p className="lin__busy">
            This project has no committed total to divide by, so the burst has nothing to
            draw. The purchase-order lines are on the Details tab.
          </p>
        ) : (
          <svg
            ref={svgRef}
            className="lin__burstsvg"
            viewBox={`0 0 ${box.w} ${box.h}`}
            role="group"
            aria-label={`Project burst: ${focusArc.data.label} at the centre, with its accounts, purchase-order lines, invoices and checks as rings around it`}
            onKeyDown={onKeyDown}
          >
            <g transform={`translate(${cx} ${cy})`}>
              {arcs.map((node) => {
                const rect = view.get(node.data.id);
                if (rect === undefined) return null;
                const width = rect.x1 - rect.x0;
                if (width < MIN_WIDTH) return null;
                const inner = radiusOf(rect.y0);
                const outer = radiusOf(rect.y1);
                if (outer - inner < MIN_THICK) return null;
                const label = describeArc(node);
                const on = selectedId === node.data.id;
                const here = node.data.id === focusArc.data.id;
                return (
                  <path
                    key={node.data.id}
                    data-nid={node.data.id}
                    className={`lin__arc${on ? ' lin__arc--on' : ''}${
                      here ? ' lin__arc--focus' : ''
                    }`}
                    d={arcPath(inner, outer, rect.x0, rect.x1)}
                    // ★ THE FILL IS A PRESENTATION ATTRIBUTE, NOT A CSS RULE, SO THE
                    //   ACCOUNT PALETTE STAYS THE SINGLE SOURCE OF TRUTH it already is
                    //   for the network view's legend. A CSS `fill` in the stylesheet
                    //   would beat this attribute — inline styles outrank presentation
                    //   attributes — and the palette would silently fork.
                    fill={node.data.account === null ? '#1f2937' : accountColour(accounts, node.data.account)}
                    stroke="var(--surface-sunken)"
                    strokeWidth={1}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      here && node.parent !== null
                        ? `${label}. Activate to go back to ${node.parent.data.name}`
                        : label
                    }
                    onClick={() => onArc(node)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      // ★ SPACE SCROLLS THE PAGE OTHERWISE, and a `role="button"` that
                      //   scrolls instead of activating is a broken control.
                      e.preventDefault();
                      e.stopPropagation();
                      onArc(node);
                    }}
                  >
                    <title>{label}</title>
                  </path>
                );
              })}

              {/* ★ LABELS ARE DECORATION — every one of them is inside a path's own
                  `aria-label`, so the text is hidden from the accessibility tree rather
                  than read out a second time in a different order. */}
              <g className="lin__arclabels" aria-hidden="true">
                {arcs.map((node) => {
                  const rect = view.get(node.data.id);
                  if (rect === undefined) return null;
                  const width = rect.x1 - rect.x0;
                  const inner = radiusOf(rect.y0);
                  const outer = radiusOf(rect.y1);
                  if (outer - inner < 14) return null;
                  const midR = (inner + outer) / 2;
                  const avail = width * midR;
                  if (avail < LABEL_MIN_PX) return null;
                  const text = fit(node.data.name, avail - 8, LABEL_FONT);
                  if (text === '') return null;
                  const mid = (rect.x0 + rect.x1) / 2;
                  const deg = (mid * 180) / Math.PI;
                  // ★ TEXT RUNS ALONG THE ARC, TANGENTIALLY. Radial text has only the
                  //   ring's thickness to fit in — about 52px here — which is not enough
                  //   for a word; the arc's own length is the room that actually exists.
                  const flip = deg > 90 && deg < 270;
                  return (
                    <text
                      key={node.data.id}
                      className="lin__arclabel"
                      transform={`rotate(${deg.toFixed(2)}) translate(0 ${(-midR).toFixed(2)})${
                        flip ? ' rotate(180)' : ''
                      }`}
                      fontSize={LABEL_FONT}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {text}
                    </text>
                  );
                })}
              </g>
            </g>
          </svg>
        )}
      </div>

      {/* ★ A RING-BY-RING SUMMARY, NOT A REPEAT OF ALL ~100 ARCS. Each arc is already a
          labelled, focusable control; transcribing the whole hierarchy into a hidden
          table would add a hundred more stops to the reading order and say nothing the
          arcs do not. This says what each ring MEASURES, which the arcs cannot. */}
      <table className="sr">
        <caption>
          Summary of the project burst — what each ring measures and how much is on it
        </caption>
        <thead>
          <tr>
            <th scope="col">Ring</th>
            <th scope="col">Arcs</th>
            <th scope="col">What one arc&rsquo;s width means</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {tree.rings.map((ring) => (
            <tr key={ring.depth}>
              <th scope="row">{ring.title}</th>
              <td>{num(ring.arcs)}</td>
              <td>
                {ring.unit} — measured as a share of {ring.denominator}
              </td>
              <td>{ring.measure === 'count' ? num(ring.total) : money0(ring.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
