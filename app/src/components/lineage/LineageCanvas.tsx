import { useEffect, useMemo, useRef, useState } from 'react';
import type { LineageEdge, LineageGraph, LineageNode } from '../../data/lineage';
import { accountColour } from '../../data/lineage';
import {
  layoutBrain,
  layoutPipeline,
  networkRadius,
  NODE_H,
  NODE_W,
  type PlacedNode,
  type Placement,
} from './layouts';

/**
 * The lineage canvas — one SVG, two layouts.
 *
 * ── ★★ WHY THIS IS A HAND-ROLLED SVG AND NOT A GRAPH LIBRARY ────────────────
 *
 * The source document suggested `@xyflow/react` for the flowchart and
 * `react-force-graph` for the brain. Neither is used, and the reasoning is worth
 * keeping:
 *
 *   · **`react-force-graph` wraps three.js and WebGL** for its 3D variant and pulls a
 *     large tree for the 2D one. For ~30 text cards that is a canvas renderer where
 *     the app's CSS tokens, its theme, and its accessibility tree do not apply.
 *   · **`@xyflow/react` earns its weight when nodes are DRAGGED, CONNECTED and
 *     EDITED.** None of that is in scope: both views are read-only. It also brings its
 *     own stylesheet and a provider context, which would fight the app's token system.
 *   · **`d3-force` and `dagre` are LAYOUT ONLY** — they compute `x`/`y` and nothing
 *     else. That is exactly the seam wanted: the layout is a pure function and the
 *     drawing stays in the app's own SVG, following the pattern `TrendChart.tsx`
 *     already sets (a `viewBox`, a `ResizeObserver`, a `useMemo` geometry block).
 *
 * So: two small layout dependencies, no rendering framework.
 */

export type ViewMode = 'pipeline' | 'brain';

interface Props {
  graph: LineageGraph;
  mode: ViewMode;
  /** The project's account codes in display order — the colour key. */
  accounts: string[];
  onSelect: (node: LineageNode) => void;
  selectedId: string | null;
}

/**
 * The network's dot colours — darker and closer together than the flowchart's.
 *
 * ★★ THE NETWORK IS NEAR-MONOCHROME ON PURPOSE. The reference image is black circles
 * on white: the eye reads SIZE and POSITION, and hue carries nothing. Brightly-coloured
 * dots turn a mesh into confetti and the structure — which is the entire point of the
 * view — is lost. So the account palette is darkened here, and the project and vendor
 * dots are greys, leaving only a slight hue to tell an account cluster from a vendor.
 *
 * ★ THE FLOWCHART KEEPS THE BRIGHTER PALETTE, because there each node is a card with a
 *   label and the colour is doing real work as a key.
 */
const NETWORK_COLOURS: Record<string, string> = {
  project: '#1f2937',
  account: '#2f4f6f',
  vendor: '#4b5563',
  invoice: '#3f5d4a',
  check: '#4a5568',
  po: '#5b4636',
};

/** The node's fill, by kind. Accounts take their colour from the project's own list. */
function nodeColour(node: PlacedNode, accounts: string[], mode: ViewMode): string {
  if (mode === 'brain') {
    // ★ IN THE NETWORK EVERY ACCOUNT SHARES ONE HUE — see the note on NETWORK_COLOURS.
    //   Distinguishing four accounts by colour in a mesh is what makes it confetti; the
    //   cluster POSITION already distinguishes them, which is the stronger signal.
    return NETWORK_COLOURS[node.kind] ?? '#4b5563';
  }
  if (node.kind === 'account') {
    // `id` is `account:<level>:<object>`; the object is the last segment.
    const object = node.id.split(':').pop() ?? '';
    return accountColour(accounts, object);
  }
  if (node.kind === 'project') return '#1f2937';
  if (node.kind === 'po') return '#b5651d';
  if (node.kind === 'invoice') return '#1c7a52';
  if (node.kind === 'vendor') return '#6b7280';
  return '#4a6fa5'; // check
}

const KIND_LABEL: Record<string, string> = {
  project: 'Project',
  account: 'Account',
  po: 'PO line',
  invoice: 'Invoice',
  check: 'Check',
  vendor: 'Vendor',
};

export default function LineageCanvas({ graph, mode, accounts, onSelect, selectedId }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(true);
  const [box, setBox] = useState({ w: 900, h: 620 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /**
   * ★ THE HOVERED NODE, SO THE NETWORK CAN SHOW ITS NAME ON DEMAND.
   *
   * The reference image has no text in the canvas — names appear only when a node is
   * hovered or selected. This holds the hovered id; the click-selected node comes from
   * the parent. Both feed the same "show this label" test.
   */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /**
   * ★ THE CANVAS IS SIZED FROM ITS CONTAINER, MEASURED ONCE PER RESIZE.
   *
   * The same `ResizeObserver` + `requestAnimationFrame` shape `TrendChart.tsx` uses.
   * The rAF is not decoration: a `ResizeObserver` fires during layout, and setting
   * state synchronously in that callback produces a render loop warning.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setBox({
          w: Math.max(360, Math.round(el.clientWidth)),
          h: Math.max(320, Math.round(el.clientHeight) || 620),
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
   * ★★ THE LAYOUT IS MEMOISED ON THE GRAPH AND THE MODE, NOT RE-RUN PER RENDER.
   *
   * This is the correction the review flagged in the source document's own code: its
   * `useEffect(() => applyLayout(viewMode), [viewMode, applyLayout])` re-runs whenever
   * `applyLayout`'s identity changes — which is every time the caller's arrays are new.
   * A force simulation re-run on every render is both slow and *non-deterministic*:
   * the graph would settle differently each time and the reader could never build a
   * mental map of it.
   *
   * The dependency list is therefore the graph's identity plus the mode and the box —
   * and the layout runs once per (graph, mode, size).
   */
  const graphKey = useMemo(
    () => `${graph.nodes.length}:${graph.edges.length}:${graph.nodes.map((n) => n.id).join('|')}`,
    [graph],
  );

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const run = mode === 'pipeline' ? layoutPipeline : layoutBrain;
    void run(graph.nodes, graph.edges, box.w, box.h).then((p) => {
      // ★ A CANCELLED LAYOUT MUST NOT SET STATE. Switching modes twice quickly would
      //   otherwise let the slower layout land last and draw the wrong view.
      if (cancelled) return;
      setPlacement(p);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `graphKey` stands in for `graph`
  }, [graphKey, mode, box.w, box.h]);

  const viewBox = useMemo(() => {
    if (placement === null) return `0 0 ${box.w} ${box.h}`;
    return `0 0 ${placement.width} ${placement.height}`;
  }, [placement, box]);

  /**
   * ★★ THE DEFAULT SCALE IS A READABLE CONSTANT, NOT A FIT — AND THAT IS THE FIX.
   *
   * "Fit the graph to the panel" is the obvious default and it is the bug. Measured on
   * level 0450's Network view: a 1238×1095 layout in a 628×513 panel fits at **0.51**,
   * so an 11.5px label renders at **5.9px**. The graph was complete and unreadable —
   * which is the same as not drawing it, and exactly the report that came back.
   *
   * ★ SO THE VIEW OPENS AT 1:1 AND THE READER PANS. A graph is a map, not a thumbnail:
   *   you look at part of it and move. `Fit` is still one click away for a reader who
   *   wants the whole shape, and `Reset` returns here.
   *
   * ★ THE TRADE IS STATED RATHER THAN HIDDEN: at 1:1 the whole graph does not fit, so
   *   the view says how much of it is on screen. A reader who cannot see the edges of
   *   the picture should be told there is more, not left to guess.
   */
  const fit = 1;
  const scale = fit * zoom;

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(3, Math.max(0.4, z * (e.deltaY < 0 ? 1.12 : 0.89))));
  };

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d === null) return;
    setPan({ x: e.clientX - d.x, y: e.clientY - d.y });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const byId = useMemo(() => {
    const m = new Map<string, PlacedNode>();
    for (const n of placement?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [placement]);

  /**
   * ★★ THE DIM SET — EVERYTHING NOT ADJACENT TO THE SELECTION.
   *
   * This is the highest-value interaction in the view, because it answers the Network's
   * own question in one click: *"what is this connected to?"* The graph already knows —
   * the adjacency is in `edges` — so the only work is deciding what to hide.
   *
   * ★ THE SELECTED NODE IS IN THE SET OF KEPT, NOT THE DIMMED. It is the one thing the
   *   reader just asked about, so dimming it would be perverse.
   *
   * ★ IT IS COMPUTED FROM THE EDGES, NOT FROM A STORED NEIGHBOUR LIST. A second copy of
   *   the adjacency is a second thing that can disagree with the drawing; deriving it
   *   means the dimming can never highlight a node that is not actually connected.
   */
  const dimmed = useMemo(() => {
    const out = new Set<string>();
    if (selectedId === null) return out;
    const keep = new Set<string>([selectedId]);
    for (const e of placement?.edges ?? []) {
      if (e.source === selectedId) keep.add(e.target);
      if (e.target === selectedId) keep.add(e.source);
    }
    for (const n of placement?.nodes ?? []) {
      if (!keep.has(n.id)) out.add(n.id);
    }
    return out;
  }, [selectedId, placement]);

  return (
    <div className={`lin__canvas${mode === 'brain' ? ' lin__canvas--brain' : ''}`} ref={wrapRef}>
      <div className="lin__canvasbar">
        <span className="lin__mode">{mode === 'pipeline' ? 'Flowchart' : 'Network'}</span>
        <span className="lin__count">
          {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'} ·{' '}
          {graph.edges.length} link{graph.edges.length === 1 ? '' : 's'}
          {/*
            ★ THE "DOES IT ALL FIT" NOTE, AND IT IS NOT A NICETY.

            The view opens at 1:1 so the labels are readable, which means a graph bigger
            than the panel is CROPPED. Without this note a reader sees a partial picture
            and has no way to know — the nodes at the edge look like the end of the
            graph. One clause removes the whole class of "where is the rest of it".
          */}
          {placement !== null && (placement.width > box.w || placement.height > box.h) ? (
            <span className="lin__overflow"> · pan or Fit to see it all</span>
          ) : null}
        </span>

        {/*
          ★ THE ZOOM CONTROLS ARE NOT DECORATION — THEY ARE THE FIX FOR "I CAN'T SEE IT".

          The default is 1:1 so the labels are readable, which means the whole graph does
          not fit. A reader therefore needs a way to (a) zoom out to see the shape and
          (b) get back to a readable scale. Without these, the only way back from a
          zoomed-out view is a page reload.
        */}
        <div className="lin__zoom">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.3, z / 1.25))}
          >
            −
          </button>
          <span className="lin__zoomval" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
          >
            +
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            title="Zoom out until the whole graph is visible"
            onClick={() => {
              // ★ THE FIT IS COMPUTED, NOT A HARD-CODED 0.3. A fixed value would be
              //   wrong for every graph but the one it was tuned on — too small for a
              //   six-node project, too large for a sixty-node one.
              if (placement !== null && placement.width > 0) {
                setZoom(Math.min(box.w / placement.width, box.h / placement.height, 1));
              }
              setPan({ x: 0, y: 0 });
            }}
          >
            Fit
          </button>
        </div>
      </div>

      {busy ? <p className="lin__busy">Laying out the graph…</p> : null}

      <svg
        className="lin__svg"
        viewBox={viewBox}
        role="group"
        aria-label={`${mode === 'pipeline' ? 'Flowchart' : 'Network'} of this project's purchase orders, invoices and checks`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
          {/* ── Edges first, so nodes paint over them ── */}
          {placement?.edges.map((e: LineageEdge) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (a === undefined || b === undefined) return null;

            // ★ EDGE THICKNESS IS THE MONEY, AND IT IS THE ONLY QUANTITATIVE THING THE
            //   GRAPH HAS. A network where every edge looks the same throws that away —
            //   the reader cannot tell a $5M account from a $25K one.
            //
            //   The width is on a square-root scale, because area is what the eye reads:
            //   a linear scale makes the largest edge so thick it swamps the rest, and
            //   the smallest invisible.
            const maxAmount = Math.max(...placement.edges.map((x) => x.amount), 1);
            const w = 1 + 5 * Math.sqrt(Math.max(e.amount, 0) / maxAmount);

            /**
             * ★★ THE TWO VIEWS DRAW EDGES DIFFERENTLY, AND IT IS NOT COSMETIC.
             *
             * The Flowchart is a *flow*: its edges leave the right of one card and enter
             * the left of the next, so a cubic curve reads as direction. The Network is a
             * *relation*: edges join circle centres, and a curve between two circles
             * looks like a mistake. Straight lines are what the reference image uses.
             */
            if (mode === 'brain') {
              const ra = networkRadius(a);
              const rb = networkRadius(b);
              const ax = a.x + ra;
              const ay = a.y + ra;
              const bx = b.x + rb;
              const by = b.y + rb;
              // ★ THE LINE STOPS AT THE CIRCLE'S EDGE, NOT ITS CENTRE. Drawing to the
              //   centre puts the line *under* the circle, which is fine until the
              //   circle has a fill — then the line visibly disappears into it and the
              //   edge looks like it starts in the wrong place.
              const dx = bx - ax;
              const dy = by - ay;
              const len = Math.hypot(dx, dy) || 1;
              const ux = dx / len;
              const uy = dy / len;
              return (
                <line
                  key={e.id}
                  className="lin__edge"
                  x1={ax + ux * ra}
                  y1={ay + uy * ra}
                  x2={bx - ux * rb}
                  y2={by - uy * rb}
                  strokeWidth={w}
                />
              );
            }

            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={e.id}
                className="lin__edge"
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                strokeWidth={w}
              />
            );
          })}

          {/* ── Nodes ── */}
          {placement?.nodes.map((n) => {
            const colour = nodeColour(n, accounts, mode);
            const isSelected = n.id === selectedId;
            const common = {
              className: `lin__node${isSelected ? ' lin__node--on' : ''}`,
              onClick: () => onSelect(n),
              role: 'button' as const,
              tabIndex: 0,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(n);
                }
              },
            };

            /**
             * ★★ THE NETWORK DRAWS UNLABELLED CIRCLES — THIS IS THE REFERENCE IMAGE.
             *
             * The target is a force-directed *network*: a mesh of circles sized by how
             * connected they are, joined by thin lines, with **no text in the canvas**.
             * That absence is the whole aesthetic and it is also the functional point —
             * a label beside every node turns a network back into a diagram, and at fit
             * scale the labels collide into an unreadable grey band.
             *
             * ★ SO THE NAME APPEARS ON INTERACTION, NOT ALWAYS. Hovering or selecting a
             *   node shows its label; the rest stay silent. The reader gets the SHAPE at
             *   a glance and the NAMES on demand, which is the right order for a network.
             *
             * ★ THE RADIUS IS THE DEGREE, NOT THE MONEY. In the reference image the big
             *   circles are the well-connected ones. That is a different encoding from
             *   the Flowchart's (where width is amount) and it is the correct one here:
             *   the Network's question is "what is connected to what", so connectivity
             *   is what a circle's size should say.
             */
            /**
             * ★★ THE LABEL TIERS — WHAT MAKES THE VIEW READABLE AT REST.
             *
             * Measured before this change: **0 labels in the DOM**. Twenty-six identical
             * circles with names reachable only by hovering the exact right one — a
             * picture, not a chart. The reference images work because their nodes are
             * decorative; ours carry names a reader needs.
             *
             * ★ THREE TIERS, SO THE GRAPH IS LEGIBLE WITHOUT BECOMING A WALL OF TEXT:
             *
             *   · **Always on** — the project, the accounts, and any hub. This is the
             *     skeleton, and a reader must see it without doing anything. It is also
             *     what turns 26 dots into *"Athens Drive → 526, 527, 529, 532"*.
             *   · **On hover or focus** — vendors, invoices, checks. The reference
             *     image's "shape first, names on demand".
             *   · **When selected** — always, so a click's result is never invisible.
             */
            if (mode === 'brain') {
              const isHub = n.hub === true;
              const alwaysLabelled =
                n.kind === 'project' || n.kind === 'account' || isHub;
              const showLabel = alwaysLabelled || isSelected || hoveredId === n.id;
              const r = networkRadius(n);
              const cx0 = n.x + r;
              const cy0 = n.y + r;
              const onRight = cx0 > placement.width / 2;
              return (
                <g
                  key={n.id}
                  {...common}
                  className={`lin__node${isSelected ? ' lin__node--on' : ''}${
                    dimmed.has(n.id) ? ' lin__node--dim' : ''
                  }`}
                  transform={`translate(${cx0} ${cy0})`}
                  onPointerEnter={() => setHoveredId(n.id)}
                  onPointerLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                >
                  {/* ★ A HUB GETS A RING, PER THE IMAGE. A larger circle alone is
                      ambiguous at fit scale; the ring says "different" without asking
                      the reader to compare radii. */}
                  {isHub ? (
                    <circle className="lin__halo" r={r + 4} style={{ stroke: colour }} />
                  ) : null}
                  <circle className="lin__dot" r={r} style={{ fill: colour }} />

                  {/* ★ THE LABEL IS RENDERED ONLY WHEN ASKED FOR — see the note above.
                      `pointer-events: none` on it (in CSS) keeps it from stealing the
                      hover that revealed it. */}
                  {showLabel ? (
                    <g className="lin__netlabel-group">
                      <text
                        className={`lin__netlabel${isHub ? ' lin__netlabel--hub' : ''}${
                          alwaysLabelled ? ' lin__netlabel--anchor' : ''
                        }`}
                        x={onRight ? -(r + 8) : r + 8}
                        y={-2}
                        textAnchor={onRight ? 'end' : 'start'}
                      >
                        {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
                      </text>
                      <text
                        className="lin__netsub"
                        x={onRight ? -(r + 8) : r + 8}
                        y={12}
                        textAnchor={onRight ? 'end' : 'start'}
                      >
                        {n.subtitle}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            }

            return (
              <g key={n.id} {...common} transform={`translate(${n.x} ${n.y})`}>
                <rect
                  className="lin__card"
                  width={NODE_W}
                  height={NODE_H}
                  rx="7"
                  style={{ stroke: colour }}
                />
                {/* The kind bar — a colour key that survives a monochrome print. */}
                <rect x="0" y="0" width="4" height={NODE_H} rx="2" fill={colour} />
                {/*
                  ★ THE TEXT Y-OFFSETS ARE TIED TO `NODE_H`, NOT HARD-CODED. They were
                    literals (17/36/52) that matched a 62px card; when the card became
                    54px they would have pushed the subtitle past the bottom edge and
                    it would have silently vanished — a clipped label, not an error.
                */}
                <text className="lin__kind" x="11" y={NODE_H * 0.28} fill={colour}>
                  {KIND_LABEL[n.kind] ?? n.kind}
                </text>
                <text className="lin__label" x="11" y={NODE_H * 0.58}>
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                </text>
                <text className="lin__sub" x="11" y={NODE_H * 0.84}>
                  {n.subtitle.length > 26 ? `${n.subtitle.slice(0, 25)}…` : n.subtitle}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
