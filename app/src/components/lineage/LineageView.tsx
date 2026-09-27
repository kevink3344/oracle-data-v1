import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ExtractLine, Project } from '../../data/types';
import {
  buildLineage,
  buildNetwork,
  indexLinks,
  loadLineageLinks,
  INVOICE_CHAINS_DRAWN,
  PO_LINES_PER_ACCOUNT,
  type LineageGraph,
  type LineageNode,
} from '../../data/lineage';
import { buildSunburstTree, type SunburstTree } from '../../data/sunburst';
import { money0, num, pct, pluralise } from '../../data/format';
import LineageCanvas from './LineageCanvas';

const LineageNetwork = lazy(() => import('./LineageNetwork'));
const LineageSunburst = lazy(() => import('./LineageSunburst'));
const LineageIcicle = lazy(() => import('./LineageIcicle'));

/**
 * The lineage view — the Flowchart, Network and Burst modes, over one project.
 *
 * ── ★★ ONE GRAPH, TWO LAYOUTS, AND THE DIFFERENCE IS THE QUESTION ───────────
 *
 *   · **Flowchart** (dagre) — *"in what order does the money flow?"* A strict
 *     left-to-right hierarchy. Good for tracing one order to its invoices.
 *   · **Network** (d3-force) — *"what is the shape of this project?"* Position is a
 *     function of connectivity rather than rank, so clusters appear without being
 *     declared.
 *
 *   · **Burst** (a d3-hierarchy partition) — *"where did the money go, and how far did
 *     it get?"* Five rings, Project → Account → PO line → Invoice → Check, where each
 *     ring measures a different thing. The reason it exists is ring 4: the share of a
 *     line its invoices actually reached, so the empty part of that ring is the finding
 *     rather than a rendering gap.
 *
 * ★ NONE OF THE THREE CAN DISAGREE ABOUT WHAT THE PROJECT CONTAINS. The first two read
 *   the same `LineageGraph`; the Burst reads the same `indexLinks(links)` map that both
 *   are built from. Only the arrangement differs — and where the drawing *is* narrowed
 *   (the Network's per-account cap) the Burst's legend names the number, because two
 *   views showing different counts with no explanation reads as a bug in one of them.
 *
 * ── ★ THE INVOICE LINK IS FETCHED, AND ITS ABSENCE IS STATED ─────────────────
 *
 * The extract has no invoice columns, so the graph's last two levels come from
 * `/api/ap/project-lineage`. That read can fail, and when it does the graph is still
 * valid — it just stops at the PO line. The view says so, because a chain that ends
 * for no visible reason reads as "this project has no invoices", which would be a
 * claim about the data rather than about the request.
 */

/**
 * ★ FOUR MODES, ONLY TWO OF WHICH THE FLOWCHART/NETWORK CANVAS CAN DRAW.
 *
 * `LineageCanvas` keeps its own narrow two-value `ViewMode` — it has no sunburst
 * geometry and should not be handed a mode it cannot render — so this wider union
 * belongs to the view, and the page's `?view=` value maps onto it. The route token is
 * `burst` (nothing in the URL should say "sunburst"); the internal mode is named after
 * the component and the data module it draws.
 *
 * ★ `sunburst` AND `icicle` ARE NOT TWO VIEWS OF TWO TREES — they are one tree read two
 *   ways, and every reader below that treats them alike does so precisely so the disc and
 *   the rows cannot disagree. The only thing that separates them is which axis of
 *   `d3.partition()`'s output the renderer scales onto the screen.
 */
export type LineageMode = 'pipeline' | 'brain' | 'sunburst' | 'icicle';

interface Props {
  project: Project;
  lines: ExtractLine[];
  mode: LineageMode;
}

export default function LineageView({ project, lines, mode }: Props) {
  const [links, setLinks] = useState<Awaited<ReturnType<typeof loadLineageLinks>>>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<LineageNode | null>(null);

  /**
   * ★ THE LINK IS FETCHED ONCE PER PROJECT, NOT PER VIEW SWITCH.
   *
   * A reader toggling between Flowchart and Network is asking about the same project,
   * so re-fetching on every toggle would be a request per click for an answer that
   * cannot have changed. The dependency is the level alone.
   */
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLinks(null);
    void loadLineageLinks(project.level).then((r) => {
      if (cancelled) return;
      setLinks(r);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [project.level]);

  // ★ THE SELECTION IS CLEARED WHEN THE PROJECT CHANGES. A node id from the previous
  //   project would not resolve in the new graph, so the detail panel would render a
  //   stale entity beside a different project's chart.
  useEffect(() => {
    setSelected(null);
  }, [project.level, mode]);

  /**
   * ★★ THE TWO VIEWS BUILD DIFFERENT GRAPHS, AND THAT IS THE POINT.
   *
   * They are not one graph drawn two ways. The Flowchart traces a *chain* — project →
   * account → PO line → invoice → check — so it is a tree, and a tree laid out with
   * springs is still a tree. The Network is about *who is connected to whom*, so it
   * promotes the **vendor** to a node: a vendor working under two accounts ties those
   * accounts together, which is what produces the modules and hubs of a real network.
   *
   * ★ THEY STILL SHARE THE NODE AND EDGE TYPES, the colour key and the disclosures —
   *   so the two views cannot disagree about what the project contains, only about how
   *   to arrange it.
   *
   * ★ THE BURST AND THE ICICLE ARE NEITHER, AND THEY ARE BUILT ONLY WHEN ASKED FOR. They
   *   want neither `buildNetwork` nor `buildLineage` — they are a second question, not a
   *   second arrangement — so this memo returns `null` for them rather than running a
   *   layout whose result would be discarded. Every reader below therefore guards on
   *   `graph !== null`, which is also why the legend's cap disclosure can no longer fire
   *   in a mode that hides nothing.
   *
   * ★ `mode === 'icicle'` IS TESTED HERE, IN THE SAME EXPRESSION, AND THAT IS DELIBERATE:
   *   the two rectangular/disc readings must be built from the identical sources, so any
   *   future change that makes one of them skip a graph build cannot silently reach only
   *   one of the two arms.
   */
  const graph: LineageGraph | null = useMemo(
    () =>
      mode === 'sunburst' || mode === 'icicle'
        ? null
        : mode === 'brain'
          ? buildNetwork(project, lines, indexLinks(links))
          : buildLineage(project, lines, indexLinks(links)),
    [project, lines, links, mode],
  );

  /**
   * ★ THE TREE IS BUILT HERE, NOT INSIDE THE LAZY COMPONENTS, so the legend below can name
   *   the ring totals and the line count before the chunk has arrived — a legend that waits
   *   for a code-split module would be blank on first paint and then jump.
   *
   * ★★ ONE TREE, TWO READINGS. The Burst and the Icicle are handed the SAME object, so they
   *   cannot disagree about a node's measure, its label, its account colour, the per-level
   *   totals or the disclosure paragraph — only about which axis the measure is drawn on.
   *   A second `buildSunburstTree` call for the icicle would compile, render, and look
   *   right, while quietly permitting exactly that disagreement.
   *
   * ★ IT CONSUMES THE SAME `indexLinks(links)` MAP the other two are built from, so neither
   *   reading can disagree with the network beside it about which line carries an invoice.
   *   Only the arrangement differs.
   */
  const tree: SunburstTree | null = useMemo(
    () =>
      mode === 'sunburst' || mode === 'icicle'
        ? buildSunburstTree(project, lines, indexLinks(links))
        : null,
    [project, lines, links, mode],
  );

  const accounts = useMemo(() => project.accounts.map((a) => a.object), [project.accounts]);

  const invoiceNodes =
    graph === null ? 0 : graph.nodes.filter((n) => n.kind === 'invoice').length;
  const checkNodes = graph === null ? 0 : graph.nodes.filter((n) => n.kind === 'check').length;

  return (
    <div className="lin">
      {mode === 'sunburst' && tree !== null ? (
        <Suspense
          fallback={
            <div className="lin__canvas" aria-label="Loading the project burst">
              <p className="lin__busy">Loading the project burst…</p>
            </div>
          }
        >
          <LineageSunburst
            tree={tree}
            accounts={accounts}
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
          />
        </Suspense>
      ) : mode === 'icicle' && tree !== null ? (
        <Suspense
          fallback={
            <div className="lin__canvas" aria-label="Loading the project icicle">
              <p className="lin__busy">Loading the project icicle…</p>
            </div>
          }
        >
          <LineageIcicle
            tree={tree}
            accounts={accounts}
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
          />
        </Suspense>
      ) : mode === 'brain' && graph !== null ? (
        <Suspense
          fallback={
            <div className="lin__canvas" aria-label="Loading project network">
              <p className="lin__busy">Loading project network…</p>
            </div>
          }
        >
          <LineageNetwork
            graph={graph}
            accounts={accounts}
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
          />
        </Suspense>
      ) : mode !== 'sunburst' && mode !== 'icicle' && graph !== null ? (
        // ★ THE TWO EXCLUSIONS ARE NOT REDUNDANT — together they are what lets the compiler
        //   narrow `mode` to the two values `LineageCanvas` actually draws, so the flowchart
        //   cannot be handed a mode it has no geometry for. Drop either one and `mode`
        //   widens back to the full union and this stops compiling, which is the point: the
        //   guard is the compile-time half of "one component, two readings".
        <LineageCanvas
          graph={graph}
          mode={mode}
          accounts={accounts}
          onSelect={setSelected}
          selectedId={selected?.id ?? null}
        />
      ) : null}

      <div className="lin__legend">
        <span className="lin__key">
          <span className="lin__swatch" style={{ background: '#1f2937' }} />
          Project
        </span>
        {project.accounts.map((a, i) => (
          <span className="lin__key" key={a.object}>
            <span
              className="lin__swatch"
              style={{ background: ['#165788', '#7a3f9d', '#b5651d', '#1c7a52', '#a8324a', '#4a6fa5'][i % 6] }}
            />
            {a.object}
          </span>
        ))}
        {/*
          ★ THE LEGEND FOLLOWS THE VIEW, BECAUSE THE VIEWS HAVE DIFFERENT NODES.
          The Flowchart draws PO lines; the Network draws vendors instead (it is a
          relation diagram, and a vendor is the thing that relates). A fixed legend
          would name a node kind that is not on screen — which is worse than no legend.
        */}
        {mode === 'sunburst' || mode === 'icicle' ? (
          <>
            <span className="lin__key lin__key--note">
              the swatches colour the whole chart — position says which level (what the
              money is), colour says whose account it is
            </span>
            {/*
              ★★ THE LEVEL KEY COMES FROM THE DATA, NOT FROM THIS FILE. Each level's wording
              is authored once in `sunburst.ts` beside the measure it describes, so a level
              that changes what it measures cannot leave a hand-written key here naming the
              old meaning — and the key cannot drift out of step with the level totals the
              bar above prints, because both read the same object. Both readings of the
              tree print this identical list.
            */}
            {tree !== null ? (
              <ol className="lin__rings">
                {tree.rings.map((ring, i) => (
                  <li className="lin__ring" key={ring.depth}>
                    <span className="lin__ringnum">{i + 1}</span>
                    <span className="lin__ringbody">
                      <strong>{ring.title}</strong> · {ring.unit}
                      <em>{ring.denominator}</em>                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            {/*
              ★ THE OTHER VIEW'S CAP IS NAMED HERE, IN NUMBERS READ FROM THE CONSTANT.
              The burst draws every PO line and the Network draws only a few per account,
              so a reader who switches tabs sees different counts for the same project.
              Both numbers are derived — the line count from the tree, the cap from
              `PO_LINES_PER_ACCOUNT` — so neither can silently drift out of step with what
              is actually drawn.
            */}
            {tree !== null ? (
              <span className="lin__key lin__key--note">
                all {num(tree.meta.lineCount)} PO lines are drawn here — the network view
                draws only the {num(PO_LINES_PER_ACCOUNT)} largest on each account
              </span>
            ) : null}
          </>
        ) : mode === 'brain' ? (
          <>
            <span className="lin__key">
              <span className="lin__swatch lin__swatch--dot" style={{ background: '#6b7280' }} />
              Vendor
            </span>
            <span className="lin__key">
              <span className="lin__swatch lin__swatch--dot" style={{ background: '#1c7a52' }} />
              Invoice
            </span>
            <span className="lin__key">
              <span className="lin__swatch lin__swatch--dot" style={{ background: '#4a6fa5' }} />
              Check
            </span>
            <span className="lin__key lin__key--note">
              a ringed circle is a hub — a vendor working under more than one account
            </span>
          </>
        ) : (
          <>
            <span className="lin__key">
              <span className="lin__swatch" style={{ background: '#b5651d' }} />
              PO line
            </span>
            <span className="lin__key">
              <span className="lin__swatch" style={{ background: '#1c7a52' }} />
              Invoice
            </span>
            <span className="lin__key">
              <span className="lin__swatch" style={{ background: '#4a6fa5' }} />
              Check
            </span>
          </>
        )}

        {/* ★ THE DISCLOSURE IS INLINE AND ALWAYS VISIBLE WHEN IT APPLIES. A graph that
            drops nodes must say so where the reader is looking. It is impossible in the
            burst — which draws every line — so it is gated on a graph existing at all,
            rather than on a count that would be a meaningless 0 there. */}
        {graph !== null && graph.hidden.poLines > 0 ? (
          <span className="lin__hidden">
            {num(graph.hidden.poLines)} smaller PO line
            {graph.hidden.poLines === 1 ? '' : 's'} not drawn
          </span>
        ) : null}
      </div>
      {/*
        ★ THE INVOICE LINK'S STATE IS STATED, IN ALL THREE CASES.

        `loaded === false` is "still reading". A `null` result is "the read failed",
        which is different from "there are none" — and the difference matters, because
        the graph looks the same either way. Saying which it is costs one sentence and
        removes a whole class of "why does this project have no invoices" confusion.
      */}
      {!loaded ? (
        <p className="lin__detail">
          <span>Reading the invoice and check links…</span>
        </p>
      ) : links === null ? (
        <p className="lin__detail">
          <span>
            <strong>The invoice and check links could not be read.</strong>{' '}
            {mode === 'sunburst' || mode === 'icicle'
              ? 'This view stops at the purchase-order line — the invoice and check levels are missing because the request failed, not because this project has no invoices.'
              : 'The graph stops at the purchase-order line — that is a failed request, not a project without invoices.'}
          </span>
        </p>
      ) : (mode === 'sunburst' || mode === 'icicle') && tree !== null ? (
        /*
          ★★ THE BURST'S AND THE ICICLE'S OWN DISCLOSURE, AND IT IS THE POINT OF THE VIEW.

          Levels 1–3 are a partition of the committed total, so they always add up to it.
          Level 4 is NOT part of that identity: it is the share of each line an invoice
          actually reached, which here is a median of about 94% and as little as 2.7% on
          one line. Stating the two totals is what turns a visibly gappy level from "this
          looks broken" into "this is the answer" — and it is measured from the tree, not
          restated from the page's headline.

          ★ SHARED VERBATIM BETWEEN THE TWO READINGS, which is why its nouns name no shape:
            a sentence that said "arcs" would be false on the icicle and one that said
            "cells" would be false on the disc.
        */
        <p className="lin__detail">
          <span>
            {num(tree.meta.linkedLines)} of {num(tree.meta.lineCount)} PO lines carry an
            invoice, and those invoices reached {money0(tree.meta.covered)} of the{' '}
            {money0(tree.meta.lineAmount)} on the lines —{' '}
            {pct(tree.meta.lineAmount > 0 ? tree.meta.covered / tree.meta.lineAmount : 0)}
            {tree.meta.unlinkedLines > 0 ? (
              <>
                {' '}
                · {num(tree.meta.unlinkedLines)}{' '}
                {pluralise(tree.meta.unlinkedLines, 'line')} carry no invoice at all (
                {money0(tree.meta.unlinkedAmount)})
              </>
            ) : null}
            {tree.meta.overLines.length > 0 ? (
              <>
                {' '}
                · {num(tree.meta.overLines.length)}{' '}
                {pluralise(tree.meta.overLines.length, 'line')} name more than the line's
                amount, so those are drawn full and marked
              </>
            ) : null}
            {tree.meta.orphanLinks > 0 ? (
              <>
                {' '}
                · {num(tree.meta.orphanLinks)}{' '}
                {pluralise(tree.meta.orphanLinks, 'invoice link')} name a PO line this
                project does not have
              </>
            ) : null}
            {' '}
            · the invoice level is a share of its own line, so it is rarely full — the gap
            is the finding, not a rendering fault.
          </span>
        </p>
      ) : graph !== null ? (
        <p className="lin__detail">
          <span>
            {num(links.coverage.linked)} of {num(links.coverage.poLines)} PO lines carry an invoice ·{' '}
            {num(invoiceNodes)} invoice node{invoiceNodes === 1 ? '' : 's'} ·{' '}
            {num(checkNodes)} check node{checkNodes === 1 ? '' : 's'}
            {links.coverage.poLines > links.coverage.linked ? (
              <>
                {' '}
                — the other {num(links.coverage.poLines - links.coverage.linked)} name no order
                (prepaid cards, use tax, standing charges)
              </>
            ) : null}
            {/*
              ★ THE COLLAPSED CHAINS ARE STATED, BECAUSE THE NODES LOOK ABSENT OTHERWISE.

              A reader who sees four invoice nodes and sixteen PO lines could conclude
              twelve lines have no invoices. They do have them — the counts are on the
              PO nodes' subtitles — but the chain is only drawn for the largest lines.
              Saying so is the difference between a disclosure and a misleading picture.
            */}
            {graph.hidden.invoiceChains > 0 ? (
              <>
                {' '}
                · the invoice→check chain is drawn for the {num(INVOICE_CHAINS_DRAWN)} largest linked
                lines; the other {num(graph.hidden.invoiceChains)} carry their counts on the PO node
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {selected !== null ? (
        <div className="lin__detail">
          <div>
            <h3>{selected.label}</h3>
            <p>{selected.subtitle}</p>
          </div>
          {/*
            ★★ A RING-5 TICK HAS NO MONEY, AND THE PANEL MUST NOT INVENT ONE.

            `LineageLink` carries how many checks there are, not an amount per check — the
            aggregate is all this path knows. So a check node's `amount` is deliberately
            0, and printing `$0.00` beside "one of 65 checks" would state a figure nothing
            measured. `unit` is set only by the burst, so for the Flowchart and the
            Network this branch cannot fire and their panel output is unchanged.
          */}
          {selected.unit?.kind === 'count' ? (
            <dl className="lin__detailrow">
              <dt>{selected.kind}</dt>
              <dd>
                {num(selected.lines)} {selected.unit.label}
              </dd>
            </dl>
          ) : (
            <dl className="lin__detailrow">
              <dt>{selected.kind === 'po' ? 'PO line' : selected.kind}</dt>
              <dd>{money0(selected.amount)}</dd>
            </dl>
          )}
          {selected.unit?.kind !== 'count' && selected.lines > 1 ? (
            <dl className="lin__detailrow">
              <dt>Count</dt>
              <dd>{num(selected.lines)}</dd>
            </dl>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(null)}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
