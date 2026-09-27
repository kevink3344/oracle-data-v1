import { hierarchy, partition, type HierarchyRectangularNode } from 'd3-hierarchy';
import { money0, num, pluralise } from './format';
import { poLineKey, type LineageNode } from './lineage';
import type { ExtractLine, Project } from './types';

/**
 * The five-ring sunburst for one project — Project → Account → PO line → Invoice → Check.
 *
 * ── ★★ THE ONE IDEA THIS FILE EXISTS TO PROTECT: THE PARENT'S OWN MEASURE IS
 *    THE DENOMINATOR, NOT THE SUM OF ITS CHILDREN. ────────────────────────────
 *
 * `d3.partition()` gives each child an angular span of
 *
 *     child.value / parent.value  ×  parent's span
 *
 * and it reads the denominator straight off the parent node (`treemap/dice.js`:
 * `k = parent.value && (x1 - x0) / parent.value`). That is the whole design, and it
 * has two consequences that are easy to lose:
 *
 *   1. If the value were propagated up with `.sum()`, every node's `value` would
 *      become "everything beneath me" and the disc would be one global share of the
 *      project, four times over. Each ring would then merely *redraw* the ring inside
 *      it. **So `.sum()` is banned here. Each node carries its OWN measure.**
 *
 *   2. Because the denominator is the parent's own measure rather than its children's
 *      total, ring 4 can span **less than its parent's wedge** — and the empty part of
 *      that wedge is the finding. Measured on level 0450, invoices reached 93.8% of
 *      the median PO line and **2.7%** of one of them. A disc that normalised that
 *      away would be drawing the same picture as ring 3 with more colours.
 *
 * ★ AND THE TRAP THAT COMES WITH IT: a falsy `parent.value` makes `k` falsy, so every
 *   child gets `x1 === x0` — **zero width, silently, with no error anywhere**. A
 *   zero-amount line therefore draws nothing and would take its invoices down with it.
 *   Zero-amount nodes are counted into `meta.zeroLines` and stated in the view rather
 *   than quietly vanishing.
 *
 * ── ★★ THE RINGS MEASURE FIVE DIFFERENT THINGS, AND THE DISC SAYS SO ────────
 *
 *   ring 1  project   `project.committed`                     money
 *   ring 2  account   Σ `line.amount` on that account          money
 *   ring 3  PO line   Σ `line.amount` for that order+line      money
 *   ring 4  invoice   `min(link.amount, line.amount)`          money — a **share**, not a total
 *   ring 5  check     one equal tick per check                 **count**
 *
 * Rings 1–3 add up: Σ ring-1 = Σ ring-2 = Σ ring-3 = the project's committed total, so
 * a wedge's width there is a share of the project. **Rings 4 and 5 are deliberately
 * outside that identity** — ring 4 is a share of *its own* PO line, ring 5 is a count
 * of cheques. `SunburstRing.unit` and `.denominator` carry that in words so the legend
 * and the caption cannot drift from the geometry.
 *
 * ── ★ THE TREE IS DRAWN TWICE — AS A DISC AND AS A RECTANGLE ────────────────
 *
 * `partitionSunburst` and `partitionIcicle` below take the SAME tree and differ only in
 * `d3.partition().size()`, i.e. in which axis carries the measure. So this module builds
 * the project's five levels once and both readings of them are guaranteed to agree: the
 * same node ids, the same `.unit`/`.denominator` strings, the same `meta`, the same
 * `sunburstSelection` for the shared detail panel. Anything added here lands on both
 * views at once, and that is the point rather than a side effect.
 *
 * ── ★ ROLLED-UP BY PO-LINE KEY, NOT BY EXTRACT ROW ──────────────────────────
 *
 * A PO line's identity is `ORDER_NUMBER:LINE_NUMBER` — that is what an invoice names —
 * so rows sharing that pair are one arc. At level 0450 the two counts coincide (20 rows,
 * 20 keys, histogram `{"1":20}`), so every published figure is unchanged; elsewhere they
 * may not, and `meta.rowCount` / `meta.lineCount` / `meta.multiRowLines` state both.
 *
 * ── ★ IDS MATCH `lineage.ts` EXACTLY ────────────────────────────────────────
 *
 * `project:0450`, `account:0450:529`, `po:266121:3`, `invoice:po:266121:3`. The shared
 * detail panel resolves this node's ids against the ones the Flowchart and Network
 * already produce, so clicking an arc and clicking a node describe the same thing.
 */

/** Ring 1 → ring 5. Also the radial divisor the layout uses. */
export const SUNBURST_DEPTHS = 5;

export type SunburstKind = 'project' | 'account' | 'po' | 'invoice' | 'check';

/** What a node's own quantity is, in words — and whether it is money or a count. */
export interface SunburstUnit {
  label: string;
  kind: 'money' | 'count';
}

export interface SunburstNode {
  /** A real key from the data, matching `lineage.ts`. Never a display string. */
  id: string;
  kind: SunburstKind;
  depth: number;
  /** The long name — the detail panel's heading. */
  label: string;
  /** A short token — the breadcrumb's segment. */
  name: string;
  subtitle: string;
  /** The OBJECT_ segment this node sits under, for `accountColour`. Null above ring 2. */
  account: string | null;
  /** What `measure` is measured in. */
  unit: SunburstUnit;
  /**
   * ★ THIS NODE'S OWN MEASURE — never the sum of its children. This is the number
   * `d3.partition()` divides a child's span by.
   */
  value: number;
  /** The same quantity in the node's own unit (equal to `value` for money nodes). */
  measure: number;
  /** Money for the shared panel; `0` where this path carries none (a check tick). */
  amount: number;
  /** Count shown beside the money in the panel (`link.invoices`, `link.checks`, rows). */
  lines: number;
  vendor: string;
  invoices: number;
  checks: number;
  /** Ring 4 only: the invoice money that reached this PO line, clamped to its amount. */
  covered: number | null;
  /** Ring 4 only: `covered / value` — the share of its own line drawn. */
  ratio: number | null;
  /** ★ Ring 4 only: an invoice reached MORE than the line's amount (`283847|1`, 112%). */
  over: boolean;
  children: SunburstNode[];
}

export interface SunburstRing {
  depth: number;
  kind: SunburstKind;
  title: string;
  /**
   * What one arc's width — or, on the icicle, one cell's height — means on this level,
   * in words. Deliberately shape-neutral: both readings of the tree print this string.
   */
  unit: string;
  /** ★ THE DENOMINATOR — ring 4 is a share of its own line, ring 5 a count of checks. */
  denominator: string;
  measure: 'money' | 'count';
  /** How many arcs this ring drew. */
  arcs: number;
  /** Σ of this ring's own measures, in `measure`'s unit. */
  total: number;
}

export interface SunburstMeta {
  level: string;
  /** Extract rows at this level. */
  rowCount: number;
  /** Distinct `ORDER_NUMBER:LINE_NUMBER` keys — the ring-3 arc count. */
  lineCount: number;
  /** Keys carrying more than one extract row, so the two counts above can differ. */
  multiRowLines: number;
  accountCount: number;
  vendorCount: number;
  /** PO lines the invoice mirror reached. */
  linkedLines: number;
  unlinkedLines: number;
  unlinkedAmount: number;
  invoiceCount: number;
  checkCount: number;
  /** Σ ring-4 measures — the invoice money that reached these lines. */
  covered: number;
  /** Σ of the ring-3 measures (≡ `committed` when the two agree). */
  lineAmount: number;
  committed: number;
  /** What ring 1 actually divides by — `committed`, or the line total if it is unusable. */
  rootValue: number;
  /** ★ The lines whose invoice money exceeded the line, clamped and flagged. */
  overLines: { id: string; label: string; ratio: number; amount: number }[];
  /** ★ Lines (or accounts) measuring 0 — a zero-width arc, stated rather than dropped. */
  zeroLines: number;
  /** Links in the index naming a PO line this project does not have at this level. */
  orphanLinks: number;
  /** Ring 1 has nothing to divide by. The view must say so instead of drawing a blank disc. */
  degenerate: boolean;
}

export interface SunburstTree {
  root: SunburstNode;
  rings: SunburstRing[];
  meta: SunburstMeta;
}

/** A node with its placed geometry. `y ∈ [depth, depth + 1]`. */
export type SunburstArc = HierarchyRectangularNode<SunburstNode>;

/**
 * ★ THE SAME PLACED NODE UNDER A NAME THAT PROMISES NO PARTICULAR SHAPE.
 *   `partitionIcicle` returns these too — the two layouts differ in WHICH AXIS carries
 *   the measure, not in the type of the result. A renderer reading `x`/`y`/`depth`
 *   therefore works for both, which is what makes "the rectangular reading of the same
 *   data" a relabelling rather than a second implementation.
 */
export type PartitionCell = SunburstArc;

const RING_SPECS: Omit<SunburstRing, 'arcs' | 'total'>[] = [
  {
    depth: 0,
    kind: 'project',
    title: 'Project',
    unit: 'committed dollars',
    // ★ "THE WHOLE FIGURE", NOT "THE WHOLE CIRCLE". One spec serves a disc and a
    //   partition, and this one string is printed in a visible ring key on both. "Figure"
    //   is the only noun that is true of a circle and of a rectangle.
    denominator: 'the whole figure is the project',
    measure: 'money',
  },
  {
    depth: 1,
    kind: 'account',
    title: 'Account',
    unit: 'PO money booked to the account',
    denominator: "each account's share of the project's committed total",
    measure: 'money',
  },
  {
    depth: 2,
    kind: 'po',
    title: 'PO line',
    unit: 'the line amount',
    denominator: "each line's share of **its own account's** PO money",
    measure: 'money',
  },
  {
    depth: 3,
    kind: 'invoice',
    title: 'Invoice',
    unit: 'invoice money that reached the line',
    // "whatever the line does not account for" rather than "the rest of the wedge":
    // there is no wedge on a rect, and the empty remainder is the finding either way.
    denominator:
      "the share of **its own PO line** the invoices reached — whatever the line does not account for is left empty on purpose",
    measure: 'money',
  },
  {
    depth: 4,
    kind: 'check',
    title: 'Check',
    unit: 'one tick per check',
    // "invoice money", not "invoice arc" — the same span, named by what it measures.
    denominator: "each check an equal share of **its own line's** invoice money — a count, not dollars",
    measure: 'count',
  },
];

/**
 * Build the five rings for one project.
 *
 * ★ `index` is `indexLinks(links)` — the map `lineage.ts` already builds from
 *   `/api/ap/project-lineage`. Nothing here re-queries, so the disc cannot disagree
 *   with the tables and the Network view standing beside it.
 *
 * ★ UNCAPPED, ON PURPOSE. The Network view draws only the largest PO lines per account
 *   because a force layout needs the room; a sunburst's whole point is that every line
 *   is a wedge, so `PO_LINES_PER_ACCOUNT` is not applied here and `meta.lineCount`
 *   lets the legend say "all N lines".
 */
export function buildSunburstTree(
  project: Project,
  lines: ExtractLine[],
  index: Map<string, { invoices: number; checks: number; amount: number }>,
): SunburstTree {
  const mine = lines.filter((line) => line.level === project.level);

  // ── Ring 3's real grain: one arc per `(ORDER_NUMBER, LINE_NUMBER)` ───────────
  interface PoLine {
    key: string;
    orderNumber: string;
    lineNumber: string;
    amount: number;
    rows: number;
    vendor: string;
    itemNumber: string;
    description: string;
    object: string;
  }

  const byKey = new Map<string, PoLine>();
  const byAccount = new Map<string, PoLine[]>();

  for (const line of mine) {
    const key = poLineKey(line.orderNumber, line.lineNumber);
    let po = byKey.get(key);
    if (po === undefined) {
      po = {
        key,
        orderNumber: line.orderNumber,
        lineNumber: line.lineNumber,
        amount: 0,
        rows: 0,
        vendor: line.vendor.trim(),
        itemNumber: line.itemNumber ?? '',
        description: line.description,
        object: line.object,
      };
      byKey.set(key, po);
      const bucket = byAccount.get(line.object);
      if (bucket === undefined) byAccount.set(line.object, [po]);
      else bucket.push(po);
    }
    po.amount += line.amount;
    po.rows += 1;
  }

  // ★ THE LABEL COMES FROM THE PROJECT'S OWN ACCOUNTS ARRAY, NOT A SECOND LOOKUP —
  //   the same rule `buildLineage` follows, so the two views cannot disagree.
  const labelOf = new Map(project.accounts.map((a) => [a.object, a.label]));

  // ★ THE ACCOUNT ORDER IS THE PROJECT'S OWN ORDER, WHICH IS ALSO THE COLOUR ORDER.
  //   `Project.accounts` is already sorted largest-committed-first and
  //   `accountColour` assigns by position in it, so iterating it keeps ring 2's
  //   clockwise order in step with the legend's swatches. An account the project
  //   array does not name (possible if the taxonomy lagged the data) is appended
  //   by size rather than dropped.
  const known = project.accounts.map((a) => a.object).filter((object) => byAccount.has(object));
  const extras = [...byAccount.keys()]
    .filter((object) => !labelOf.has(object))
    .sort((a, b) => sum(byAccount.get(b)!) - sum(byAccount.get(a)!));
  const accountOrder = [...known, ...extras];

  const vendorSet = new Set<string>();
  for (const line of mine) {
    const vendor = line.vendor.trim();
    if (vendor !== '') vendorSet.add(vendor);
  }

  // ── Ring 1 ───────────────────────────────────────────────────────────────────
  const lineAmount = sum([...byKey.values()]);
  const committed = project.committed;
  const rootValue = committed > 0 ? committed : lineAmount;

  const root: SunburstNode = {
    id: `project:${project.level}`,
    kind: 'project',
    depth: 0,
    label: project.name,
    name: project.code,
    subtitle: `${project.code} · ${project.site}`,
    account: null,
    unit: { label: 'committed', kind: 'money' },
    value: rootValue,
    measure: rootValue,
    amount: committed,
    lines: project.lines,
    vendor: '',
    invoices: 0,
    checks: 0,
    covered: null,
    ratio: null,
    over: false,
    children: [],
  };

  // ── Ring 2, ring 3, ring 4, ring 5 ───────────────────────────────────────────
  const overLines: SunburstMeta['overLines'] = [];
  let zeroLines = 0;
  let linkedLines = 0;
  let unlinkedAmount = 0;
  let invoiceCount = 0;
  let checkCount = 0;
  let covered = 0;
  let matchedLinks = 0;

  for (const object of accountOrder) {
    const pos = [...(byAccount.get(object) ?? [])].sort(
      (a, b) => b.amount - a.amount || a.key.localeCompare(b.key),
    );
    const accountValue = sum(pos);
    const accountVendors = new Set(pos.map((po) => po.vendor).filter((v) => v !== ''));

    const account: SunburstNode = {
      id: `account:${project.level}:${object}`,
      kind: 'account',
      depth: 1,
      label: labelOf.get(object) ?? `${object} · account`,
      name: object,
      subtitle: `${num(pos.length)} ${pluralise(pos.length, 'PO line')} · ${num(
        accountVendors.size,
      )} ${pluralise(accountVendors.size, 'vendor')}`,
      account: object,
      unit: { label: 'PO money on this account', kind: 'money' },
      // ★ THE ACCOUNT'S OWN MEASURE — the Σ of its lines, which is the denominator
      //   ring 3 divides by. Never the sum of the arcs drawn inside it.
      value: accountValue,
      measure: accountValue,
      amount: accountValue,
      lines: pos.length,
      vendor: '',
      invoices: 0,
      checks: 0,
      covered: null,
      ratio: null,
      over: false,
      children: [],
    };

    for (const po of pos) {
      const link = index.get(po.key);
      const hasInvoices = link !== undefined && link.invoices > 0;
      if (hasInvoices) matchedLinks += 1;

      const poNode: SunburstNode = {
        id: po.key,
        kind: 'po',
        depth: 2,
        label: `PO ${po.orderNumber} · line ${po.lineNumber}`,
        name: `${po.orderNumber}·${po.lineNumber}`,
        subtitle: po.vendor === '' ? 'no vendor recorded' : po.vendor,
        account: object,
        unit: { label: 'PO line amount', kind: 'money' },
        value: po.amount,
        measure: po.amount,
        amount: po.amount,
        lines: 1,
        vendor: po.vendor,
        invoices: link?.invoices ?? 0,
        checks: link?.checks ?? 0,
        covered: null,
        ratio: null,
        over: false,
        children: [],
      };

      if (po.amount <= 0) zeroLines += 1;

      if (hasInvoices && po.amount > 0) {
        const raw = link.amount;
        // ★ THE CLAMP. An invoice can name more than the line's amount (`283847|1` reached
        //   112%), and without this the arc would spill past its own parent's wedge and
        //   overpaint its neighbour. The clamp is reported, never silent.
        const drew = Math.min(raw, po.amount);
        const ratio = raw / po.amount;
        const over = raw > po.amount + 0.005;

        const invoice: SunburstNode = {
          id: `invoice:${po.key}`,
          kind: 'invoice',
          depth: 3,
          label: `${num(link.invoices)} ${pluralise(link.invoices, 'invoice')}`,
          name: `${link.invoices} inv`,
          subtitle: `${money0(drew)} of ${money0(po.amount)} reached${over ? ' — more than the line' : ''}`,
          account: object,
          unit: { label: 'invoice money reached', kind: 'money' },
          // ★ THE SHARE IS THE MESSAGE: `drew / po.amount` of the line's wedge, and the
          //   remainder of that wedge stays empty because `dice.js` divides by the
          //   PARENT's value, which is the line's own amount.
          value: drew,
          measure: drew,
          amount: drew,
          lines: link.invoices,
          vendor: po.vendor,
          invoices: link.invoices,
          checks: link.checks,
          covered: drew,
          ratio,
          over,
          children: [],
        };

        if (link.checks > 0) {
          // ★ ONE EQUAL TICK PER CHECK. There is no per-check amount on this path at all
          //   (`LineageLink` carries `checks` as a count), so the ticks are deliberately
          //   indistinguishable and their unit says "one check". The dividend is the
          //   invoice node's own `drew`, so the ticks tile exactly the arc that exists.
          const tick = drew / link.checks;
          for (let i = 0; i < link.checks; i += 1) {
            invoice.children.push({
              id: `check:${po.key}#${i}`,
              kind: 'check',
              depth: 4,
              label: `Check ${num(i + 1)} of ${num(link.checks)}`,
              name: `${i + 1}`,
              subtitle: `one of ${num(link.checks)} ${pluralise(
                link.checks,
                'check',
              )} that settled ${money0(drew)} against PO ${po.orderNumber} line ${po.lineNumber}`,
              account: object,
              unit: { label: 'one check', kind: 'count' },
              value: tick,
              measure: 1,
              amount: 0,
              lines: 1,
              vendor: po.vendor,
              invoices: 0,
              checks: 1,
              covered: null,
              ratio: null,
              over: false,
              children: [],
            });
          }
        }

        poNode.children.push(invoice);
        poNode.covered = drew;
        poNode.ratio = ratio;
        poNode.over = over;

        linkedLines += 1;
        invoiceCount += link.invoices;
        checkCount += link.checks;
        covered += drew;
        if (over) {
          overLines.push({
            id: po.key,
            label: `PO ${po.orderNumber} · line ${po.lineNumber}`,
            ratio,
            amount: raw,
          });
        }
      } else {
        unlinkedAmount += po.amount;
      }

      account.children.push(poNode);
    }

    root.children.push(account);
  }

  // ── The rings' own totals and arc counts ─────────────────────────────────────
  // ★★ THE SPECS ARE AUTHORED WITH `**EMPHASIS**` AND THE DOM DOES NOT RENDER MARKDOWN.
  //   Left in place, every ring key would print its own asterisks —
  //   "each line's share of **its own account's** PO money" — which reads as a typo
  //   rather than as emphasis. Stripped once here, so both consumers (the visible ring
  //   key and the hidden summary table) get plain text and neither has to remember.
  const rings: SunburstRing[] = RING_SPECS.map((spec) => ({
    ...spec,
    unit: spec.unit.replace(/\*\*/g, ''),
    denominator: spec.denominator.replace(/\*\*/g, ''),
    arcs: 0,
    total: 0,
  }));
  const walk = (node: SunburstNode): void => {
    const ring = rings[node.depth];
    ring.arcs += 1;
    ring.total += node.measure;
    for (const child of node.children) walk(child);
  };
  walk(root);

  let orphanLinks = 0;
  for (const key of index.keys()) {
    // A link the mirror holds for a PO line this project's rows do not carry at this
    // level. Counted so the disclosure can say the two sources disagree rather than
    // letting the difference look like a bug in the disc.
    if (!key.startsWith('po:') || byKey.has(key)) continue;
    if ((index.get(key)?.invoices ?? 0) > 0) orphanLinks += 1;
  }

  return {
    root,
    rings,
    meta: {
      level: project.level,
      rowCount: mine.length,
      lineCount: byKey.size,
      multiRowLines: [...byKey.values()].filter((po) => po.rows > 1).length,
      accountCount: root.children.length,
      vendorCount: vendorSet.size,
      linkedLines,
      unlinkedLines: byKey.size - linkedLines,
      unlinkedAmount,
      invoiceCount,
      checkCount,
      covered,
      lineAmount,
      committed,
      rootValue,
      overLines,
      zeroLines,
      orphanLinks,
      degenerate: rootValue <= 0,
    },
  };
}

/**
 * Place the tree: `d3.partition()`, with the measure rule enforced in one place.
 *
 * ★★ `.sum()` IS NEVER CALLED. It would overwrite every node's own measure with
 *    "everything beneath me", and every ring would then be a share of the project
 *    rather than of its parent — which is precisely the mixed-unit disc that does not
 *    exist. `partition` reads each child's span off `parent.value`, so copying each
 *    node's OWN measure onto the layout node is the entire contract.
 *
 * ★ `size([2π, SUNBURST_DEPTHS])` makes `y` mean "depth": ring `d` occupies
 *   `y ∈ [d, d + 1]`, so the renderer's radius is simply `y / SUNBURST_DEPTHS`.
 */
/**
 * ★ `HierarchyNode.value` IS `readonly` IN THE TYPINGS, because @types/d3-hierarchy
 *   assumes `sum()` or `count()` put it there. Neither is called here — `.sum()` is
 *   banned above, and `count()` would replace the measure with a node count — so the
 *   value is written by hand and one local cast through a mutable view is the only way
 *   to state that contract. The cast does not escape this function; the returned
 *   `SunburstArc` is still the readonly-typed `HierarchyNode`.
 */
type MutableMeasure = { value?: number };

export function partitionSunburst(root: SunburstNode): SunburstArc {
  const laid = hierarchy(root, (node) => (node.children.length > 0 ? node.children : undefined));
  laid.eachBefore((node) => {
    (node as MutableMeasure).value = node.data.value;
  });
  return partition<SunburstNode>()
    .size([2 * Math.PI, SUNBURST_DEPTHS])
    .padding(0)(laid);
}

/**
 * ★★ THE SAME TREE, THE SAME MEASURE CONTRACT, THE AXES EXCHANGED.
 *
 * This exists so the rectangular reading of a project CANNOT disagree with the circular
 * one. It is the same `buildSunburstTree` output, the same `.sum()`-free measure copy,
 * and the same `d3.partition()`; only `size`'s arguments differ, which is all that
 * separates an icicle from a sunburst:
 *
 *   `partitionSunburst`  size([2π, 5])  →  x = angle (the measure), y = depth
 *   `partitionIcicle`    size([1, 5])   →  x = the measure in [0, 1], y = depth
 *
 * With `dx = 1` every node's `x` extent is its share of its OWN parent — the rule at the
 * top of this file, unchanged — and with `dy = 5` and `n = height + 1 = 5` the depth axis
 * is `y ∈ [depth, depth + 1]` exactly as on the disc. The renderer is then free to scale
 * `x` onto the box's height and `y` onto its width, so the icicle is a pure relabelling
 * of the axes over one set of numbers.
 *
 * ★ THE FALSY-PARENT TRAP TRAVELS WITH THE MEASURE. On the disc a zero `parent.value`
 *   makes every child's angular span zero; here it makes every child's `x1 === x0`, so
 *   the cells have **zero height** instead of zero width. Same silent nothing, same
 *   accounting (`meta.zeroLines`), different axis.
 */
export function partitionIcicle(root: SunburstNode): PartitionCell {
  const laid = hierarchy(root, (node) => (node.children.length > 0 ? node.children : undefined));
  laid.eachBefore((node) => {
    (node as MutableMeasure).value = node.data.value;
  });
  return partition<SunburstNode>().size([1, SUNBURST_DEPTHS]).padding(0)(laid);
}

/**
 * Project a sunburst node for the shared detail panel.
 *
 * ★ ONE DIFFERENCE FROM THE OTHER TWO VIEWS, AND IT IS DELIBERATE: `unit` is set, so the
 *   panel prints the node's own quantity in its own unit. Flowchart and Network nodes
 *   leave `unit` undefined and read exactly as they did. Without it a check tick — which
 *   has no amount on this path at all — would have to print a money figure that the data
 *   does not contain, and the honest alternative is "1 · one check".
 */
export function sunburstSelection(node: SunburstNode): LineageNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    subtitle: node.subtitle,
    amount: node.amount,
    lines: node.lines,
    unit: node.unit,
  };
}

function sum(items: { amount: number }[]): number {
  let total = 0;
  for (const item of items) total += item.amount;
  return total;
}
