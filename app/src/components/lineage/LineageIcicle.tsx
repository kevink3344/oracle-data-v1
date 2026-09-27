import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accountColour, type LineageNode } from '../../data/lineage';
import { money0, num, pct, pluralise } from '../../data/format';
import {
  partitionIcicle,
  sunburstSelection,
  type PartitionCell,
  type SunburstTree,
} from '../../data/sunburst';

/**
 * ★★ THE RECTANGULAR READING OF THE SAME BURST.
 *
 * This view is the Burst tab's own tree, drawn with the axes exchanged. It is NOT a second
 * calculation of anything: `LineageView` builds one `SunburstTree` from one
 * `buildSunburstTree(project, lines, indexLinks(links))` call and hands the identical
 * object to both components, so the two readings cannot disagree about a node's measure,
 * its label, its account colour or the project's totals — only about where on the screen
 * that measure is drawn.
 *
 * ── ★★ WHICH AXIS CARRIES WHAT ───────────────────────────────────────────────
 *
 *   Burst    angle  = the measure        radius = depth
 *   Icicle   height = the measure        width  = depth      ← VERTICAL
 *
 * Five columns, one per level, left to right: project, account, PO line, invoice, check.
 * Within a column the cells stack from top to bottom in the order the tree lists them, so
 * a cell's HEIGHT is its share of its own PARENT — the rule `sunburst.ts` exists to protect
 * (`d3.partition` divides by `parent.value`, never by a sum of children). The 20 PO-line
 * cells therefore tile exactly the full height of the account column they are booked to,
 * and each account's cell tiles the full height of the project column.
 *
 * ★★ THE ORIENTATION LIVES IN THE SCALING AND NOWHERE ELSE. `d3.partition` still puts the
 *    measure in `x` and the depth in `y` — `partitionIcicle` is untouched, still
 *    `.size([1, SUNBURST_DEPTHS])` — so this file is what decides that `x` is drawn DOWN
 *    the screen and `y` ACROSS it. Swapping `bandW` for the measure and `yOf` for the depth
 *    is the entire difference between the upright chart and the sideways one, which is why
 *    nothing about the tree, the ring wording or the sibling disc may depend on the choice.
 *
 * The column count is `focus.height + 1`, so zooming into an account drops the project
 * column and every remaining column gets wider — the same "the focused node becomes the
 * outermost full ring" behaviour the disc has, expressed as the focused node becoming the
 * full-height column on the left.
 *
 * ── ★ THE CELLS ARE PLAIN `<rect>`s ─────────────────────────────────────────
 *
 * There is no arc arithmetic here at all, and none of the disc's two special cases apply:
 * a `rect` whose HEIGHT equals its parent's is just a tall rect rather than an SVG arc
 * whose start and end points coincide, so the full-ring two-halves problem simply does not
 * exist on this axis. The whole renderer is `x`, `width`, `y`, `height` and a label.
 */

/**
 * ★ THE TWO FILTER THRESHOLDS, NAMED FOR THE AXIS EACH ONE FILTERS.
 *
 * `MIN_CELL_H` gates the MEASURE (the vertical extent, in the remapped `[0,1]` space) and
 * `MIN_BAND_W` gates the DEPTH (a fraction of one column, in the partition's own band
 * units). Both were named for the horizontal reading until the chart was turned upright —
 * a constant called `MIN_BAND_H` that filters the across axis is the same trap as a colour
 * class named for a value it no longer holds.
 */
/** Never shorter than this, so the measure axis always has room to show a difference. */
const MIN_H = 240;
/** Measure (in the remapped [0,1] space) below which a cell is not worth a rect. */
const MIN_CELL_H = 1e-4;
/** Depth below which a cell is not worth a rect, in band units. */
const MIN_BAND_W = 0.25;
/** A cell needs this much room before it gets a text label. */
const LABEL_MIN_PX = 34;
const LABEL_PAD = 6;
const LABEL_FONT = 11;
/** Average glyph advance as a fraction of font size, for fitting a label to its cell. */
const GLYPH = 0.56;

/**
 * A node's placed rectangle in the current zoom frame.
 *
 * ★ THESE ARE THE PARTITION'S OWN AXES, NOT THE SCREEN'S. `x` is the MEASURE (normalised to
 *   `[0,1]`) and `y` is the DEPTH (in band units) — exactly the pair `d3.partition` emits,
 *   and the same pair `LineageSunburst.tsx` holds, where `x` is an angle. Which of the two
 *   is drawn across the screen and which down it is decided ONLY by `bandW` and `yOf` in
 *   the renderer below. Keeping the names tied to the partition rather than to the screen
 *   is what lets the chart be turned upright without touching `targetsFor`, the tween, or
 *   the sibling disc.
 */
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
 * Remap every cell into the frame of the focus.
 *
 * ★ THE SUNBURST'S FUNCTION WITH THE ANGLE TAKEN OUT. Its `clamp01(… ) × 2π` becomes a bare
 *   `clamp01(…)`, because the measure axis is already a unit span. The depth term is
 *   identical — an ancestor clamps to `0` on both ends and so has zero DEPTH, which is what
 *   takes it off the chart (zero radius on the disc, zero width on this orientation)
 *   without any special casing, and without this function knowing which way round the
 *   renderer draws the two axes.
 */
function targetsFor(cells: PartitionCell[], focus: PartitionCell): Map<string, Rect> {
  // The focus's own ORIGINAL span, which is what its children tile. Guarded because a
  // zero-amount line leaves it at 0, and dividing by it would give every child a NaN
  // rect — which SVG renders as nothing, i.e. a silent empty chart.
  const span = focus.x1 - focus.x0 || 1;
  const out = new Map<string, Rect>();
  for (const n of cells) {
    out.set(n.data.id, {
      x0: clamp01((n.x0 - focus.x0) / span),
      x1: clamp01((n.x1 - focus.x0) / span),
      y0: Math.max(0, n.y0 - focus.depth),
      y1: Math.max(0, n.y1 - focus.depth),
    });
  }
  return out;
}

/**
 * ★★ THE CLAMP, IN ONE PLACE, BECAUSE IT IS GEOMETRY AND TWO PASSES NEED IT.
 *
 * An invoice can name MORE than the line's amount — one line in this project reached 112%
 * — and that measure drawn honestly would run past the end of the column it belongs to and
 * overpaint the cell below it. The data model reports the excess (`meta.overLines`) and
 * `describeCell` says so in words, so the drawing has to agree with both: the cell ends
 * where its parent ends.
 *
 * ★ IT IS SHARED RATHER THAN INLINED so that the label pass centres a clamped cell's text
 *   on the cell that was actually DRAWN. A second copy of this arithmetic inside the label
 *   loop is exactly how the drawing and its labels would come to disagree — and it would do
 *   it silently, on one line of one project.
 */
function measureEnd(node: PartitionCell, rect: Rect, view: Map<string, Rect>): number {
  if (node.data.over !== true || node.parent === null) return rect.x1;
  const parent = view.get(node.parent.data.id);
  return parent === undefined ? rect.x1 : Math.min(rect.x1, parent.x1);
}

/**
 * Shorten a label to the room its cell actually has, measured rather than guessed.
 *
 * ★ THE ROOM IS THE CELL'S DEPTH, NOT ITS MEASURE. The labels are set horizontally, so
 *   what limits one is the WIDTH OF THE COLUMN its cell sits in — the across axis — not the
 *   height the cell occupies. The call site passes the column width; feeding `fit` the
 *   measure instead would clip nothing and let the text run out of its own column.
 *
 * ★ THE TEST IS THE CELL'S OWN WIDTH, not a list of which labels to draw, so the same view
 *   is correct at every zoom level and stays correct if the project's shape changes. A
 *   hand-kept list of "which levels get labels" would be right for exactly the project it
 *   was tuned on.
 */
function fit(text: string, availPx: number, fontPx: number): string {
  const max = Math.floor(availPx / (GLYPH * fontPx));
  if (max < 2) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One sentence for one cell — the `aria-label`, and the native `<title>` tooltip.
 *
 * ★ LEVEL 4 IS DESCRIBED AS A SHARE OF ITS OWN PO LINE, because that is what its extent is
 *   — the cell's height on this orientation, the arc's angle on the disc. `d.ratio` is the
 *   RAW share (which can exceed 1 — one line here reached 112%), while the cell is drawn
 *   clamped to the line, so the drawn share is stated and the excess is named as the reason
 *   the cell is full.
 *
 * ★ THE CLAMP IS APPLIED TO THE GEOMETRY, NOT ONLY TO THIS SENTENCE — `measureEnd` below is
 *   called by both the rect and the label, so the description, the drawn cell and the place
 *   its label is centred agree by construction.
 */
function describeCell(node: PartitionCell): string {
  const d = node.data;
  const parent = node.parent?.data;
  // ★ `parent` IS `null` AT THE ROOT, NOT `undefined` — `node.parent?.data` collapses the
  //   two, so the guard has to read the collapsed value. Guarding the optional chain
  //   against `undefined` compiles only by accident and would divide by a null's value.
  const share = parent !== undefined && parent.value > 0 ? d.value / parent.value : null;
  switch (d.kind) {
    case 'project':
      return `${d.label} — the whole figure, ${money0(d.measure)} committed`;
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
      return `The ${pluralise(d.invoices, 'invoice')} on PO ${
        parent?.name ?? ''
      }: ${money0(d.measure)} reached, ${pct(drawn)} of the line's amount${caveat}`;
    }
    case 'check':
      return `The ${pluralise(d.checks, 'check')} on PO ${
        parent?.name ?? ''
      }, one equal share each`;
    default:
      return d.label;
  }
}

export default function LineageIcicle({ tree, accounts, onSelect, selectedId }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * ★★ BOTH DIMENSIONS ARE MEASURED, AND THAT IS THE ONE REAL CONSEQUENCE OF THE FLIP.
   *
   * Sideways, the chart's HEIGHT was ours to decide (the band count times a fixed row
   * height) and only the width had to come from the container. Upright the two axes trade
   * roles, so the container has to supply a definite height as well — the stylesheet gives
   * `.lin__icicle` one — and both numbers are read in the same observer callback. The width
   * is not optional either: it is what the columns share out between them.
   */
  const [panel, setPanel] = useState({ w: 820, h: MIN_H });

  const meta = tree.meta;

  const laid = useMemo(() => partitionIcicle(tree.root), [tree]);
  const cells = useMemo(() => laid.descendants(), [laid]);
  const byId = useMemo(() => {
    const map = new Map<string, PartitionCell>();
    for (const n of cells) map.set(n.data.id, n);
    return map;
  }, [cells]);

  const [focusId, setFocusId] = useState(() => tree.root.id);
  /** The geometry currently on screen — the tween's interpolation target, frame by frame. */
  const [view, setView] = useState<Map<string, Rect>>(() => targetsFor(laid.descendants(), laid));
  const viewRef = useRef(view);
  const pendingFocus = useRef<string | null>(null);

  /** ★ REDUCED MOTION IS READ ONCE, NOT PER FRAME. */
  const reduce = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  /**
   * ★ SIZED FROM ITS CONTAINER, MEASURED ONCE PER RESIZE — the `ResizeObserver` +
   *   `requestAnimationFrame` shape `TrendChart.tsx`, `LineageCanvas.tsx` and
   *   `LineageSunburst.tsx` all use. The rAF is deliberate: a `ResizeObserver` fires during
   *   layout, and setting state synchronously in that callback produces a render-loop
   *   warning.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setPanel({
          w: Math.max(360, Math.round(el.clientWidth)),
          h: Math.max(MIN_H, Math.round(el.clientHeight)),
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
   * ★★ THE TWEEN: EVERY CELL MOVES FROM WHERE IT IS TO WHERE IT BELONGS.
   *
   * Interpolating each node's own rect — rather than transitioning the focus and recomputing
   * — is what makes a cell that leaves the chart SHRINK TO NOTHING instead of jumping. Nodes
   * with no previous rect start with zero measure and grow, so a zoom out reveals the levels
   * it was hiding rather than flashing them in.
   *
   * ★ `targetsFor` reads `cells` (the laid-out tree); when the project or the links change,
   *   an id that no longer exists falls back to the root layout below, so a stale focus
   *   self-heals instead of rendering an empty chart.
   */
  useEffect(() => {
    const focus = byId.get(focusId) ?? laid;
    const to = targetsFor(cells, focus);
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
        // ★ A NODE THAT WAS NOT ON SCREEN GROWS FROM NOTHING, down from the top of its own
        //   column, rather than appearing at full height.
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
  }, [focusId, byId, cells, laid, reduce]);

  /**
   * ★ DIAGNOSTIC FIRST, THEN THE MESSAGE. `d3.partition` divides by the parent's own
   *   measure, so a project whose committed total is zero produces a chart of zero-extent
   *   cells — every cell correct and the whole picture empty. Saying so is the difference
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
   *   only way out of a zoomed level is to click a thin sliver of the level above. Making
   *   the focused column act as a "back" control costs nothing and removes that trap for
   *   mouse users; the keyboard has Escape and the breadcrumb has both.
   */
  const onCell = (node: PartitionCell): void => {
    const focus = byId.get(focusId) ?? laid;
    // ★ `null`, NOT `undefined`: the root's `parent` is `null`. An `undefined` test would
    //   let the root through and dereference a null on a click.
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
    // Only consumed when it actually climbs a level, so an outer Escape handler still sees
    // the key at the top of the chart.
    e.stopPropagation();
    zoomTo(focus.parent.data.id, true);
  };

  /**
   * ★ FOCUS IS RESTORED AFTER the transition has drawn the target, not before. On the way
   *   out the parent's band is still zero-width in the first frame, so the element does not
   *   exist yet — clearing the request only once it is found makes the retry free.
   */
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const svg = svgRef.current;
    if (svg === null) return;
    const el = Array.from(svg.querySelectorAll<SVGRectElement>('rect[data-nid]')).find(
      (r) => r.dataset.nid === id,
    );
    if (el === undefined) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
  }, [focusId, view]);

  const focusCell = byId.get(focusId) ?? laid;
  /** How many columns are in play — the divisor that keeps the chart full at every zoom. */
  const bands = focusCell.height + 1;
  const chartW = panel.w;
  const chartH = panel.h;
  /**
   * One depth column's width in px. Constant per zoom level, so the columns read as columns
   * and the cells of one level line up down the chart.
   */
  const bandW = chartW / bands;
  /**
   * ★★ THE MEASURE, SCALED DOWN THE SCREEN — THE WHOLE ORIENTATION IS IN THIS LINE. Depth is
   *    scaled across by `bandW` at each call site; exchanging these two scales is exactly
   *    what turns the chart on its side, and nothing above this line knows about it.
   */
  const yOf = (m: number): number => m * chartH;

  const crumbs = focusCell.ancestors().reverse();
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
    <section className="lin__canvas lin__canvas--icicle" aria-label="Project icicle">
      <div className="lin__canvasbar">
        <span className="lin__mode">Project icicle</span>
        <span className="lin__count">
          {pluralise(meta.lineCount, 'PO line')} across {pluralise(meta.accountCount, 'account')}{' '}
          · {pluralise(meta.invoiceCount, 'invoice')} · {pluralise(meta.checkCount, 'check')}
          {/* A zero-amount line draws no cell at all — the partition gives every child of a
              zero-value parent no extent whatever. Counted here so a missing cell reads as
              a fact about the data rather than a gap in the drawing. */}
          {meta.zeroLines > 0 ? (
            <span className="lin__overflow">
              {' '}
              · {pluralise(meta.zeroLines, 'zero-amount line')} cannot be drawn
            </span>
          ) : null}
        </span>
        <select
          className="lin__node-select"
          aria-label="Jump to a level or a cell"
          value={focusCell.data.id}
          onChange={(e) => {
            const id = e.target.value;
            if (id !== '') zoomTo(id);
          }}
        >
          <option value="">Jump to…</option>
          {cells.map((n) => (
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

      {/* ★ THE BREADCRUMB IS THE ROUTE OFF A ZOOMED LEVEL THAT THE CHART ITSELF CANNOT OFFER. */}
      <nav className="lin__crumbs" aria-label="Icicle depth">
        {crumbNodes}
        <span className="sr" aria-live="polite">
          {degenerate ? '' : `Showing ${focusCell.data.label}`}
        </span>
      </nav>

      {/* ★ NO INLINE HEIGHT ANY MORE. Sideways the height was the dimension WE chose, so it
          had to be written onto the element; upright the height IS the measure axis and is
          read back from the element instead, so the stylesheet owns the box and this
          component only measures it. */}
      <div className="lin__icicle" ref={wrapRef}>
        {degenerate ? (
          <p className="lin__busy">
            This project has no committed total to divide by, so the icicle has nothing to
            draw. The purchase-order lines are on the Details tab.
          </p>
        ) : (
          <svg
            ref={svgRef}
            className="lin__iciclesvg"
            viewBox={`0 0 ${chartW} ${chartH}`}
            role="group"
            aria-label={`Project icicle: ${focusCell.data.label} in the left column, with its accounts, purchase-order lines, invoices and checks as columns to its right`}
            onKeyDown={onKeyDown}
          >
            {cells.map((node) => {
              const rect = view.get(node.data.id);
              if (rect === undefined) return null;
              /** The partition's axes: `x` is the measure, `y` is the depth. */
              const measure = rect.x1 - rect.x0;
              const depth = rect.y1 - rect.y0;
              if (measure < MIN_CELL_H) return null;
              if (depth < MIN_BAND_W) return null;

              const x = rect.y0 * bandW;
              const w = depth * bandW;
              const y = yOf(rect.x0);
              const h = Math.max(0, yOf(measureEnd(node, rect, view)) - y);
              if (h < 0.5) return null;

              const label = describeCell(node);
              const on = selectedId === node.data.id;
              const here = node.data.id === focusCell.data.id;
              return (
                <rect
                  key={node.data.id}
                  data-nid={node.data.id}
                  className={`lin__cell${on ? ' lin__cell--on' : ''}${
                    here ? ' lin__cell--focus' : ''
                  }`}
                  x={x.toFixed(2)}
                  y={y.toFixed(2)}
                  width={w.toFixed(2)}
                  height={h.toFixed(2)}
                  // ★ THE FILL IS A PRESENTATION ATTRIBUTE, NOT A CSS RULE, SO THE ACCOUNT
                  //   PALETTE STAYS THE SINGLE SOURCE OF TRUTH it already is for the network
                  //   view's legend. A CSS `fill` in the stylesheet would beat this attribute
                  //   — inline styles outrank presentation attributes — and the palette
                  //   would silently fork.
                  fill={
                    node.data.account === null
                      ? '#1f2937'
                      : accountColour(accounts, node.data.account)
                  }
                  stroke="var(--surface-sunken)"
                  strokeWidth={1}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    here && node.parent !== null
                      ? `${label}. Activate to go back to ${node.parent.data.name}`
                      : label
                  }
                  onClick={() => onCell(node)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    // ★ SPACE SCROLLS THE PAGE OTHERWISE, and a `role="button"` that scrolls
                    //   instead of activating is a broken control.
                    e.preventDefault();
                    e.stopPropagation();
                    onCell(node);
                  }}
                >
                  <title>{label}</title>
                </rect>
              );
            })}

            {/* ★ LABELS ARE DECORATION — every one of them is inside a cell's own
                `aria-label`, so the text is hidden from the accessibility tree rather than
                read out a second time in a different order. */}
            <g className="lin__celllabels" aria-hidden="true">
              {cells.map((node) => {
                const rect = view.get(node.data.id);
                if (rect === undefined) return null;
                const measure = rect.x1 - rect.x0;
                const depth = rect.y1 - rect.y0;
                if (measure < MIN_CELL_H) return null;
                if (depth < MIN_BAND_W) return null;
                // ★ THE ROOM IS THE COLUMN, NOT THE CELL. The text runs horizontally, so
                //   what it has to fit inside is the width of the DEPTH column it sits in.
                const colWd = depth * bandW;
                if (colWd < LABEL_MIN_PX) return null;
                const room = colWd - LABEL_PAD * 2;
                /**
                 * ★ THE FULL LABEL IF IT FITS, THE SHORT NAME IF IT DOES NOT. The columns
                 *   are wide — five of them across one panel is a fifth each — so most
                 *   cells can carry the readable label ("PO 266121 · line 3") rather than
                 *   the compact key ("266121·3") the disc uses.
                 */
                const spelled = fit(node.data.label, room, LABEL_FONT);
                const text =
                  spelled === node.data.label ? spelled : fit(node.data.name, room, LABEL_FONT);
                if (text === '') return null;
                // ★ CENTRED ON THE DRAWN CELL, NOT ON THE RAW MEASURE. An over-100% cell is
                //   drawn clamped, and its label has to follow the rect it belongs to or it
                //   would sit outside its own cell. Same `measureEnd` the rect used.
                const top = yOf(rect.x0);
                const h = Math.max(0, yOf(measureEnd(node, rect, view)) - top);
                return (
                  <text
                    key={node.data.id}
                    className="lin__celllabel"
                    // ★ STILL HORIZONTAL, STILL LEFT-ALIGNED, NOW IN ITS COLUMN. Rotating
                    //   the text is the reflex on a narrow column, but a five-column chart
                    //   gives each column a fifth of the panel, so the readable horizontal
                    //   label fits; `fit` shortens it on a narrow screen rather than letting
                    //   it run out of the column. `x` is the column's left edge and `y` is
                    //   the CELL's middle — the two roles the sideways mapping had the other
                    //   way round.
                    x={(rect.y0 * bandW + LABEL_PAD).toFixed(2)}
                    y={(top + h / 2).toFixed(2)}
                    fontSize={LABEL_FONT}
                    textAnchor="start"
                    dominantBaseline="middle"
                  >
                    {text}
                  </text>
                );
              })}
            </g>
          </svg>
        )}
      </div>

      {/* ★ A LEVEL-BY-LEVEL SUMMARY, NOT A REPEAT OF ALL ~100 CELLS. Each cell is already a
          labelled, focusable control; transcribing the whole hierarchy into a hidden table
          would add a hundred more stops to the reading order and say nothing the cells do
          not. This says what each LEVEL measures, which the cells cannot.

          ★ THE WORDING IS THE BURST'S, FROM THE SAME `tree.rings`. One spec, two readings. */}
      <table className="sr">
        <caption>
          Summary of the project icicle — what each level measures and how much is on it
        </caption>
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">Cells</th>
            <th scope="col">What one cell&rsquo;s height means</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {tree.rings.map((ring) => (
            <tr key={ring.depth}>
              <th scope="row">{ring.title}</th>
              <td>{num(ring.arcs)}</td>
              <td>
                {ring.unit} — {ring.denominator}
              </td>
              <td>{ring.measure === 'count' ? num(ring.total) : money0(ring.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
