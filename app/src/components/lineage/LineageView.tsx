import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ExtractLine, Project } from '../../data/types';
import {
  buildLineage,
  buildNetwork,
  indexLinks,
  loadLineageLinks,
  INVOICE_CHAINS_DRAWN,
  type LineageGraph,
  type LineageNode,
} from '../../data/lineage';
import { money0, num } from '../../data/format';
import LineageCanvas, { type ViewMode } from './LineageCanvas';

const LineageNetwork = lazy(() => import('./LineageNetwork'));

/**
 * The lineage view — the Flowchart and Network modes, over one graph.
 *
 * ── ★★ ONE GRAPH, TWO LAYOUTS, AND THE DIFFERENCE IS THE QUESTION ───────────
 *
 *   · **Flowchart** (dagre) — *"in what order does the money flow?"* A strict
 *     left-to-right hierarchy. Good for tracing one order to its invoices.
 *   · **Network** (d3-force) — *"what is the shape of this project?"* Position is a
 *     function of connectivity rather than rank, so clusters appear without being
 *     declared.
 *
 * Both read the same `LineageGraph`, so they cannot disagree about what the project
 * contains. Only the layout function differs.
 *
 * ── ★ THE INVOICE LINK IS FETCHED, AND ITS ABSENCE IS STATED ─────────────────
 *
 * The extract has no invoice columns, so the graph's last two levels come from
 * `/api/ap/project-lineage`. That read can fail, and when it does the graph is still
 * valid — it just stops at the PO line. The view says so, because a chain that ends
 * for no visible reason reads as "this project has no invoices", which would be a
 * claim about the data rather than about the request.
 */

interface Props {
  project: Project;
  lines: ExtractLine[];
  mode: ViewMode;
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
   */
  const graph: LineageGraph = useMemo(
    () =>
      mode === 'brain'
        ? buildNetwork(project, lines, indexLinks(links))
        : buildLineage(project, lines, indexLinks(links)),
    [project, lines, links, mode],
  );

  const accounts = useMemo(() => project.accounts.map((a) => a.object), [project.accounts]);

  const invoiceNodes = graph.nodes.filter((n) => n.kind === 'invoice').length;
  const checkNodes = graph.nodes.filter((n) => n.kind === 'check').length;

  return (
    <div className="lin">
      {mode === 'brain' ? (
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
      ) : (
        <LineageCanvas
          graph={graph}
          mode={mode}
          accounts={accounts}
          onSelect={setSelected}
          selectedId={selected?.id ?? null}
        />
      )}

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
        {mode === 'brain' ? (
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
            drops nodes must say so where the reader is looking. */}
        {graph.hidden.poLines > 0 ? (
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
            <strong>The invoice and check links could not be read.</strong> The graph stops at the
            purchase-order line — that is a failed request, not a project without invoices.
          </span>
        </p>
      ) : (
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
      )}

      {selected !== null ? (
        <div className="lin__detail">
          <div>
            <h3>{selected.label}</h3>
            <p>{selected.subtitle}</p>
          </div>
          <dl className="lin__detailrow">
            <dt>{selected.kind === 'po' ? 'PO line' : selected.kind}</dt>
            <dd>{money0(selected.amount)}</dd>
          </dl>
          {selected.lines > 1 ? (
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
