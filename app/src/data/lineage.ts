import type { ExtractLine, Project } from './types';
import { sqlUrl } from './sqlTrace';

/**
 * The lineage graph for one project — the payload both the Flowchart and the Brain read.
 *
 * ── ★★ ONE PAYLOAD, TWO VIEWS, AND THAT IS THE POINT ────────────────────────
 *
 * The two views answer different questions over the *same* nodes and edges:
 *
 *   · **Flowchart** — "in what order does the money flow?" A strict left-to-right
 *     chain. Good for tracing one order to its invoices.
 *   · **Brain** — "what is the shape of this project?" Position becomes a function
 *     of connectivity rather than rank, so clusters appear without being declared.
 *
 * They differ in *layout*, not in data. Building a second payload for the Brain is
 * how the two views start disagreeing about what a project contains.
 *
 * ── ★★ BUILT FROM THE ROWS THE PAGE ALREADY RENDERS ─────────────────────────
 *
 * `lines` is the store's own extract — the same array the tables and the cost-code
 * spine are computed from. Nothing here re-queries. So the graph cannot disagree
 * with the numbers printed beside it, which is the failure this codebase has been
 * bitten by more than once (a second query's idea of "the same" rows).
 *
 * ── ★ IDS ARE REAL KEYS, NEVER DISPLAY STRINGS ──────────────────────────────
 *
 * `po:273069:1` is `ORDER_NUMBER:LINE_NUMBER`; `account:0450:529` is `LEVEL:OBJECT`.
 * A display string is not an identity — the project's own `code` used to be
 * `CC-0450-527` and was read back as a key, which presented a level as bound to
 * one of its accounts. Every id here is either a key from the data or a prefix
 * plus keys from the data.
 */

export type LineageNodeKind = 'project' | 'account' | 'po' | 'invoice' | 'check' | 'vendor';

export interface LineageNode {
  /** A real key, e.g. `project:0450`, `account:0450:529`, `po:273069:1`. */
  id: string;
  kind: LineageNodeKind;
  /** The primary line — a project name, an account label, an order number. */
  label: string;
  /** The supporting line — a site, a vendor, a status. */
  subtitle: string;
  /** Σ money at this node. Meaning depends on `kind`; see `buildLineage`. */
  amount: number;
  /** How many extract rows this node stands for. 1 for a single PO line. */
  lines: number;
  /**
   * ★★ THE HUB FLAG — THE NODE THE NETWORK VIEW DRAWS BIGGER.
   *
   * The reference image distinguishes **nodes** from **hubs**: a hub is a node many
   * things connect through, drawn larger and named. In this data the hub is the
   * **vendor** — a vendor that works under several accounts is what ties those
   * accounts into a module, and without it the graph is a set of disconnected stars.
   *
   * ★ IT IS COMPUTED, NOT DECLARED. A node is a hub when its degree exceeds the
   *   graph's mean degree, so the flag follows the data rather than a hand-picked
   *   list that would be wrong for the next project.
   */
  hub?: boolean;
  /** How many distinct neighbours this node has — the degree the hub test reads. */
  degree?: number;
}

export interface LineageEdge {
  id: string;
  source: string;
  target: string;
  /** Σ money on this edge — the Brain draws it as thickness. */
  amount: number;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  /**
   * What was left out, and why — so a reader is never shown a silently reduced graph.
   *
   * ★ THE COUNTS ARE THE POINT. A graph that drops 20 of 30 nodes without saying so
   *   is the "filtered set presented as the whole" failure. When any of these is
   *   non-zero the view must print it.
   */
  hidden: {
    /** PO lines beyond the per-account cap. */
    poLines: number;
    /** Linked PO lines whose invoice→check chain was collapsed into their node's subtitle. */
    invoiceChains: number;
  };
}

/** One project's rows, grouped by the account they are booked to. */
interface AccountGroup {
  object: string;
  label: string;
  lines: ExtractLine[];
  amount: number;
}

/**
 * ★ THE PER-ACCOUNT PO-LINE CAP, AND WHY IT EXISTS.
 *
 * Measured: level 0450 has 20 PO lines across 4 accounts — which sounds comfortable
 * until the invoice and check levels are added, because **each linked PO line spawns
 * two more nodes**. Twenty lines becomes 20 + 16 invoices + 16 checks = 52 nodes and
 * 56 edges, in a panel about 630×477. The graph then fits at ~27% scale and every
 * label is unreadable — the view renders, and says nothing.
 *
 * ★ THE CAP IS ON WHAT IS DRAWN, NOT ON WHAT IS COUNTED. The dropped lines are always
 *   the SMALLEST, and `hidden.poLines` reports the count so the view can state it. A
 *   reader who needs the tail has the tables below; this view is for the shape.
 *
 * 6 keeps a four-account project near 30 nodes — legible at a glance — while still
 * showing each account's real composition.
 */
const PO_LINES_PER_ACCOUNT = 6;

/**
 * ★★ HOW MANY PO LINES GET THEIR FULL INVOICE→CHECK CHAIN, AND WHY IT IS NOT ALL OF THEM.
 *
 * The invoice and check levels are the most expensive thing in the graph: each linked
 * PO line adds **two** nodes and two edges, so they roughly double the node count and
 * triple the edge count. On level 0450 that is 16 lines × 2 = 32 extra nodes for a
 * chain that is structurally identical on every line — *"invoices, then checks"*.
 *
 * ★ SO THE CHAIN IS DRAWN FOR THE BIGGEST LINES ONLY, AND THE REST CARRY THEIR COUNTS.
 *   A PO node whose line has invoices already says nothing about them in its label, so
 *   the count is moved onto the node's subtitle (`N invoices · M checks`) and the chain
 *   is reserved for the lines where the detail is worth the space. What is drawn is
 *   decided by AMOUNT, so the lines a reader is most likely to ask about get the detail.
 *
 * ★ THIS IS A DISCLOSURE, NOT A SILENT TRUNCATION. `hidden.invoiceChains` counts the
 *   lines whose chain was collapsed, and the view states it. The counts are still on
 *   every node either way — nothing is lost, only unfolded.
 *
 * ★ EXPORTED SO THE VIEW CAN NAME THE NUMBER IN ITS DISCLOSURE. A sentence reading
 *   "the chain is drawn for the largest lines" without the count is vague; with it,
 *   the reader knows exactly how many are folded and can go looking for the rest.
 */
export const INVOICE_CHAINS_DRAWN = 4;

/** `04-6570-862-529-0450-0840-000` — the same key `ExtractLine.combinationKey` carries. */
function accountKey(level: string, object: string): string {
  return `account:${level}:${object}`;
}

/** `ORDER_NUMBER:LINE_NUMBER` — the PO line's identity, which is what an invoice names. */
export function poLineKey(orderNumber: string, lineNumber: string): string {
  return `po:${orderNumber}:${lineNumber}`;
}

/**
 * Build the graph for one project.
 *
 * ★ `invoicesByPoLine` IS OPTIONAL AND THAT IS DELIBERATE. The PO→invoice link lives in
 *   the mirror (`AP_INVOICE_LINES_ALL.PO_LINE_ID`), not in the extract, so a caller that
 *   has not fetched it still gets a valid graph — just one that stops at the PO line.
 *   The view says which it is rather than drawing a chain that ends for no visible reason.
 *
 *   Measured for level 0450: 20 PO lines, **16 of which carry invoices** (52 invoices,
 *   51 checks). The four without are the project's own orders that no invoice has
 *   reached yet — a real answer, not missing data.
 */
export function buildLineage(
  project: Project,
  lines: ExtractLine[],
  invoicesByPoLine?: Map<string, { invoices: number; checks: number; amount: number }>,
): LineageGraph {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const hidden = { poLines: 0, invoiceChains: 0 };

  const projectId = `project:${project.level}`;
  nodes.push({
    id: projectId,
    kind: 'project',
    label: project.name,
    subtitle: `${project.code} · ${project.site}`,
    amount: project.committed,
    lines: project.lines,
  });

  // ── Group the project's rows by account (OBJECT_), which is the level's real grain ──
  const byAccount = new Map<string, AccountGroup>();
  for (const line of lines) {
    if (line.level !== project.level) continue;
    let group = byAccount.get(line.object);
    if (group === undefined) {
      group = { object: line.object, label: '', lines: [], amount: 0 };
      byAccount.set(line.object, group);
    }
    group.lines.push(line);
    group.amount += line.amount;
  }

  // ★ THE LABEL COMES FROM THE PROJECT'S OWN ACCOUNTS ARRAY, NOT FROM A SECOND LOOKUP.
  //   `Project.accounts[].label` is already the taxonomy name ("529 · Testing, inspection
  //   & survey"), computed once for the page. Re-deriving it here would be a second
  //   definition that could drift from the one on screen.
  for (const account of project.accounts) {
    const group = byAccount.get(account.object);
    if (group !== undefined) group.label = account.label;
  }

  const accountIds = [...byAccount.keys()].sort();

  /**
   * ★★ THE DRAWN PO LINES ARE COLLECTED FIRST, THEN RANKED GLOBALLY.
   *
   * The invoice chain is drawn for the biggest lines *across the whole project*, not
   * the biggest per account. Ranking inside each account would spend the budget on
   * four small accounts' largest lines and skip a genuinely large one in a fifth —
   * and the reader's question ("where is the detail?") has no account in it.
   */
  interface Drawn {
    accountId: string;
    line: ExtractLine;
    poId: string;
  }
  const drawn: Drawn[] = [];

  for (const object of accountIds) {
    const group = byAccount.get(object)!;
    const accountId = accountKey(project.level, object);

    nodes.push({
      id: accountId,
      kind: 'account',
      label: group.label || object,
      subtitle: `${group.lines.length} line${group.lines.length === 1 ? '' : 's'}`,
      amount: group.amount,
      lines: group.lines.length,
    });
    edges.push({
      id: `e:${projectId}->${accountId}`,
      source: projectId,
      target: accountId,
      amount: group.amount,
    });

    // ── PO lines, biggest first, capped ──────────────────────────────────────
    const sorted = [...group.lines].sort((a, b) => b.amount - a.amount);
    if (sorted.length > PO_LINES_PER_ACCOUNT) {
      hidden.poLines += sorted.length - PO_LINES_PER_ACCOUNT;
    }
    for (const line of sorted.slice(0, PO_LINES_PER_ACCOUNT)) {
      drawn.push({ accountId, line, poId: poLineKey(line.orderNumber, line.lineNumber) });
    }
  }

  /**
   * ★ THE CHAIN BUDGET GOES TO THE LARGEST LINES, AND ONLY THOSE THAT HAVE ONE.
   *
   * A line with no invoice cannot have a chain drawn, so it must not consume the
   * budget — otherwise a project whose biggest lines are unlinked would draw no chains
   * at all while smaller linked lines went without. The filter comes first, then the
   * ranking.
   */
  const chainIds = new Set(
    drawn
      .filter((d) => (invoicesByPoLine?.get(d.poId)?.invoices ?? 0) > 0)
      .sort((a, b) => b.line.amount - a.line.amount)
      .slice(0, INVOICE_CHAINS_DRAWN)
      .map((d) => d.poId),
  );

  for (const { accountId, line, poId } of drawn) {
    const link = invoicesByPoLine?.get(poId);
    const hasChain = chainIds.has(poId);

    /**
     * ★ THE PO NODE CARRIES THE COUNTS WHEN ITS CHAIN IS NOT DRAWN.
     *
     * Without this the collapsed lines would look like lines with no invoices — the
     * graph would be *less* informative than the data. The subtitle is where the count
     * goes, so a reader sees `21 invoices · 20 checks` on the node itself.
     */
    const subtitle =
      link !== undefined && link.invoices > 0 && !hasChain
        ? `${link.invoices} inv · ${link.checks} chk`
        : line.vendor || '—';

    nodes.push({
      id: poId,
      kind: 'po',
      label: `PO ${line.orderNumber} · line ${line.lineNumber}`,
      subtitle,
      amount: line.amount,
      lines: 1,
    });
    edges.push({
      id: `e:${accountId}->${poId}`,
      source: accountId,
      target: poId,
      amount: line.amount,
    });

    if (link === undefined || link.invoices === 0) continue;

    // ── The invoice node, COLLAPSED PER PO LINE ──────────────────────────────
    //
    // ★★ ONE NODE PER PO LINE, NOT ONE PER INVOICE, AND THE MEASUREMENT IS WHY.
    //
    //   Invoices fan out hard: measured on level 0450, one PO line carries **21
    //   invoices** and several carry 8. Drawing each as its own node makes a single
    //   line dominate the view — the graph stops showing the project and starts
    //   showing one order's payment history.
    //
    //   So the invoices of a line are one node carrying their COUNT, and the count
    //   is the information (a line with 21 invoices is a different fact from a line
    //   with 1).
    if (!hasChain) {
      hidden.invoiceChains += 1;
      continue;
    }

    const invId = `invoice:${poId}`;
    nodes.push({
      id: invId,
      kind: 'invoice',
      label: `${link.invoices} invoice${link.invoices === 1 ? '' : 's'}`,
      subtitle: 'settled against this line',
      amount: link.amount,
      lines: link.invoices,
    });
    edges.push({
      id: `e:${poId}->${invId}`,
      source: poId,
      target: invId,
      amount: link.amount,
    });

    if (link.checks > 0) {
      const chkId = `check:${poId}`;
      nodes.push({
        id: chkId,
        kind: 'check',
        label: `${link.checks} check${link.checks === 1 ? '' : 's'}`,
        subtitle: 'paid',
        amount: link.amount,
        lines: link.checks,
      });
      edges.push({
        id: `e:${invId}->${chkId}`,
        source: invId,
        target: chkId,
        amount: link.amount,
      });
    }
  }

  return { nodes, edges, hidden };
}

/**
 * ★★ THE NETWORK GRAPH — A DIFFERENT SHAPE FROM THE FLOWCHART, ON PURPOSE.
 *
 * The reference image is a **network**: shaded modules, hub nodes drawn larger, and
 * edges as the primary structure. A force layout over the *flowchart's* nodes cannot
 * produce that, because the flowchart's edges all run one way (project → account →
 * PO → …) — it is a tree, and a tree laid out with springs is still a tree. That is
 * why the first Network view looked like the Flowchart with looser spacing.
 *
 * ── WHAT MAKES THE STRUCTURE APPEAR: THE VENDOR LAYER ───────────────────────
 *
 * A **vendor** is the one entity in this data that connects *sideways*. A vendor
 * working under two accounts ties those accounts together; a vendor working under
 * five becomes a hub. So the network is built on **account ↔ vendor** edges:
 *
 *     [Account 526] ── VENDOR A ── [Account 529]
 *                          │
 *                     [Account 532]
 *
 * Repeating vendors are drawn **once** and connect every account they work under.
 * That single node is the whole point: in the Flowchart the vendor appears once per
 * PO line and the sharing is invisible; here it is the structure.
 *
 * ── ★ THE HONEST LIMIT, MEASURED ────────────────────────────────────────────
 *
 * On level 0450 **no vendor spans two accounts** (4 accounts, 9 vendor-account links,
 * 6 of them on account 529). So this project's network is a set of stars joined only
 * at the project — which is a true picture of a small project, and the view says so
 * rather than implying the data is wrong. Fund-wide the same measurement finds vendors
 * spanning up to 6 accounts and 99 levels, so the structure is there to be found on
 * larger scopes.
 */
export function buildNetwork(
  project: Project,
  lines: ExtractLine[],
  invoicesByPoLine?: Map<string, { invoices: number; checks: number; amount: number }>,
): LineageGraph {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const hidden = { poLines: 0, invoiceChains: 0 };

  const projectId = `project:${project.level}`;
  nodes.push({
    id: projectId,
    kind: 'project',
    label: project.name,
    subtitle: `${project.code} · ${project.site}`,
    amount: project.committed,
    lines: project.lines,
  });

  // ── Group by account, then by vendor within the account ────────────────────
  const byAccount = new Map<string, ExtractLine[]>();
  for (const line of lines) {
    if (line.level !== project.level) continue;
    const arr = byAccount.get(line.object);
    if (arr === undefined) byAccount.set(line.object, [line]);
    else arr.push(line);
  }

  const accountLabel = new Map(project.accounts.map((a) => [a.object, a.label]));

  /** vendor name → the accounts it works under, and its total. */
  const vendorAccounts = new Map<string, { accounts: Set<string>; amount: number; lines: number }>();

  for (const object of [...byAccount.keys()].sort()) {
    const group = byAccount.get(object)!;
    const accountId = accountKey(project.level, object);
    const amount = group.reduce((s, l) => s + l.amount, 0);

    nodes.push({
      id: accountId,
      kind: 'account',
      label: accountLabel.get(object) || object,
      subtitle: `${group.length} line${group.length === 1 ? '' : 's'}`,
      amount,
      lines: group.length,
    });
    edges.push({
      id: `e:${projectId}->${accountId}`,
      source: projectId,
      target: accountId,
      amount,
    });

    // The PO lines are counted even when not drawn, so the disclosure is honest.
    const withVendor = group.filter((l) => l.vendor.trim() !== '');
    if (withVendor.length > PO_LINES_PER_ACCOUNT) {
      hidden.poLines += withVendor.length - PO_LINES_PER_ACCOUNT;
    }

    for (const line of [...withVendor].sort((a, b) => b.amount - a.amount).slice(0, PO_LINES_PER_ACCOUNT)) {
      const v = vendorAccounts.get(line.vendor);
      if (v === undefined) {
        vendorAccounts.set(line.vendor, { accounts: new Set([object]), amount: line.amount, lines: 1 });
      } else {
        v.accounts.add(object);
        v.amount += line.amount;
        v.lines += 1;
      }
    }
  }

  /**
   * ★★ THE VENDOR NODES, AND THE EDGE THAT MAKES THE NETWORK A NETWORK.
   *
   * An edge is drawn **per account the vendor works under**, so a vendor on three
   * accounts has three edges and sits between them. That is exactly the "hub" the
   * reference image shows, and it is a fact about the data rather than a layout trick.
   */
  for (const [name, v] of vendorAccounts) {
    const vendorId = `vendor:${name}`;
    const isHub = v.accounts.size > 1;

    nodes.push({
      id: vendorId,
      kind: 'vendor',
      label: name,
      subtitle:
        v.accounts.size > 1
          ? `${v.accounts.size} accounts · ${v.lines} lines`
          : `${v.lines} line${v.lines === 1 ? '' : 's'}`,
      amount: v.amount,
      lines: v.lines,
      hub: isHub,
    });

    for (const object of v.accounts) {
      const accountId = accountKey(project.level, object);
      edges.push({
        id: `e:${accountId}->${vendorId}`,
        source: accountId,
        target: vendorId,
        amount: v.amount,
      });
    }
  }

  /**
   * ── The invoice/check layer, attached to the VENDOR ────────────────────────
   *
   * ★ IT HANGS OFF THE VENDOR, NOT THE PO LINE, AND THAT IS THE DIFFERENCE BETWEEN
   *   THE TWO VIEWS. The Flowchart traces one line to its invoices, so it attaches
   *   there. The Network is about who is connected to whom, and an invoice is a
   *   payment *to a vendor* — so the counts aggregate onto the vendor node, which is
   *   also what keeps the network from tripling in size.
   */
  let chains = 0;
  for (const [name, v] of vendorAccounts) {
    let invoices = 0;
    let checks = 0;
    let amount = 0;
    for (const object of v.accounts) {
      for (const line of byAccount.get(object) ?? []) {
        if (line.vendor !== name) continue;
        const link = invoicesByPoLine?.get(poLineKey(line.orderNumber, line.lineNumber));
        if (link === undefined) continue;
        invoices += link.invoices;
        checks += link.checks;
        amount += link.amount;
      }
    }
    if (invoices === 0) continue;
    chains += 1;

    const vendorId = `vendor:${name}`;
    const invId = `invoice:${vendorId}`;
    nodes.push({
      id: invId,
      kind: 'invoice',
      label: `${invoices} invoice${invoices === 1 ? '' : 's'}`,
      subtitle: 'to this vendor',
      amount,
      lines: invoices,
    });
    edges.push({ id: `e:${vendorId}->${invId}`, source: vendorId, target: invId, amount });

    if (checks > 0) {
      const chkId = `check:${vendorId}`;
      nodes.push({
        id: chkId,
        kind: 'check',
        label: `${checks} check${checks === 1 ? '' : 's'}`,
        subtitle: 'paid',
        amount,
        lines: checks,
      });
      edges.push({ id: `e:${invId}->${chkId}`, source: invId, target: chkId, amount });
    }
  }

  markHubs(nodes, edges);
  return { nodes, edges, hidden };
}

/**
 * Flag the nodes whose degree exceeds the graph's mean — the "hubs" of the image.
 *
 * ★ COMPUTED FROM THE GRAPH, NOT FROM A LIST. A hand-written rule ("a vendor on more
 *   than 2 accounts is a hub") would be wrong for the next project, and it would need
 *   re-tuning every time the data changed. The mean degree is a property of the graph
 *   in hand, so the flag moves with it.
 *
 * ★ THE MEAN IS OVER NON-PROJECT NODES. The project connects to every account by
 *   construction, so including it would drag the mean up and no vendor would ever
 *   qualify on a small project.
 */
function markHubs(nodes: LineageNode[], edges: LineageEdge[]): void {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const candidates = nodes.filter((n) => n.kind !== 'project');
  if (candidates.length === 0) return;
  const mean =
    candidates.reduce((s, n) => s + (degree.get(n.id) ?? 0), 0) / candidates.length;

  for (const n of nodes) {
    const d = degree.get(n.id) ?? 0;
    n.degree = d;
    // ★ `>=` AND A FLOOR OF 3. A strict `>` on a small graph flags nothing (the mean
    //   is dominated by the many 2-degree leaves), and a 2-degree node is a link, not
    //   a hub. Both bounds are needed for the flag to mean "unusually connected".
    n.hub = d >= 3 && d >= mean;
  }
}

/**
 * The account colours, keyed by `OBJECT_`.
 *
 * ★ COLOUR IS ASSIGNED BY POSITION IN THE PROJECT'S OWN ACCOUNT LIST, NOT BY THE CODE.
 *   A hash of `OBJECT_` would give a stable colour per account across projects, which
 *   sounds better until two accounts hash to the same hue in a four-account project —
 *   and the four accounts of a level are the only grouping the reader is looking at.
 *   Position guarantees they are distinguishable. The trade is that `529` is not the
 *   same colour on two projects; the account's *label* is what identifies it, and the
 *   label is on every node.
 */
const ACCOUNT_COLOURS = ['#165788', '#7a3f9d', '#b5651d', '#1c7a52', '#a8324a', '#4a6fa5'];

export function accountColour(accounts: string[], object: string): string {
  const i = accounts.indexOf(object);
  return ACCOUNT_COLOURS[(i < 0 ? 0 : i) % ACCOUNT_COLOURS.length];
}

// ---------------------------------------------------------------------------
// The invoice/check link, read from the API
// ---------------------------------------------------------------------------

/** One PO line's invoice and check counts — the graph's tail. */
export interface LineageLink {
  orderNumber: string;
  lineNumber: string;
  invoices: number;
  checks: number;
  /** Σ invoice-line amount, which is NOT the PO line's amount — partial invoicing is normal. */
  amount: number;
}

export interface LineageLinks {
  level: string;
  links: LineageLink[];
  coverage: {
    /** PO lines the level has at all. */
    poLines: number;
    /** Of those, how many an invoice names. The rest have no link, which is a real answer. */
    linked: number;
  };
  source: string;
}

/**
 * Read the invoice/check link for one project.
 *
 * ★★ THIS IS THE ONLY NETWORK CALL THE GRAPH MAKES, AND IT IS OPTIONAL TO THE VIEW.
 *
 * The extract the app holds is a PO-line report with no invoice columns, so the graph's
 * last two levels need a server read. But the graph is still *valid* without it — it just
 * stops at the PO line — so a failure here returns `null` rather than throwing, and the
 * view says which it is. A chain that ends for no visible reason is worse than one that
 * says "the invoice link could not be read".
 *
 * ★ THE RESPONSE IS WRAPPED IN `data`, LIKE EVERY OTHER ENDPOINT. Reading it unwrapped
 *   yields `undefined` and looks like an empty result rather than a parse mistake.
 */
export async function loadLineageLinks(
  level: string,
  signal?: AbortSignal,
): Promise<LineageLinks | null> {
  try {
    const res = await fetch(sqlUrl(`/api/ap/project-lineage?level=${encodeURIComponent(level)}`), {
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: LineageLinks };
    const data = body?.data;
    if (data === undefined || !Array.isArray(data.links)) return null;
    return data;
  } catch {
    // A failed link read is not a failed page. See the note above.
    return null;
  }
}

/**
 * Index the links by the PO-line key `buildLineage` looks them up with.
 *
 * ★ THE KEY IS `ORDER_NUMBER:LINE_NUMBER`, THE SAME ONE `poLineKey` BUILDS. The API
 *   returns the two parts separately (they are the natural key of the join), and this
 *   is where they are joined — once, in one place, rather than at every lookup.
 */
export function indexLinks(links: LineageLinks | null): Map<string, { invoices: number; checks: number; amount: number }> {
  const map = new Map<string, { invoices: number; checks: number; amount: number }>();
  if (links === null) return map;
  for (const link of links.links) {
    map.set(poLineKey(link.orderNumber, link.lineNumber), {
      invoices: link.invoices,
      checks: link.checks,
      amount: link.amount,
    });
  }
  return map;
}
