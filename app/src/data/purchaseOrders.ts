import type { ExtractLine, Project } from './types';
import { keyOfDotted } from './budgets';

/**
 * The purchase-order register, rolled up from the extract lines.
 *
 * ## Why this reads the extract and not `PO_HEADERS_ALL`
 *
 * `server/src/routes/procurement.ts` serves the same orders out of `PO_HEADERS_ALL`,
 * and a register built from it would be a lie beside the rest of this app:
 *
 * 1. **It would ignore the scope.** Every scoped page here — the dashboard, the
 *    projects list, the activity feed, the funding search — reads the extract
 *    lines. The scope is applied to that one array. A register on a second source
 *    would keep showing orders after the reader narrowed the fund or the program,
 *    and its totals would not reconcile with any page next to it.
 * 2. **It would disagree about the money.** Measured: the extract's lines sum to
 *    `430,569,026.92` while `SUM(PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED)` is
 *    `430,580,538.04` — the two grains differ by `11,511.12` because a lump-sum
 *    line carries no quantity to multiply and three line/distribution pairs
 *    disagree. Two figures for one thing is the failure this app is built to avoid,
 *    so the register takes the one the projects page already reports.
 * 3. **It would need three joins to answer §3.** The project a row belongs to is
 *    `SEGMENT5` on the order's accounts — a join through
 *    `PO_DISTRIBUTIONS_ALL → GL_CODE_COMBINATIONS`. The extract carries
 *    `LEVEL_` on the line. Measured over the extract: **739 of 741 orders sit on
 *    exactly one level**, 2 on two, and none is unattributed.
 *
 * The extract is the scoped population, not a sample of it: `FUND` is `04` and
 * `PROGRAM` is `862` on all 2,781 usable lines, and all 741 order numbers resolve
 * to a real `PO_HEADERS_ALL` row. One order in the database (`276551`) has no
 * extract lines, so it cannot appear here — see the note the screen prints.
 *
 * ## The grain
 *
 * One row per `ORDER_NUMBER`. The amount is the sum of the order's line amounts,
 * which is the same grain the projects page sums, so the two agree.
 */
export interface OrderRow {
  /** `ORDER_NUMBER`. Unique across the register, never blank. */
  number: string;
  /** Earliest `ORDER_DATE` on the order, ISO `yyyy-mm-dd`. */
  date: string;
  /** Latest `ORDER_DATE` on the order. Equal to `date` on a single-day order. */
  lastDate: string;
  vendor: string;
  buyer: string;
  /** Distinct `STATUS` values, in the order the extract lists them. */
  statuses: string[];
  /** True when any line carries `REQUIRES REAPPROVAL` rather than `APPROVED`. */
  reapproval: boolean;
  /** The order's lines, as the extract holds them. The drawer renders these. */
  lines: ExtractLine[];
  lineCount: number;
  /** Sum of the line amounts. */
  amount: number;
  /** Distinct `LEVEL_` values on the order — the project(s) it is charged to. */
  levels: string[];
  /** Names for `levels`, from the project registry. Empty string where unnamed. */
  levelNames: string[];
  /** True when the order is charged to more than one level. Two orders are. */
  split: boolean;
  /** Distinct object codes, item numbers, combination keys and vendors. */
  objects: number;
  items: number;
  combos: number;
  vendors: number;
}

/** An order's combination key in the app's canonical dashed spelling. */
export const keyOfLine = (line: ExtractLine): string => keyOfDotted(line.combinationKey);

/** Whatever spelling an arrival used, brought to the app's dashed form. */
export const accountKey = (account: string): string => keyOfDotted(account);

/** The register, with one order open. `?order=` is the arrival. */
export const orderHref = (number: string): string =>
  `/procurement/purchase-orders?order=${encodeURIComponent(number)}`;

/**
 * The register filtered to the orders charged to one account combination.
 *
 * Dotted and dashed arrivals are the same request — `keyOfDotted` normalises, for
 * the reason `budgets.ts` records: a link should not work or not depending on
 * which page built it. Measured over the served extract: of the 71 account
 * combinations the invoices in scope are booked to, **46 are charged to at least
 * one register line**, and **57 of the 126 invoices hold at least one of those**.
 * For the other 69 the account is a combination no purchase-order line is charged
 * to, and the screen says so rather than showing an empty table.
 *
 * ★ THOSE TWO NUMBERS USED TO READ 37 AND 89, AND THE OLD PAIR WAS NOT A TYPO — it
 *   was a different question answered and written down as this one. 37 counts
 *   something else entirely, so anyone re-deriving these must count *the invoice's
 *   combinations against the register's line combinations* and nothing else; the
 *   obvious substitutes (the 110 invoices that name an order, the 62 the register
 *   holds) are the LINE side of the relation and are deliberately different
 *   numbers, because an invoice can name an order whose lines are booked to
 *   another account.
 */
export const ordersForAccountHref = (account: string): string =>
  `/procurement/purchase-orders?account=${encodeURIComponent(account)}`;

/** The register filtered to one project level. The widening step from an account. */
export const ordersForLevelHref = (level: string): string =>
  `/procurement/purchase-orders?level=${encodeURIComponent(level)}`;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Roll the extract lines up into one row per order.
 *
 * `projects` is the store's registry, used only to put a name against a level. A
 * level with no name is shown as its bare code rather than being hidden, because a
 * nameless level is a real state here — `Project.unclaimed` records exactly that.
 */
export function buildOrders(lines: ExtractLine[], projects: Project[]): OrderRow[] {
  const named = new Map<string, string>();
  for (const p of projects) {
    if (p.level && p.name) named.set(str(p.level), str(p.name));
  }

  type Acc = {
    lines: ExtractLine[];
    dates: string[];
    vendors: string[];
    buyers: string[];
    statuses: string[];
    levels: string[];
    objects: Set<string>;
    items: Set<string>;
    combos: Set<string>;
    amount: number;
  };
  const byOrder = new Map<string, Acc>();

  for (const l of lines) {
    const number = str(l.orderNumber);
    if (!number) continue;
    let acc = byOrder.get(number);
    if (!acc) {
      acc = {
        lines: [],
        dates: [],
        vendors: [],
        buyers: [],
        statuses: [],
        levels: [],
        objects: new Set(),
        items: new Set(),
        combos: new Set(),
        amount: 0,
      };
      byOrder.set(number, acc);
    }
    acc.lines.push(l);
    if (l.orderDate) acc.dates.push(l.orderDate);
    if (l.vendor && !acc.vendors.includes(l.vendor)) acc.vendors.push(l.vendor);
    if (l.buyer && !acc.buyers.includes(l.buyer)) acc.buyers.push(l.buyer);
    if (l.status && !acc.statuses.includes(l.status)) acc.statuses.push(l.status);
    if (l.level && !acc.levels.includes(l.level)) acc.levels.push(l.level);
    if (l.object) acc.objects.add(l.object);
    if (l.itemNumber) acc.items.add(l.itemNumber);
    if (l.combinationKey) acc.combos.add(l.combinationKey);
    acc.amount += l.amount;
  }

  const rows: OrderRow[] = [];
  for (const [number, acc] of byOrder) {
    const levels = [...acc.levels].sort();
    const dates = [...acc.dates].sort();
    rows.push({
      number,
      date: dates[0] ?? '',
      lastDate: dates[dates.length - 1] ?? '',
      vendor: acc.vendors[0] ?? '',
      buyer: acc.buyers[0] ?? '',
      statuses: acc.statuses,
      reapproval: acc.statuses.some((s) => s.toUpperCase().includes('REAPPROVAL')),
      lines: acc.lines,
      lineCount: acc.lines.length,
      amount: acc.amount,
      levels,
      levelNames: levels.map((lv) => named.get(lv) ?? ''),
      split: levels.length > 1,
      objects: acc.objects.size,
      items: acc.items.size,
      combos: acc.combos.size,
      vendors: acc.vendors.length,
    });
  }

  // Newest first, and the order number as the tiebreaker — measured, 650 of the
  // 741 orders share their earliest date with another order (25 orders start on
  // 2025-03-07 alone), so a date-only sort would shuffle between renders.
  rows.sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));
  return rows;
}
