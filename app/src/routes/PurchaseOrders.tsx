import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import PinButton from '../components/PinButton';
import { ScopeRemoved } from '../components/ScopeNote';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { SortableHead } from '../components/SortHeader';
import type { Project } from '../data/types';
import { money, money0, num, pctSlim, pluralise, share } from '../data/format';
import {
  CHRONO_ORDER,
  NEWEST_FIRST,
  describeOrder,
  sortRows,
  type SortColumn,
  type SortState,
} from '../data/sort';
import {
  accountKey,
  buildOrders,
  keyOfLine,
  ordersForLevelHref,
  type OrderRow,
} from '../data/purchaseOrders';

/**
 * Purchase orders — one order per row, with the project it is charged to.
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 *
 * §3 of the plan says a purchase-order list has to say which project every row
 * belongs to, including the rows that belong to none, "because a PO list that
 * omits that column is unreadable next to this app". That column is the reason
 * this screen exists and it is the first thing in the table.
 *
 * ── WHERE THE PROJECT COMES FROM ────────────────────────────────────────────
 *
 * Not from the order. Measured on `PO_HEADERS_ALL`: `EXP_PROJECT_NAME` and
 * `EXP_PO_NUMBER` are **null on all 749 rows**, so the header has no project to
 * give. It comes from the account the order is charged to — `SEGMENT5`, the level
 * code, which `coa.ts` records as "the thing this application calls a project".
 * Measured over the extract: **739 of 741 orders sit on exactly one level**, 2 sit
 * on two, and none is unattributed. So the column is populated, and the two
 * split orders say so rather than being averaged into a single name.
 *
 * ── WHERE THE DATA COMES FROM, AND WHY NOT THE DATABASE ─────────────────────
 *
 * The store's scoped extract lines, grouped by `ORDER_NUMBER`. See
 * `data/purchaseOrders.ts` for the measured reason — in one line: the extract
 * sums to `430,569,026.92` where `PO_DISTRIBUTIONS_ALL` sums to
 * `430,580,538.04`, and every other scoped page here reads the extract, so a
 * register on the distributions would print a second number for the same thing.
 *
 * Every amount on this page is the sum of line amounts. Nothing on it is a cost,
 * an actual, or a receipt, because the extract carries none of those: `AMOUNT` is
 * what was committed.
 */
const WIDTH_KEY = 'order-panel-w';

/** Rows per page. 741 orders, so the table is always paged. */
const PER_PAGE = 50;

/** The panel's focus trap reads the same set the other drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const termsOf = (q: string): string[] =>
  q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Everything one order can be found by, flattened once per row.
 *
 * The item numbers and descriptions are in here on purpose: a reader looking for
 * "which order carries the chillers" has the line text, not the order number, and
 * this is the only page where that lookup is possible.
 */
function haystack(o: OrderRow): string {
  return [
    o.number,
    o.date,
    o.vendor,
    o.buyer,
    ...o.levels,
    ...o.levelNames,
    ...o.statuses,
    o.amount.toFixed(2),
    ...o.lines.map((l) => `${l.itemNumber} ${l.description} ${l.object}`),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The seven columns, in the order they are shown.
 *
 * Sorting is by value and never by rendered text — the rule `data/sort.ts` sets —
 * so `amount` sorts on the number even though the cell prints `$97,681,625`, and
 * `project` on the level code so two orders on the same project stay together
 * regardless of whether the project has a name.
 */
const COLUMNS: SortColumn<OrderRow>[] = [
  { key: 'number', label: 'Order', value: (o) => o.number },
  { key: 'project', label: 'Project', value: (o) => o.levels[0] ?? '' },
  { key: 'vendor', label: 'Vendor', value: (o) => o.vendor },
  { key: 'buyer', label: 'Buyer', value: (o) => o.buyer },
  { key: 'date', label: 'Started', value: (o) => o.date, order: CHRONO_ORDER },
  { key: 'lines', label: 'Lines', numeric: true, value: (o) => o.lineCount },
  { key: 'amount', label: 'Committed', numeric: true, value: (o) => o.amount },
];

/** A page-number window with `null` for each gap, as the other registers use. */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | null)[] = [];
  const push = (n: number | null) => {
    if (out[out.length - 1] !== n) out.push(n);
  };
  push(1);
  if (current - 2 > 2) push(null);
  for (let n = Math.max(2, current - 2); n <= Math.min(total - 1, current + 2); n += 1) push(n);
  if (current + 2 < total - 1) push(null);
  push(total);
  return out;
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="postat">
      <div className="postat__k">{label}</div>
      <div className="postat__v">{value}</div>
      <div className="postat__n">{note}</div>
    </div>
  );
}

/**
 * Which project an order is charged to, as a chip that reads as a link when the
 * project has a page to go to.
 *
 * A level with no name in the registry is shown as its bare code rather than being
 * dropped — `Project.unclaimed` records exactly that state, and hiding the row
 * would turn "we hold no name for this project" into "this order has no project".
 */
function ProjectCell({
  levels,
  names,
  meta,
}: {
  levels: string[];
  names: string[];
  meta: Map<string, Project>;
}) {
  if (levels.length === 0) {
    return <span className="po-proj__none">no project</span>;
  }
  return (
    <span className="po-proj">
      {levels.map((lv, i) => {
        const name = names[i] || meta.get(lv)?.name || '';
        return (
          <Link
            key={lv}
            className={`po-proj__chip${name ? '' : ' po-proj__chip--bare'}`}
            to={ordersForLevelHref(lv)}
            title={`Every order charged to level ${lv}${name ? ` — ${name}` : ' (no name held for this level)'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="po-proj__code">{lv}</span>
            {name ? <span className="po-proj__name">{name}</span> : null}
          </Link>
        );
      })}
      {levels.length > 1 ? (
        <span className="po-proj__split" title={`Charged to ${levels.length} projects`}>
          split
        </span>
      ) : null}
    </span>
  );
}

export default function PurchaseOrders() {
  const { lines, projects, scopeStats, status, error, reload } = useStore();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(NEWEST_FIRST);
  const [page, setPage] = useState(1);

  const orderParam = params.get('order') ?? '';
  const accountParam = params.get('account') ?? '';
  const levelParam = params.get('level') ?? '';

  const orders = useMemo(() => buildOrders(lines, projects), [lines, projects]);

  const levelMeta = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) if (p.level) m.set(String(p.level).trim(), p);
    return m;
  }, [projects]);

  /**
   * What the arrival narrowed to, if anything.
   *
   * `account` is the exact combination an invoice was charged to; `level` is the
   * project. Both spellings of an account key are accepted — `keyOfDotted` is the
   * app's normaliser, and `budgets.ts` records why: a link should not work or not
   * depending on which page built it.
   */
  const wanted = useMemo(() => {
    if (accountParam) return { kind: 'account' as const, key: accountKey(accountParam) };
    if (levelParam) return { kind: 'level' as const, key: levelParam.trim() };
    return null;
  }, [accountParam, levelParam]);

  const narrowed = useMemo(() => {
    if (!wanted) return orders;
    if (wanted.kind === 'level') return orders.filter((o) => o.levels.includes(wanted.key));
    return orders.filter((o) => o.lines.some((l) => keyOfLine(l) === wanted.key));
  }, [orders, wanted]);

  const filtered = useMemo(() => {
    const terms = termsOf(query);
    if (terms.length === 0) return narrowed;
    return narrowed.filter((o) => {
      const hay = haystack(o);
      return terms.every((t) => hay.includes(t));
    });
  }, [narrowed, query]);

  const sorted = useMemo(() => sortRows(filtered, COLUMNS, sort), [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const current = Math.min(page, totalPages);
  const shown = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const selected = useMemo(
    () => (orderParam ? orders.find((o) => o.number === orderParam) ?? null : null),
    [orders, orderParam],
  );

  // A page change while filtered down must not leave the reader on page 9 of 2.
  useEffect(() => {
    setPage(1);
  }, [query, accountParam, levelParam]);

  const openOrder = useCallback(
    (number: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('order', number);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const closeOrder = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('order');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const clearNarrow = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('account');
        next.delete('level');
        next.delete('order');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  // ── the figures the stat strip and the footer state ───────────────────────
  // Over `filtered`, not `narrowed`: the search box is part of the filter in the
  // reader's mind as much as the account and level parameters are, and a strip that
  // says "741 orders" above a table that says "1 of 741" is the page contradicting
  // itself. The counts and the totals come off the same set the rows do.
  const totals = useMemo(() => {
    const vendorSet = new Set<string>();
    const levelSet = new Set<string>();
    let lineCount = 0;
    let amount = 0;
    let reapproval = 0;
    let zeroLines = 0;
    let split = 0;
    for (const o of filtered) {
      if (o.vendor) vendorSet.add(o.vendor);
      for (const lv of o.levels) levelSet.add(lv);
      lineCount += o.lineCount;
      amount += o.amount;
      if (o.reapproval) reapproval += 1;
      if (o.split) split += 1;
      for (const l of o.lines) if (l.amount === 0) zeroLines += 1;
    }
    return {
      orders: filtered.length,
      lines: lineCount,
      amount,
      vendors: vendorSet.size,
      levels: levelSet.size,
      reapproval,
      zeroLines,
      split,
    };
  }, [filtered]);

  const projectCount = useMemo(
    () => new Set(orders.flatMap((o) => o.levels)).size,
    [orders],
  );

  const sortNote = describeOrder(COLUMNS, sort);
  const accountKeySpoken = wanted?.kind === 'account' ? wanted.key.split('-').join('.') : '';
  /**
   * Whether the table is the whole register, with nothing narrowed and nothing searched.
   *
   * The footer reconciles two figures for the *full* set, so it must not be shown over a
   * subset — a partial total compared against a whole-set total is the exact kind of
   * statement this app refuses to make.
   */
  const isWholeSet = !wanted && query.trim() === '';

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Purchase orders</h1>
          </div>
        </div>
      </div>

      <ScopeRemoved />

      {status === 'error' ? (
        <ErrorNotice
          error={error ?? 'The extract could not be read.'}
          reload={reload}
          heading="The purchase orders could not be read."
          hint={
            <>
              <p>
                This register is built from the same extract every other page reads —{' '}
                <code>/oracle/output.json</code>, the <code>X_REPORT_FUNDING_LINES</code> rows. If that
                file is missing the orders cannot be listed.
              </p>
              <p>
                The database holds the same orders in <code>PO_HEADERS_ALL</code>, but it holds no
                project on them, so it cannot feed this page.
              </p>
            </>
          }
        />
      ) : null}

      {status === 'ready' ? (
        <div className="postats">
          <Stat
            label="Orders"
            value={num(totals.orders)}
            note={
              totals.orders === orders.length
                ? `${num(scopeStats.shown)} lines in scope`
                : `of ${num(orders.length)} in scope`
            }
          />
          <Stat
            label="Committed"
            value={money0(totals.amount)}
            note="sum of the lines, not the distributions"
          />
          <Stat
            label="Lines"
            value={num(totals.lines)}
            note={`${(totals.orders ? totals.lines / totals.orders : 0).toFixed(1)} per order`}
          />
          <Stat
            label="Projects"
            value={num(totals.levels)}
            note={`of ${num(projectCount)} levels the orders use`}
          />
          <Stat label="Vendors" value={num(totals.vendors)} note="named on a line" />
          <Stat
            label="Needs reapproval"
            value={num(totals.reapproval)}
            note="one line is not approved"
          />
        </div>
      ) : null}

      {/* The arrival that lands on nothing says so, rather than showing an empty table. */}
      {wanted && orders.length > 0 && narrowed.length === 0 ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">
            {wanted.kind === 'account' ? 'No order on this account' : 'No order on this project'}
          </span>
          {wanted.kind === 'account' ? (
            <>
              No purchase-order line in the extract is charged to{' '}
              <code>{accountKeySpoken}</code>. That is a real answer, not a missing one: an invoice can
              be coded to an account no order was raised against — a utility, a purchase card, a
              standing charge. {num(orders.length)} orders are in scope.{' '}
              <button type="button" className="btn btn--system btn--sm" onClick={clearNarrow}>
                Show every order
              </button>
            </>
          ) : (
            <>
              No order is charged to level <code>{wanted.key}</code>. {num(orders.length)} orders are in
              scope.{' '}
              <button type="button" className="btn btn--system btn--sm" onClick={clearNarrow}>
                Show every order
              </button>
            </>
          )}
        </p>
      ) : null}

      {wanted && narrowed.length > 0 ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">
            {wanted.kind === 'account' ? 'One account' : 'One project'}
          </span>
          {wanted.kind === 'account' ? (
            <>
              Showing the {num(narrowed.length)} orders charged to <code>{accountKeySpoken}</code>, of{' '}
              {num(orders.length)} in scope.
            </>
          ) : (
            <>
              Showing the {num(narrowed.length)} orders charged to level <code>{wanted.key}</code>, of{' '}
              {num(orders.length)} in scope.
            </>
          )}{' '}
          <button type="button" className="btn btn--system btn--sm" onClick={clearNarrow}>
            Show every order
          </button>
        </p>
      ) : null}

      {orderParam && !selected && orders.length > 0 ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Not in the extract</span>
          Order <code>{orderParam}</code> has no lines in this extract, so there is nothing to show for
          it. One order in the database (<code>276551</code>) is in that position — it carries no
          distributions either, which is why the extract never saw it.
        </p>
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">The register</h2>
            <p className="panel__sub">
              One row per order. Open a row for its lines, the accounts it is charged to, and where
              those accounts sit in the budget.
            </p>
          </div>
          {status === 'ready' ? (
            <span className="panel__count">
              {num(sorted.length)} of {num(orders.length)}
            </span>
          ) : null}
        </div>

        <div className="filterbar pofilter" role="group" aria-label="Filter purchase orders">
          <div className="pofilter__box">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="6.6" cy="6.6" r="4.6" />
              <path d="M10.2 10.2 14 14" />
            </svg>
            <label className="sr" htmlFor="order-filter">
              Filter purchase orders by number, vendor, buyer, item or description
            </label>
            <input
              id="order-filter"
              type="search"
              autoComplete="off"
              placeholder="Order, vendor, buyer, item or description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
            />
          </div>
          {query ? (
            <button
              type="button"
              className="fchip"
              onClick={() => setQuery('')}
              title="Clear the search and show every order"
            >
              Clear “{query}”
            </button>
          ) : null}
        </div>

        <p className="sr" role="status">
          {termsOf(query).length === 0
            ? `${num(sorted.length)} purchase orders.`
            : `${num(sorted.length)} of ${num(orders.length)} purchase orders match ${termsOf(query).join(' and ')}.`}
        </p>
        <p className="sr" role="status">
          {sortNote}
        </p>

        {status !== 'ready' ? (
          <div className="panel__body">
            <p className="poempty">Reading the purchase-order extract…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="poempty">
            <p>
              {narrowed.length > 0
                ? `No order matches ${query ? `\u201c${query}\u201d` : 'the filter'}.`
                : wanted
                  ? wanted.kind === 'account'
                    ? 'No order is charged to that account.'
                    : 'No order is charged to that project.'
                  : 'No order is in scope.'}
            </p>
            <p className="poempty__hint">
              {narrowed.length > 0
                ? 'The search reads the order number, vendor, buyer, project, status code, item numbers and line descriptions.'
                : wanted
                  ? 'The note above names what was asked for, and the link in it returns to the whole register. An empty arrival is an answer, not a missing one.'
                  : 'The fund and program scope above has removed every order. Widen it to see them.'}
            </p>
            {query ? (
              <button type="button" className="btn btn--system btn--sm" onClick={() => setQuery('')}>
                Clear the search
              </button>
            ) : null}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data potable">
              <caption className="sr">
                Purchase orders, one per row, with the project each is charged to and the sum of its
                lines.
              </caption>
              <colgroup>
                <col className="c-order" />
                <col className="c-proj" />
                <col className="c-vendor" />
                <col className="c-buyer" />
                <col className="c-date" />
                <col className="c-lines" />
                <col className="c-amt" />
              </colgroup>
              <SortableHead
                columns={COLUMNS}
                sort={sort}
                onSort={setSort}
              />
              <tbody>
                {shown.map((o) => (
                  <tr
                    key={o.number}
                    className={`potable__row${o.number === orderParam ? ' is-open' : ''}`}
                    onClick={() => openOrder(o.number)}
                  >
                    <td className="po-num">
                      <button
                        type="button"
                        className="po-link"
                        aria-expanded={o.number === orderParam}
                        aria-controls="order-detail"
                        onClick={(e) => {
                          e.stopPropagation();
                          openOrder(o.number);
                        }}
                      >
                        {o.number}
                      </button>
                    </td>
                    <td>
                      <ProjectCell levels={o.levels} names={o.levelNames} meta={levelMeta} />
                    </td>
                    <td className="po-vendor">{o.vendor || <span className="po-proj__none">—</span>}</td>
                    <td className="po-buyer">{o.buyer || <span className="po-proj__none">—</span>}</td>
                    <td className="po-date">{o.date || '—'}</td>
                    <td className="n po-lines">{num(o.lineCount)}</td>
                    <td className="n po-amt">{money(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {shown.length > 0 && totalPages > 1 ? (
          <div className="pager">
            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <span className="pager__pages">
              {pageWindow(current, totalPages).map((n, i) =>
                n === null ? (
                  <span className="pager__gap" key={`gap-${i}`}>
                    …
                  </span>
                ) : (
                  <button
                    type="button"
                    key={n}
                    className="pager__n"
                    aria-current={n === current ? 'page' : undefined}
                    aria-label={`Page ${n} of ${totalPages}`}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ),
              )}
            </span>
            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === totalPages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}

        {status === 'ready' && shown.length > 0 ? (
          <p className="chart-note" style={{ padding: '0 16px 12px' }}>
            Amounts are the sum of each order&rsquo;s extract lines — the grain the projects page sums,
            so these figures reconcile with it.{' '}
            {isWholeSet ? (
              <>
                The database&rsquo;s <code>PO_DISTRIBUTIONS_ALL</code> totals{' '}
                <strong>$430,580,538.04</strong> for the same orders against the extract&rsquo;s{' '}
                <strong>$430,569,026.92</strong> — <strong>$11,511.12</strong> apart, because a lump-sum
                distribution has no quantity to multiply and the two extracts are not the same set of
                rows. Both figures are measured; this page uses the one the projects page uses so the
                two cannot disagree.{' '}
              </>
            ) : (
              <>
                {totals.orders === 1
                  ? 'This is the only order the current filter keeps, so its total does not reconcile with the whole register’s. '
                  : `These are the ${num(totals.orders)} orders the current filter keeps, so their total does not reconcile with the whole register’s. `}
              </>
            )}{' '}
            {totals.zeroLines > 0
              ? `${num(totals.zeroLines)} of the ${num(totals.lines)} lines here carry an amount of zero and are counted at zero rather than dropped. `
              : ''}
            {totals.split > 0
              ? `${num(totals.split)} ${totals.split === 1 ? 'order is' : 'orders are'} charged to more than one project, and each one names all of them rather than being averaged into one. `
              : ''}
            The fund and program scope has already been applied — this register reads{' '}
            {num(scopeStats.shown)} lines, not the extract&rsquo;s full set, and{' '}
            {num(scopeStats.excluded)} were removed before it was built.
          </p>
        ) : null}
      </section>

      <OrderPanel
        order={selected}
        open={Boolean(selected)}
        onClose={closeOrder}
        meta={levelMeta}
      />
    </div>
  );
}

/**
 * The order drawer.
 *
 * Three blocks, in the order a reader asks the questions: what the order is, which
 * accounts it is charged to, and what is on it. The account block is the one that
 * makes the order reachable from the budget side as well as the top — each account
 * links to the budget detail page the invoice drawer already links to.
 */
function OrderPanel({
  order,
  open,
  onClose,
  meta,
}: {
  order: OrderRow | null;
  open: boolean;
  onClose: () => void;
  meta: Map<string, Project>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const rendered = panelRef.current?.getBoundingClientRect().width ?? 0;

  const setUserWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    storeWidth(WIDTH_KEY, next);
  };
  const resetWidth = () => {
    setWidth(null);
    storeWidth(WIDTH_KEY, null);
  };

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (open && order) closeRef.current?.focus();
  }, [open, order]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes).filter((n) => n.offsetParent !== null);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const byAccount = useMemo(() => {
    if (!order) return [] as { key: string; amount: number; lines: number }[];
    const map = new Map<string, { key: string; amount: number; lines: number }>();
    for (const l of order.lines) {
      const key = keyOfLine(l);
      const entry = map.get(key);
      if (entry) {
        entry.amount += l.amount;
        entry.lines += 1;
      } else {
        map.set(key, { key, amount: l.amount, lines: 1 });
      }
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [order]);

  /* The order's projects, biggest committed money first.
     The accounts table sits directly under this list in the same section and is
     sorted by amount, so leaving this one in the extract's own line order put two
     lists in one block in two different orders — and on order 276968 that means the
     21.2 % project printed above the 78.8 % one. The name is carried alongside the
     level it belongs to, because the name is looked up by index and sorting the
     codes on their own would pair a project with another project's name. */
  const byLevel = useMemo(() => {
    if (!order) return [] as { level: string; name: string; amount: number }[];
    return order.levels
      .map((lv, i) => {
        const mine = order.lines.filter((l) => l.level === lv);
        return {
          level: lv,
          name: order.levelNames[i] || meta.get(lv)?.name || '',
          amount: mine.reduce((a, l) => a + l.amount, 0),
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [order, meta]);

  /* The two facts the line block has to state, counted once. Both are counts of
     lines on this one order, so both are the subject of a verb: "1 line carries"
     and not "1 lines carry". A wrong -s next to a figure is the kind of thing that
     makes a reader stop trusting the figure itself, and the extract holds 588
     lines with no item number and 263 at zero, so both cases are common rather
     than edge cases. */
  const noItem = order ? order.lines.filter((l) => !l.itemNumber).length : 0;
  const zeroAmount = order ? order.lines.filter((l) => l.amount === 0).length : 0;

  const style = width ? ({ '--drawer-w': `${clampWidth(width)}px` } as CSSProperties) : undefined;

  return (
    <div
      className={`drawer popanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      ref={panelRef}
      id="order-detail"
      style={style}
      aria-hidden={!open}
      role="dialog"
      aria-label={order ? `Purchase order ${order.number}` : 'Purchase order details'}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="order-detail"
        label="Resize the purchase order panel"
      />
      <div className="drawer__head">
        <div>
          <p className="drawer__eyebrow">Purchase order</p>
          <h2 className="drawer__name">{order?.number ?? '—'}</h2>
        </div>
        {order ? (
          <PinButton
            category="purchase-order"
            entityKey={order.number}
            title={order.number}
            subtitle={`${order.vendor || 'Vendor not recorded'} · ${order.date}`}
            href={`/procurement/purchase-orders?order=${encodeURIComponent(order.number)}`}
          />
        ) : null}
        <button
          type="button"
          className="drawer__close"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close the order details"
        >
          ×
        </button>
      </div>

      <div className="drawer__body">
        {order ? (
          <>
            <section className="dsec">
              <h3 className="dsec__title">The order</h3>
              <dl className="po-rows">
                <div className="po-row">
                  <dt className="po-row__k">Vendor</dt>
                  <dd className="po-row__v">{order.vendor || 'not recorded'}</dd>
                </div>
                <div className="po-row">
                  <dt className="po-row__k">Buyer</dt>
                  <dd className="po-row__v">{order.buyer || 'not recorded'}</dd>
                </div>
                <div className="po-row">
                  <dt className="po-row__k">Started</dt>
                  <dd className="po-row__v">
                    {order.date}
                    {order.lastDate !== order.date ? (
                      <span className="po-row__note"> last line {order.lastDate}</span>
                    ) : null}
                  </dd>
                </div>
                <div className="po-row">
                  <dt className="po-row__k">Status</dt>
                  <dd className="po-row__v">
                    {order.statuses.join(' · ')}
                    {order.reapproval ? (
                      <span className="po-row__flag">this order is not fully approved</span>
                    ) : null}
                  </dd>
                </div>
                <div className="po-row">
                  <dt className="po-row__k">Lines</dt>
                  <dd className="po-row__v">
                    {/* `items` counts DISTINCT item numbers, not the lines that carry
                        one, so the sentence has to name that unit. It read "73 lines on
                        1 account, 1 with an item number" for order 276626 — one item
                        number held by all 73 lines — which says the opposite of the
                        truth to anyone who reads the figure as a count of lines. */}
                    {`${pluralise(order.lineCount, 'line')} on ${pluralise(
                      order.combos,
                      'account',
                    )}${order.items === 0 ? ', none with an item number' : `, ${num(order.items)} distinct item ${order.items === 1 ? 'number' : 'numbers'}`}`}
                  </dd>
                </div>
                <div className="po-row po-row--sum">
                  <dt className="po-row__k">Committed</dt>
                  <dd className="po-row__v">{money(order.amount)}</dd>
                </div>
              </dl>
            </section>

            <section className="dsec">
              <h3 className="dsec__title">Charged to</h3>
              <p className="dsec__hint">
                From the account on each line. The project is <code>SEGMENT5</code> — the level code,
                which is the thing this application calls a project.
              </p>
              <ul className="po-levels">
                {byLevel.map(({ level: lv, name, amount: value }) => (
                  <li className="po-level" key={lv}>
                    <Link className="po-level__link" to={ordersForLevelHref(lv)}>
                      <span className="po-level__code">{lv}</span>
                      <span className="po-level__name">
                        {name || 'no name held for this level'}
                      </span>
                    </Link>
                    <span className="po-level__amt">
                      {money(value)}
                      <span className="po-level__share">
                        {pctSlim(share(value, order.amount))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              <table className="potable potable--inline">
                <caption className="sr">The accounts this order is charged to</caption>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="n">
                      Lines
                    </th>
                    <th scope="col" className="n">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byAccount.map((a) => (
                    <tr key={a.key}>
                      <td>
                        <Link
                          className="po-account"
                          to={`/funding/budgets?account=${encodeURIComponent(a.key)}`}
                          title="Open this account on the budget detail page"
                        >
                          {a.key.split('-').join('.')}
                          <span className="po-account__go">Budget detail ›</span>
                        </Link>
                      </td>
                      <td className="n">{num(a.lines)}</td>
                      <td className="n">{money(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{pluralise(byAccount.length, 'account')}</th>
                    <td className="n">{num(order.lineCount)}</td>
                    <td className="n">{money(order.amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </section>

            <section className="dsec">
              <h3 className="dsec__title">The lines</h3>
              <table className="potable potable--inline">
                <caption className="sr">Every line on this purchase order</caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Item</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="n">
                      Qty
                    </th>
                    <th scope="col" className="n">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, i) => (
                    <tr key={`${l.lineNumber}-${i}`}>
                      <td>{l.lineNumber || '—'}</td>
                      <td>{l.itemNumber || <span className="po-proj__none">none</span>}</td>
                      <td className="po-desc">{l.description || '—'}</td>
                      <td className="n">{l.quantity ? num(l.quantity) : '—'}</td>
                      <td className="n">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="po-caveat">
                {noItem > 0
                  ? `${pluralise(noItem, 'line')} on this order ${noItem === 1 ? 'carries' : 'carry'} no item number — an extract fact, not a rendering one. `
                  : ''}
                {zeroAmount > 0
                  ? `${pluralise(zeroAmount, 'line')} ${zeroAmount === 1 ? 'carries' : 'carry'} an amount of zero. `
                  : ''}
                A quantity is not comparable between a lump-sum line and a goods line, so the column is
                shown as the extract holds it and never summed across.
              </p>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
