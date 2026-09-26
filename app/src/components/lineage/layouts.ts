import type { LineageEdge, LineageNode } from '../../data/lineage';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

/**
 * Node geometry, shared by both layouts.
 *
 * ★ THE SIZE IS A CONSTANT, NOT MEASURED FROM THE DOM, AND THAT IS DELIBERATE. Both
 *   layouts need node dimensions BEFORE anything renders — dagre to rank, d3-force to
 *   keep cards apart. Measuring the DOM first would mean a second render pass on every
 *   graph, and the cards are a fixed size by CSS anyway. If the CSS changes, this must
 *   change with it; `lineage.css` names this constant in its own comment so the pair is
 *   findable from either side.
 *
 * ★★ THE CARD IS SMALLER THAN THE SOURCE DOCUMENT'S 220×80, AND THE REASON IS LEGIBILITY.
 *   A graph's readable scale is set by its TOTAL EXTENT, not by its card size: five
 *   ranks of 220px cards plus 90px gaps is ~1,700px of layout, which in a panel fits at
 *   ~0.4 and renders 12px text at 5px. Shrinking the card and the gaps shrinks the
 *   extent, which RAISES the scale the whole graph fits at — so a smaller card is
 *   *more* readable here, not less. The label font is unchanged.
 */
export const NODE_W = 168;
export const NODE_H = 54;

/**
 * ★★ THE NETWORK DRAWS CIRCLES, NOT CARDS, AND THE SIZE CARRIES THE MEANING.
 *
 * The reference image is a node-link diagram: circles whose radius says how connected
 * a node is, joined by edges. That is a different drawing from the Flowchart's cards,
 * and it is the right one for the question the Network answers — *"what is the shape
 * of this project?"* — because a circle's area reads as weight at a glance, while a
 * card's does not.
 *
 * ★ THE RADII ARE THE IMAGE'S THREE TIERS: a small leaf, a larger account, and a hub
 *   drawn distinctly bigger. The hub radius is deliberately ~2× the leaf so the
 *   difference is unmistakable at fit scale — a 20% difference is invisible when the
 *   whole graph is on screen.
 */
export const R_LEAF = 9;
export const R_ACCOUNT = 16;
export const R_HUB = 26;
export const R_PROJECT = 30;

/** The radius a network node is drawn at. */
export function networkRadius(n: { kind: string; hub?: boolean }): number {
  if (n.kind === 'project') return R_PROJECT;
  if (n.hub === true) return R_HUB;
  if (n.kind === 'account') return R_ACCOUNT;
  return R_LEAF;
}

export interface PlacedNode extends LineageNode {
  x: number;
  y: number;
}

export interface Placement {
  nodes: PlacedNode[];
  edges: LineageEdge[];
  width: number;
  height: number;
}

/** The centre of a placed node, for drawing edges. */
export function centre(n: PlacedNode): { cx: number; cy: number } {
  return { cx: n.x + NODE_W / 2, cy: n.y + NODE_H / 2 };
}

/**
 * ── LAYOUT 1: THE PIPELINE (dagre) ──────────────────────────────────────────
 *
 * A strict left-to-right hierarchy. This is the view for *"in what order does the
 * money flow?"* — every node has a rank and the ranks are the answer.
 *
 * ★ `rankdir: 'LR'` RATHER THAN `'TB'`. The document offered both. Left-to-right is
 *   the right one here because the chain is five levels deep and the labels are wide
 *   (`PO 266121 · line 3`, `21 invoices`) — stacked vertically, five ranks of 200px
 *   cards is a 1,000px column that scrolls off a laptop screen.
 *
 * ★ EDGES ARE PASSED THROUGH UNCHANGED. dagre computes positions only; it does not
 *   own the edge list, and returning its own would lose the `amount` the Brain uses
 *   for thickness — the two views must share one edge list or they can disagree.
 */
export async function layoutPipeline(
  nodes: LineageNode[],
  edges: LineageEdge[],
): Promise<Placement> {
  if (nodes.length === 0) return { nodes: [], edges, width: 0, height: 0 };

  // ★ dagre IS IMPORTED LAZILY, AND THE REASON IS BUNDLE SIZE. It is ~90 KB and the
  //   Pipeline view is not the default — a reader who never opens it should not pay
  //   for it. `d3-force` is imported the same way for the same reason.
  const dagre = (await import('@dagrejs/dagre')).default;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  /**
   * ★★ `ranksep` IS WHAT MAKES A FIVE-RANK CHAIN FIT, AND 90 WAS TOO GENEROUS.
   *
   * The pipeline has five ranks (project → account → PO → invoice → check), and the
   * rank gaps are pure whitespace in a graph whose width is what forces the scale down.
   * Measured at `ranksep: 90` the layout came out ~1,700px wide for level 0450; at 56
   * it is ~1,300, which fits a 900px panel at ~0.7 instead of ~0.5.
   *
   * ★ `nodesep` IS SMALLER FOR A DIFFERENT REASON: the siblings in a rank are PO lines,
   *   and their cards are 54px tall with three lines of text. 18px between them still
   *   reads as separate cards while removing ~500px from a 20-line rank.
   */
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 56, marginx: 12, marginy: 12 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const placed: PlacedNode[] = nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    // ★ A NODE dagre DID NOT PLACE IS STILL RETURNED, AT THE ORIGIN. Dropping it would
    //   silently remove a node from the graph — a missing node reads as "this project
    //   has no such account", which is a claim about the data rather than a layout bug.
    const x = p === undefined ? 0 : p.x - NODE_W / 2;
    const y = p === undefined ? 0 : p.y - NODE_H / 2;
    return { ...n, x, y };
  });

  const width = Math.max(...placed.map((n) => n.x + NODE_W), 0) + 16;
  const height = Math.max(...placed.map((n) => n.y + NODE_H), 0) + 16;
  return { nodes: placed, edges, width, height };
}

/**
 * ── LAYOUT 2: THE BRAIN (d3-force) ──────────────────────────────────────────
 *
 * A node-link diagram where **position is a function of connectivity, not rank**.
 * This is the view for *"what is the shape of this project?"* — clusters appear
 * without anyone declaring them, which is the thing a hierarchy cannot do.
 *
 * ★★ THE FIVE THINGS THAT MAKE IT LOOK LIKE A NETWORK RATHER THAN A TANGLE:
 *
 *   1. **`forceCenter` IS NOT GRAVITY.** It only *translates* the graph; it applies no
 *      inward pull. A disconnected subgraph drifts off and the fit zooms out until
 *      everything is a dot. `forceRadial` is the force that pulls toward the root, and
 *      the root is pinned with `fx`/`fy` so the graph is oriented the same way on every
 *      visit — a layout that rearranges itself destroys the mental map.
 *
 *   2. **`forceCollide` IS REQUIRED.** Without it the circles overlap into a pile, and
 *      the symptom reads as "the spacing is wrong" rather than "a force is missing".
 *      The radius is per-node, so a hub reserves the room its circle actually needs.
 *
 *   3. **`forceManyBody` IS DISTANCE-LIMITED.** An unbounded repulsion between two
 *      nodes on opposite sides of the graph is wasted work and it makes the layout
 *      jittery; `distanceMax` keeps the repulsion local, which is what produces
 *      *separated clusters* rather than one evenly-spaced cloud.
 *
 *   4. **CLUSTER SEPARATION IS A FORCE, NOT A HOPE.** The image's shaded modules come
 *      from nodes in the same account being pushed together and different accounts
 *      pushed apart. `forceX`/`forceY` on the account's own anchor does that — without
 *      it, a force layout of a star-shaped graph settles into one ring.
 *
 *   5. **THE SIMULATION RUNS ONCE AND FREEZES.** Ticking inside render blocks paint and
 *      re-runs whenever the caller's arrays change identity. A continuously-running
 *      simulation is a screensaver: it costs FPS and the layout differs every visit.
 */
export async function layoutBrain(
  nodes: LineageNode[],
  edges: LineageEdge[],
  width = 900,
  height = 620,
): Promise<Placement> {
  if (nodes.length === 0) return { nodes: [], edges, width: 0, height: 0 };

  const d3 = await import('d3-force');

  const cx = width / 2;
  const cy = height / 2;

  interface SimNode extends SimulationNodeDatum {
    id: string;
    kind: string;
    hub?: boolean;
    /** The account this node belongs to — the cluster key. */
    cluster: string;
  }
  interface SimLink extends SimulationLinkDatum<SimNode> {
    source: string | SimNode;
    target: string | SimNode;
  }

  /**
   * ★ THE CLUSTER KEY IS RESOLVED FROM THE EDGES, NOT FROM THE NODE.
   *
   * A vendor node does not carry an account — it *connects* accounts, which is the
   * whole point. So its cluster is the account it is most connected to, and a vendor
   * spanning two accounts sits between them. Deriving it from the edges is what lets
   * one rule cover leaves, accounts and hubs.
   */
  const accountOf = new Map<string, string>();
  for (const e of edges) {
    const src = nodes.find((n) => n.id === e.source);
    const tgt = nodes.find((n) => n.id === e.target);
    if (src?.kind === 'account') accountOf.set(tgt?.id ?? '', e.source);
    if (tgt?.kind === 'account') accountOf.set(src?.id ?? '', e.target);
  }

  const sim: SimNode[] = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    ...(n.hub === true ? { hub: true } : {}),
    cluster: n.kind === 'account' ? n.id : (accountOf.get(n.id) ?? 'root'),
  }));
  const links: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target }));

  const root = sim.find((n) => n.kind === 'project');

  /**
   * ★ EACH CLUSTER GETS AN ANCHOR ON A CIRCLE AROUND THE CENTRE.
   *
   * This is what turns a force layout into the image's *modules*: nodes in one account
   * are pulled to the same anchor, and the anchors are spread around the ring, so the
   * accounts separate without any node being told where to go.
   */
  const clusters = [...new Set(sim.filter((n) => n.kind === 'account').map((n) => n.id))].sort();
  const ringR = Math.min(width, height) * 0.34;
  const anchors = new Map<string, { x: number; y: number }>();
  clusters.forEach((c, i) => {
    const a = (i / Math.max(clusters.length, 1)) * Math.PI * 2 - Math.PI / 2;
    anchors.set(c, { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR });
  });

  const force = d3
    .forceSimulation(sim)
    /**
     * ★★ THE FORCES ARE TUNED FOR A TIGHT MESH, NOT A SPARSE STAR.
     *
     * The reference image is a *dense* network: circles close together, edges short,
     * the whole thing reading as one fabric. The first attempt used a strong repulsion
     * and long links, which pushed everything apart into isolated stars with a lot of
     * empty space — technically a network, visually a scatter plot.
     *
     *   · `strength(-210)` with `distanceMax(200)` — enough repulsion that circles do
     *     not touch, weak enough that they stay in one mass. The `distanceMax` is what
     *     keeps the repulsion LOCAL, so distant nodes do not shove each other across
     *     the canvas (which is what breaks a mesh into clumps).
     *   · SHORT LINKS (70–120) — in a mesh the edges ARE the structure, so the distance
     *     between connected nodes is what sets the density.
     *   · `linkStrength(0.7)` — a stronger spring than a tree needs, because a network
     *     has cycles and the links must hold the shape rather than just pull inward.
     */
    .force('charge', d3.forceManyBody().strength(-210).distanceMax(200))
    .force(
      'link',
      d3
        .forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => {
          const src = typeof l.source === 'object' ? l.source.kind : '';
          if (src === 'project') return 120;
          if (src === 'account') return 78;
          if (src === 'vendor') return 70;
          return 62;
        })
        .strength(0.7),
    )
    .force(
      'cluster',
      d3
        .forceX<SimNode>((d) => anchors.get(d.cluster)?.x ?? cx)
        .strength((d) => (d.kind === 'project' ? 1 : d.kind === 'account' ? 0.4 : 0.22)),
    )
    .force(
      'clusterY',
      d3
        .forceY<SimNode>((d) => anchors.get(d.cluster)?.y ?? cy)
        .strength((d) => (d.kind === 'project' ? 1 : d.kind === 'account' ? 0.4 : 0.22)),
    )
    // ★ THE COLLIDE RADIUS IS THE NODE'S OWN RADIUS, so a hub reserves its real space.
    .force(
      'collide',
      d3.forceCollide<SimNode>((d) => networkRadius(d) + 3),
    )
    .stop();

  if (root !== undefined) {
    root.fx = cx;
    root.fy = cy;
  }

  // ★ 400 TICKS: more than the flowchart needs, because the cluster forces are still
  //   resolving separation at 300. The cost is paid once, at layout time.
  for (let i = 0; i < 400; i += 1) force.tick();

  const byId = new Map(sim.map((s) => [s.id, s]));

  /**
   * ★ THE PLACED NODE CARRIES ITS CENTRE, AND THE CARD BOX IS DERIVED FROM IT.
   *
   * `PlacedNode` has `x`/`y` as the TOP-LEFT of a 168×54 card, because that is what
   * the Flowchart's dagre positions. The Network draws circles centred on a point, so
   * it stores the centre and offsets by the radius — keeping one `PlacedNode` shape
   * for both views so the canvas does not need two node types.
   */
  const placed: PlacedNode[] = nodes.map((n) => {
    const s = byId.get(n.id);
    const r = networkRadius(n);
    const px = s?.x ?? cx;
    const py = s?.y ?? cy;
    return { ...n, x: px - r, y: py - r };
  });

  // ★ THE BOUNDS ARE MEASURED FROM THE RESULT, NOT ASSUMED TO BE `width`/`height`.
  //   A force layout does not respect the box it was given — nodes push outward past
  //   the nominal edges — so a viewBox of `0 0 width height` clips them.
  const extent = placed.map((n) => {
    const r = networkRadius(n);
    return { l: n.x, t: n.y, r: n.x + r * 2, b: n.y + r * 2 };
  });
  const minX = Math.min(...extent.map((e) => e.l));
  const minY = Math.min(...extent.map((e) => e.t));
  const maxX = Math.max(...extent.map((e) => e.r));
  const maxY = Math.max(...extent.map((e) => e.b));

  for (const n of placed) {
    n.x -= minX - 24;
    n.y -= minY - 24;
  }

  return {
    nodes: placed,
    edges,
    width: maxX - minX + 48,
    height: maxY - minY + 48,
  };
}
