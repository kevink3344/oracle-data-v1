import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  budTypeBadge,
  byPeriod,
  describeDerivation,
  derivationHolds,
  keyOf,
  keyOfPosition,
  latestState,
  loadBudgets,
  type BudgetRow,
  type BudgetsData,
  type BudgetType,
  type BudgetVersion,
  type Derivation,
  type PositionRow,
} from '../data/budgets';
import { inScope, scopeLabel } from '../data/scope';
import { SEGMENT_ORDER, SEGMENT_ROLE } from '../data/taxonomy';
import { useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { money, money0, num, pctSlim, pluralise, share } from '../data/format';

/**
 * Budgets — the eight million dollar question this whole app was built around.
 *
 * ── WHAT THIS SCREEN IS FOR ──────────────────────────────────────────────────
 *
 * Every other page reads a *commitment*: a purchase order, an invoice, a check.
 * They answer "what has been promised and paid". None of them can answer the only
 * question that makes those numbers meaningful — **was there money set aside for
 * it, and is any of it left**. `GL_BALANCES` holds that answer in the same table
 * as everything else, discriminated by `ACTUAL_FLAG = 'B'`, and this screen is the
 * first place in the app where a budget figure appears at all.
 *
 * ── THE FOUR NUMBERS, AND WHICH TWO ARE ARITHMETIC ──────────────────────────
 *
 *     WCPSS_BUDGET        the Capital Project Budget   (CAPITAL version 503)
 *     ALLOCATIONS_REIMB   the Appropriation            (APPROP versions 501–504)
 *     ENCUMBRANCES        committed, not yet spent
 *     EXPENDITURES        actually spent
 *     AVAILABLE_FUNDS     ── NOT STORED. ALLOC − ENC − EXP, computed by the view.
 *
 * ★ THE LAST ONE IS WHY `describeDerivation` EXISTS. A figure that is recomputed
 *   rather than read is a figure that can silently disagree with its parts, and
 *   the honest response is to check it on the data in front of the reader and say
 *   what the check found — not to print "available funds" as though it had been
 *   read out of a column like the other four.
 *
 * ★ AND THE TWO BUDGET COLUMNS ARE NOT INDEPENDENT OF THE 13 ROWS EITHER. The
 *   account positions are exactly the budget rows summed by type: measured on all
 *   four accounts, later this session, `WCPSS_BUDGET` = Σ CAPITAL rows and
 *   `ALLOCATIONS_REIMB` = Σ APPROP rows. So this screen shows one population
 *   twice — once as a position, once as its history — and the derivation panel is
 *   where those two statements are made to agree.
 *
 * ── THE NUMBER THAT SHAPES THE WHOLE SCREEN ─────────────────────────────────
 *
 *     accounts available to click           328   (the chart-of-accounts page)
 *     accounts on the invoice register       71
 *     accounts with a budget row              4
 *     invoice accounts with a budget row      1
 *
 * All four versions are assigned the same account range,
 * `04.6570.862.000.0000.0000.000` – `04.6570.862.999.9999.9999.999`, so the
 * budgeted population is exactly what sits inside one fund / purpose / program.
 *
 * ★ THAT IS WHY A LINK FROM AN INVOICE LANDS ON AN EMPTY STATE 70 TIMES OUT OF
 *   71, AND WHY THE EMPTY STATE HAS TO BE WORTH READING. The tempting alternative
 *   — render four rows and say nothing — would leave a reader who clicked
 *   `04-9000-862-541-0520-0434-000` believing this page had failed to load. The
 *   absence is a fact about the budget extract, not about the account, and the
 *   notice below says which of the two it is every time.
 */

/**
 * The two spellings of the same key.
 *
 * `V_ACCOUNT_POSITION` writes the account with dots; the budget view, the chart
 * of accounts and the invoice register all write it with dashes. A link built on
 * one page and read on another therefore has to be normalised somewhere, and this
 * is the somewhere: dots become dashes, and nothing else is touched.
 */
const normaliseKey = (raw: string): string => raw.trim().replace(/\./g, '-');

/**
 * What a keyboard can reach inside the panel, for the Tab trap.
 *
 * The same list the project, order, invoice and check panels use. It is a
 * *declaration* rather than a discovery because `tabindex` order is not DOM order;
 * filtering on `offsetParent !== null` at trap time is what keeps the controls a
 * closed `<details>` or a hidden tab panel holds out of the cycle.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the reader's chosen panel width is remembered, alongside the theme. */
const WIDTH_KEY = 'budgets-panel-w';

/**
 * Two figures agree to the cent.
 *
 * ★ NOT `===`. These come from two different sums over the same values — one
 *   taken by the database, one by the browser — and floats that arrive at the
 *   same money are not guaranteed to arrive at the same bits. An exact comparison
 *   here would report a disagreement of `1e-10` as a broken rule, which is worse
 *   than useless: it trains a reader to ignore the one check worth reading.
 */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** One labelled figure. Same reading as `.chkstat` and `.kpi`: key, number, caveat. */
function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="budstat">
      <div className="budstat__k">{label}</div>
      <div className="budstat__v">{value}</div>
      {note ? <div className="budstat__n">{note}</div> : null}
    </div>
  );
}

/** A money cell, so five columns do not repeat the same three attributes five times. */
function Money({ value }: { value: number }) {
  return <td className="n bud-num">{money(value)}</td>;
}

/**
 * Whether this account's budget arrived in one movement or several.
 *
 * ★ THIS SENTENCE IS THE POINT OF THE SECOND TABLE. A position row says
 *   `$89,828,010`; it cannot say that the number was set once in July 2022 and
 *   never revisited, or that it was assembled out of three appropriations across
 *   three fiscal years. Those are different facts about how the money was
 *   authorised, and only the period rows can tell them apart — which is exactly
 *   the reading `01-budgets.sql`'s B1 section was written to make possible.
 *
 * The unit is *periods*, not rows: two versions posting into the same period are
 * one moment of funding described twice, and counting them as two would call a
 * single decision phased.
 */
function phasing(rows: BudgetRow[]): string {
  const periods = [...new Set(rows.map((r) => r.PERIOD_NAME))];
  const first = [...rows].sort(byPeriod)[0]?.PERIOD_NAME ?? '';
  const last = [...rows].sort(byPeriod)[rows.length - 1]?.PERIOD_NAME ?? '';

  /*
   * ★ NO ROWS IS NOT "PHASED OVER ZERO PERIODS".
   *
   *   The multi-period branch used to be the fallback for every count above one, so an
   *   account with no movement row at all fell through it and rendered
   *   `phased over 0 periods,  →` — an arrow between two absent period names, which
   *   reads as a rendering fault rather than as an answer. It is reachable in the normal
   *   course of a visit: this page reads the first 200 movement rows of 69,959 and the
   *   first 200 of 1,262 positions, and the two pages need not cover the same accounts,
   *   so an account with a position and no movement here is expected, not exceptional.
   *   The versions table already has a phrase for exactly this fact.
   */
  if (rows.length === 0) return 'no budget movement on this page';

  if (periods.length === 1) {
    return `a single lump in ${first}`;
  }
  return `phased over ${num(periods.length)} periods, ${first} \u2192 ${last}`;
}

/**
 * What is odd about this account's position, in one clause — or nothing.
 *
 * ★ EVERY BRANCH HERE IS A REAL ROW IN THIS SAMPLE, NOT A DEFENSIVE CASE. The
 *   sample was built so that each of these is reachable precisely because a screen
 *   that only ever renders tidy rows is never tested against the untidy ones:
 *
 *     - `04-…-532-…` is appropriated **above** its capital budget ($541,624.93
 *       against $287,468) — a reallocation the capital version never caught up
 *       with, or a capital budget that was reduced after the appropriation was
 *       made. The page states which, as far as the columns allow.
 *     - `04-…-526-…` has **nothing available** while its expenditures exceed its
 *       capital budget. Read alone that looks like an error; it is a budget that
 *       was fully committed, which is a different and mundane fact.
 *
 * A reader who finds either without a label decides the page is broken, so the
 * label matters more than the tidiness of the table.
 */
function shortfall(p: PositionRow): string | null {
  const budget = Number(p.WCPSS_BUDGET) || 0;
  const alloc = Number(p.ALLOCATIONS_REIMB) || 0;
  const enc = Number(p.ENCUMBRANCES) || 0;
  const exp = Number(p.EXPENDITURES) || 0;
  const avail = alloc - enc - exp;

  if (budget === 0 && alloc === 0) return 'no capital budget and no appropriation';
  if (alloc > budget) return `appropriated ${money0(alloc - budget)} above the capital budget`;
  if (exp > budget) return `spent ${money0(exp - budget)} beyond the capital budget`;
  if (near(avail, 0) && enc + exp > 0) return 'fully committed — nothing left to spend';
  if (enc === 0 && exp === 0) return 'nothing committed and nothing spent';
  return null;
}

/**
 * One account, in the three pieces this page holds of it.
 *
 * The position row is the money; the budget rows are where that money came from,
 * in period order. Both are keyed by the same code combination and the page pairs
 * them by key, so the object is the natural unit — and it is what the row that
 * opens belongs to.
 */
interface Account {
  key: string;
  position: PositionRow;
  rows: BudgetRow[];
}

/**
 * How many distinct values one segment takes across the accounts on this page.
 *
 * ★ THE NUMBER IS RELATIVE TO THIS SCREEN, AND THE SCREEN HAS TO SAY SO. On the
 *   combination page `distinct` is measured over the *filtered* combinations, so
 *   a `1` there means "the filter pinned this segment". Here it is measured over
 *   the accounts that hold a budget row, so a `1` means "a budgeted account is
 *   spelled this way, always" — which is what lets the detail say that these four
 *   differ only in segment 4. Neither is the number of values the segment takes
 *   on the chart of accounts. Printing such a count with no denominator is how a
 *   reader concludes a segment is fixed when it is not.
 */
interface SegmentSpread {
  name: string;
  distinct: number;
}

/**
 * ★ MONEY FIRST. The order here is the tab order *and* the default, and it is
 *   deliberate: this panel only exists because a row on a table of budget
 *   figures was clicked, so the question that brought the reader here is what
 *   the account was given and what is left of it. The seven segments are the
 *   answer to a question they ask *next* — usually to find out which part of the
 *   code they would have to change. Leading with the codes meant every open
 *   landed on a table of seven rows that answered a question nobody had asked
 *   yet, and the balance a click away behind it.
 */
const DETAIL_TABS = [
  { id: 'funds', label: 'Fund breakdown' },
  { id: 'general', label: 'General information' },
] as const;

type DetailTab = (typeof DETAIL_TABS)[number]['id'];

/**
 * Whether a figure agreed with the rows it is made of.
 *
 * Both states render. A check whose failure mode is silence is not a check, and
 * the whole reason this page recomputes the budget columns in the browser is so a
 * disagreement shows up rather than being smoothed away.
 */
function Agrees({ ok }: { ok: boolean }) {
  return (
    <span className="budcheck__ok" data-ok={String(ok)}>
      {ok ? 'agrees' : 'does not agree'}
    </span>
  );
}

/**
 * The detail for one budgeted account, as two tabs.
 *
 * ── WHY TWO TABS AND NOT ONE COLUMN OF EVERYTHING ───────────────────────────
 *
 * An account is two different things at once. It *is* a code combination — seven
 * segments, one of which is the thing a project is named after — and it *has* a
 * budget assembled out of movements belonging to two kinds of version. The first
 * is a table of the key; the second is money. Printed one after the other they
 * read as a single undifferentiated block: a reader asking "is there anything
 * left" walks past seven rows of codes, and a reader asking "whose project is
 * this" walks past five figures. The strip is the statement that these are two
 * questions, and it is a real `tablist` — arrow keys move between the two, and
 * `aria-selected` says which one is showing. Money leads; see `DETAIL_TABS` for
 * why the order is the way round it is.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not repeat the deep-link panel or the page's own tables. Every figure
 * in the fund tab is that *one* account's, and the movement rows are that
 * account's slice of the timeline below — nothing here is a summary of the page.
 *
 * ── WHAT IT DOES NOT OWN, NOW THAT IT LIVES IN A PANEL ──────────────────────
 *
 * Neither its own heading nor its own close button. The account key, the phasing
 * sentence and the `×` belong to the drawer's head, because that is where the
 * identity of what is open belongs — and skipping them here is what stops the key
 * appearing twice in one panel. The `Account combinations ›` cross-reference is in
 * the drawer's foot for the same reason: it is the panel's one outbound link, not
 * the detail's. What is left in this component is exactly the part that is *about
 * the account* rather than about the panel showing it.
 */
function AccountDetail({
  account,
  count,
  combosOnChart,
  spread,
  derivation,
  versionById,
  typeById,
}: {
  account: Account;
  count: number;
  combosOnChart: number;
  spread: SegmentSpread[];
  derivation?: Derivation;
  versionById: Map<number, BudgetVersion>;
  typeById: Map<number | null, BudgetType>;
}) {
  // Defaults to the first tab in `DETAIL_TABS` rather than to a literal, so the
  // strip and the default cannot drift apart if the order is ever changed again.
  const [tab, setTab] = useState<DetailTab>(DETAIL_TABS[0].id);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /** Stable ids: the key has dots, dashes and digits, none of which an id wants. */
  const slug = account.key.replace(/[^0-9a-zA-Z]+/g, '');
  const id = (part: string) => `bud-${slug}-${part}`;

  const p = account.position;
  const segments = account.key.split('-');
  const fixed = spread.filter((s) => s.distinct === 1);
  const moving = spread.filter((s) => s.distinct > 1);

  /** Roving focus across the strip, which is what a tablist owes a keyboard. */
  const move = (from: DetailTab, delta: number) => {
    const i = DETAIL_TABS.findIndex((t) => t.id === from);
    const next = DETAIL_TABS[(i + delta + DETAIL_TABS.length) % DETAIL_TABS.length];
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const rowsTotal = account.rows.reduce((s, r) => s + (Number(r.NET_AMOUNT) || 0), 0);
  const balanceRows = account.rows.reduce((s, r) => s + (Number(r.BALANCE_ROWS) || 0), 0);

  return (
    <div className="buddet">
      <div className="buddet__head">
        <div className="buddet__tabs" role="tablist" aria-label={`Detail for ${account.key}`}>
          {DETAIL_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={id(`tab-${t.id}`)}
              className="buddet__tab"
              aria-selected={tab === t.id}
              aria-controls={id(`panel-${t.id}`)}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  move(t.id, 1);
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  move(t.id, -1);
                } else if (e.key === 'Home' || e.key === 'End') {
                  // The APG puts Home on the first tab and End on the last, so
                  // these follow `DETAIL_TABS` too and survived the reorder.
                  e.preventDefault();
                  const edge =
                    e.key === 'Home'
                      ? DETAIL_TABS[0]
                      : DETAIL_TABS[DETAIL_TABS.length - 1];
                  setTab(edge.id);
                  tabRefs.current[edge.id]?.focus();
                }
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'general' ? (
        <div
          id={id('panel-general')}
          role="tabpanel"
          aria-labelledby={id('tab-general')}
          tabIndex={-1}
          className="buddet__panel"
        >
          <h4 className="buddet__h">The seven segments of this account</h4>
          <div className="buddet__cols">
            <table className="segs">
              <caption className="sr">
                The seven segments of {account.key}, what each one holds, the value this account
                carries, and how many distinct values the segment takes across the accounts on this
                page.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Value</th>
                  <th scope="col" className="n">
                    Distinct
                  </th>
                </tr>
              </thead>
              <tbody>
                {SEGMENT_ORDER.map((name, i) => (
                  <tr key={name}>
                    <th scope="row">
                      {name.replace('_', '')}
                      <span className="segs__role">{SEGMENT_ROLE[name]}</span>
                    </th>
                    <td>
                      <code>{segments[i] ?? ''}</code>
                      {(spread[i]?.distinct ?? 0) === 1 ? (
                        <span className="segs__const">fixed</span>
                      ) : null}
                    </td>
                    <td className="n">{num(spread[i]?.distinct ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="buddet__text">
              <p className="buddet__p">
                <strong>
                  {num(fixed.length)} of the seven segments are fixed across the{' '}
                  {pluralise(count, 'account')} this page holds
                </strong>
                , so {moving.length === 0 ? 'every account here is spelled identically' : 'they differ only in '}
                {moving.map((s) => s.name.replace('_', '')).join(' and ')}.
              </p>
              <p className="buddet__p">
                The <em>distinct</em> column counts values over <em>that</em> set — {pluralise(count, 'account')} —
                and not over the {num(combosOnChart)} combinations on the chart of accounts. A segment can
                be fixed here and take hundreds of values there, and it usually is: what a budget
                account has in common is the fund and the program it was authorised under, not
                anything about the code.
              </p>
              <p className="chart-note">
                Oracle writes this key with dots in <code>V_ACCOUNT_POSITION</code> and with dashes
                in <code>V_BUDGET_BY_ACCOUNT_PERIOD</code>. Both name the same combination, which is
                why a link may arrive spelled either way.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div
          id={id('panel-funds')}
          role="tabpanel"
          aria-labelledby={id('tab-funds')}
          tabIndex={-1}
          className="buddet__panel"
        >
          <h4 className="buddet__h">What this account was given, and what is left of it</h4>
          <div className="buddet__grid">
            <Stat
              label="Capital budget"
              value={money(p.WCPSS_BUDGET)}
              note="from the CAPITAL version"
            />
            <Stat
              label="Appropriations"
              value={money(p.ALLOCATIONS_REIMB)}
              note="from the APPROP versions"
            />
            <Stat
              label="Encumbrances"
              value={money(p.ENCUMBRANCES)}
              note="committed, not yet spent"
            />
            <Stat label="Expenditures" value={money(p.EXPENDITURES)} note="actually spent" />
            <Stat
              label="Available funds"
              value={money(p.AVAILABLE_FUNDS)}
              note="appropriations less both"
            />
          </div>

          {derivation ? (
            <>
              <h4 className="buddet__h">The two budget columns, checked against the movements</h4>
              <table className="segs budcheck">
                <caption className="sr">
                  Each budget figure on {account.key} checked against the rows it is made of.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Figure</th>
                    <th scope="col" className="n">
                      Here
                    </th>
                    <th scope="col">Made of</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">
                      Capital budget
                      <span className="segs__role">the CAPITAL version's rows</span>
                    </th>
                    <td className="n">{money(derivation.capitalFromView)}</td>
                    <td>
                      {money(derivation.capitalFromRows)} of CAPITAL movements
                      <Agrees ok={near(derivation.capitalFromView, derivation.capitalFromRows)} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      Appropriations
                      <span className="segs__role">the APPROP versions' rows</span>
                    </th>
                    <td className="n">{money(derivation.appropFromView)}</td>
                    <td>
                      {money(derivation.appropFromRows)} of APPROP movements
                      <Agrees ok={near(derivation.appropFromView, derivation.appropFromRows)} />
                    </td>
                  </tr>
                  {derivation.uncolumned.length > 0 ? (
                    <tr className="budcheck__loose">
                      <th scope="row">
                        In neither column
                        <span className="segs__role">rows of another budget type</span>
                      </th>
                      <td className="n">—</td>
                      <td>{derivation.uncolumned.join(', ')}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <p className="chart-note">
                Available funds have no row to be checked against because none holds them: the view
                computes <code>{money(p.ALLOCATIONS_REIMB)}</code> less{' '}
                <code>{money(p.ENCUMBRANCES)}</code> less <code>{money(p.EXPENDITURES)}</code> ={' '}
                <strong>{money(derivation.availableFromColumns)}</strong>, and the position view
                reports <strong>{money(derivation.availableFromView)}</strong>.
                <Agrees ok={near(derivation.availableFromColumns, derivation.availableFromView)} />
              </p>
            </>
          ) : null}

          <h4 className="buddet__h">Where the money came from</h4>
          <div className="table-wrap">
            <table className="data budtable budtable--periods">
              <caption className="sr">
                Every budget row booked to {account.key}, oldest period first, with the version and
                budget type each movement belongs to.
              </caption>
              <colgroup>
                <col className="c-period" />
                <col className="c-version" />
                <col className="c-type" />
                <col className="c-rows" />
                <col className="c-amount" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Version</th>
                  <th scope="col">Budget type</th>
                  <th scope="col" className="n">
                    Rows
                  </th>
                  <th scope="col" className="n">
                    Movement
                  </th>
                </tr>
              </thead>
              <tbody>
                {account.rows.map((r, i) => {
                  const v = versionById.get(r.BUDGET_VERSION_ID);
                  const t = v ? typeById.get(v.BUDGET_TYPE_ID) : undefined;
                  const badge = budTypeBadge(t);
                  return (
                    <tr key={`${r.BUDGET_VERSION_ID}-${r.PERIOD_NAME}-${i}`}>
                      <td className="bud-period">
                        {r.PERIOD_NAME}
                        <span className="bud-period__num">
                          Y{r.PERIOD_YEAR} · P{String(r.PERIOD_NUM).padStart(2, '0')}
                        </span>
                      </td>
                      <td>
                        {r.BUDGET_VERSION_ID}
                        {v ? <span className="bud-version__name">{v.BUDGET_NAME}</span> : null}
                      </td>
                      <td>
                        {badge.label ? (
                          <span className={`budtype budtype--${badge.modifier}`}>
                            {badge.label}
                          </span>
                        ) : (
                          <span className="budtype">—</span>
                        )}
                      </td>
                      <td className="n bud-num">{num(r.BALANCE_ROWS)}</td>
                      <td className="n bud-num bud-num--move">{money(r.NET_AMOUNT)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">
                    All {pluralise(account.rows.length, 'movement')}
                    <span className="budacct__when">
                      the CAPITAL and APPROP rows added together
                    </span>
                  </th>
                  <td colSpan={2}>
                    <span className="buddet__phase">{phasing(account.rows)}</span>
                  </td>
                  <td className="n bud-num">{num(balanceRows)}</td>
                  <td className="n bud-num bud-num--move">{money(rowsTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The budget detail, as a panel that slides in from the right.
 *
 * ── WHY IT LEFT THE TABLE ───────────────────────────────────────────────────
 *
 * The detail used to open as a second `<tr>` under its own account, spanning all
 * six columns. That was honest and it had one fault no amount of styling fixes: the
 * six money columns are the only thing on this page meant to be read *against each
 * other*, and opening a full-width row between two of them pushes them apart. On a
 * table that already scrolls sideways, the columns the reader was comparing leave
 * the screen at exactly the moment they asked a question about one of them.
 *
 * A panel is also the shape the rest of this app already answers a question about
 * one record in: the project, purchase-order, invoice and check drawers all do
 * this, with the same Escape, the same Tab trap, the same remembered width and the
 * same hand-back of focus on close. Reusing `.drawer` rather than inventing a
 * second slide-out is what makes this one behave like the others without anyone
 * having to learn it again.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE PANEL'S HEAD ────────────────────────────
 *
 * The tab strip is the first thing in the body, because the tabs switch the body.
 * The `Account combinations ›` link sits in the foot, which is where every other
 * panel in the app keeps its one cross-reference. The head holds the *identity* of
 * what is open — the key, in mono and allowed to wrap a character at a time, and
 * the phasing sentence, which is the one fact about the account that fits in one.
 *
 * ★ THE OPEN ROW KEEPS ITS HIGHLIGHT, AND THAT IS WHAT THE HIGHLIGHT IS FOR. The
 *   panel covers the right of the table but not the account column, so the reader
 *   can always see which of these accounts they are reading — including while
 *   scrolling the panel's own body, which is a thing a modal cannot do for them.
 *   The panel takes focus and locks the page's scroll, so the row is not reachable
 *   by click while it is open; the highlight is a label, not a second control.
 *
 * ★ `aria-expanded` IS ON THE ACCOUNT BUTTON *AND* `aria-haspopup="dialog"`, which
 *   is the pair the APG specifies for a control that opens a dialog. The panel
 *   itself is `aria-hidden` when shut rather than unmounted, so the exit transition
 *   has something to animate — the same trick the project drawer uses, and the
 *   reason `AccountDetail` may receive a `null` account on the first frame.
 */
function BudgetPanel({
  account,
  open,
  onClose,
  count,
  combosOnChart,
  spread,
  derivation,
  versionById,
  typeById,
}: {
  account: Account | null;
  open: boolean;
  onClose: () => void;
  count: number;
  combosOnChart: number;
  spread: SegmentSpread[];
  derivation?: Derivation;
  versionById: Map<number, BudgetVersion>;
  typeById: Map<number | null, BudgetType>;
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

  /**
   * The opener is captured on the way in and re-focused on the way out.
   *
   * ★ IT HAS TO BE CAPTURED HERE AND NOT PASSED IN. The account cell's button is
   *   the element the reader is standing on when the panel opens, and by the time
   *   the close runs, `document.activeElement` is inside the panel — so the only
   *   moment this can be read is the commit that opens it. This is also what
   *   replaced the hand-written focus line the inline version needed: the row's
   *   toggle no longer has to be tracked in a ref map because the browser already
   *   told us what had focus.
   */
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  /* Separate from the effect above on purpose: on the first open `account` is
     still null in that same commit, so focusing here would land on nothing and
     leave focus outside the dialog. */
  useEffect(() => {
    if (open && account) closeRef.current?.focus();
  }, [open, account]);

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

  const style = width ? ({ '--drawer-w': `${clampWidth(width)}px` } as CSSProperties) : undefined;
  const odd = account ? shortfall(account.position) : null;

  return (
    <div
      className={`drawer budpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      ref={panelRef}
      id="budget-detail"
      style={style}
      aria-hidden={!open}
      role="dialog"
      aria-label={account ? `Budget detail for ${account.key}` : 'Budget detail'}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="budget-detail"
        label="Resize the budget detail panel"
      />

      <div className="drawer__head">
        <div>
          <p className="drawer__eyebrow">Budget account</p>
          <h2 className="drawer__name budpanel__key">{account?.key ?? '—'}</h2>
          {account ? (
            <p className="drawer__meta">
              {phasing(account.rows)}
              {odd ? <> · {odd}</> : null}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="drawer__close"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close the budget detail"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        {account ? (
          <AccountDetail
            account={account}
            count={count}
            combosOnChart={combosOnChart}
            spread={spread}
            derivation={derivation}
            versionById={versionById}
            typeById={typeById}
          />
        ) : null}
      </div>

      <div className="drawer__foot">
        {account ? (
          <Link
            className="buddet__link"
            to={`/coa/combinations?combo=${encodeURIComponent(account.key)}`}
            title={`Open ${account.key} on the chart of accounts, where every row booked to it lives`}
          >
            Account combinations ›
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export default function Budgets() {
  const [data, setData] = useState<BudgetsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /**
   * The account whose detail is showing in the panel, or `null`.
   *
   * ★ ONE AT A TIME, AND THAT IS A PROPERTY OF THE PANEL RATHER THAN A CHOICE. The
   *   panel is a dialog: it takes focus, it locks the page's scroll, and there is
   *   one of them. So "which account is open" is one key and not a set, and the
   *   row's `aria-expanded` a reliable answer to it. Deliberately not derived from
   *   `wanted`: a deep link decides which row is *highlighted*, and a reader who
   *   opens a different account has changed their mind about what they are reading.
   *   `wanted` seeds it on arrival and nothing more (see the effect below).
   */
  const [openKey, setOpenKey] = useState<string | null>(null);

  /** The accounts list, so the absent-account panel can hand focus to it. */
  const accountsRef = useRef<HTMLDivElement | null>(null);

  const [params, setParams] = useSearchParams();
  const { scope, scopeTenant, combos } = useStore();

  /**
   * The account a link asked for, in whichever spelling the link used.
   *
   * `combo` is the parameter the chart-of-accounts page uses and the parameter
   * links from elsewhere in the app carry. `account` is accepted as well because
   * the invoice panel's own vocabulary is an account, and a link that works or
   * not depending on which name the author of the link had in mind is a link
   * nobody can debug.
   */
  const rawWanted = (params.get('combo') ?? params.get('account') ?? '').trim();
  const wanted = normaliseKey(rawWanted);

  /* The retry button increments this; the effect below reads it, so pressing
     "Try again" is one state change rather than a second code path. */
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setError(null);

    loadBudgets(controller.signal)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setData(null);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [attempt]);

  /**
   * Drop the `?combo=` (and any `?account=`) without leaving the page.
   *
   * ★ THE FOCUS LINE IS THE SAME FIX AS `setRow`'S, FOR THE SAME REASON. The only
   *   caller is the "Show the N that do" button, and it lives inside the panel
   *   that its own click removes — so without this the focused element is gone by
   *   the time the commit lands and the browser drops focus to `<body>`, leaving
   *   the next Tab to restart at the top of the document. The accounts list is
   *   already mounted while the panel is showing (the panel is a sibling, not a
   *   replacement), so it can take focus synchronously, and it is the right
   *   destination: it is what the reader just asked to see.
   */
  const clearFocus = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('combo');
    next.delete('account');
    setParams(next, { replace: true });
    accountsRef.current?.focus();
  }, [params, setParams]);

  /**
   * The account scope, applied to this page's own rows.
   *
   * ★ WHICH IS POSSIBLE HERE AND NOT ON THE OTHER TWO API-BACKED REGISTERS. The
   *   scope's rule needs a fund and a program, and the budget rows carry both
   *   (segments 1 and 3). The checks and activity registers carry neither, which
   *   is why they print a note saying the scope cannot reach them. This page can
   *   honour the control, so it does.
   *
   * ★ BUT APPLYING IT HERE IS THE SECOND TIME, NOT THE FIRST — WHICH IS WHY THE
   *   NOTE BELOW HAD TO CHANGE. The API composes `/api/funding/budgets` and
   *   `/api/funding/positions` with the tenant's own scope (`tenantScope` in
   *   `server/src/db/derived.ts`), so under `DB_MODE=oracle` the payload has
   *   *already* been narrowed by the time it lands and this filter removes
   *   nothing. The old rule — print the cost, and only when it cost something —
   *   then made the page silent about the one thing it can honour, which is the
   *   worst of both: measured, `removed` is 0 on every visit, so the note that
   *   was supposed to disclose the scope never rendered once. It stays anyway
   *   (it is the *cost* side, and it fires the moment a reader narrows the
   *   control), and `scopeObserved` below is its complement.
   */
  const inScopeRows = useMemo(() => {
    if (!data) return { budgets: [] as BudgetRow[], positions: [] as PositionRow[], removed: 0 };
    const budgets = data.budgets.filter((r) => inScope(scope, r.SEGMENT1, r.SEGMENT3));
    const positions = data.positions.filter((p) => {
      const parts = p.BUDGET_ACCOUNT.split('.');
      return inScope(scope, parts[0] ?? '', parts[2] ?? '');
    });
    return { budgets, positions, removed: data.positions.length - positions.length };
  }, [data, scope]);

  /**
   * What the scope *is*, read off the rows rather than restated from the tenant.
   *
   * ★ THE COMPLEMENT OF `inScopeRows.removed`, AND THE SAME DOCTRINE THE VENDOR
   *   REGISTER USES. A page whose data source applies a scope has two things to
   *   say and the cost sentence is only one of them: **what was asked for** and
   *   **what the rows actually carry**. Printing the first alone describes an
   *   intention; this is the second, derived at render time so it cannot drift.
   *
   * ★ TWO BASES, ONE CLAIM EACH, AND THEY ARE DELIBERATELY DIFFERENT.
   *   `accounts` and `movements` come off `inScopeRows` — the rows the tables
   *   *below* are built from — so the pairs can never contradict the table the
   *   reader is looking at when they have narrowed the control. `absentPrograms`
   *   comes off `data`, the API's own scoped payload, because the control cannot
   *   make a program absent: a program missing from the *served* payload is a
   *   fact about this ledger, while a program missing from the filtered rows is
   *   usually just the reader's own selection. It is also keyed on the
   *   *organization's* programs rather than the current selection, so narrowing
   *   the chips to 862 does not turn 861 into a false "absent".
   *
   * ★ AND THE CLAIM IS SCOPED TO THE WINDOW, DELIBERATELY. Both registers are
   *   served one page at a time (`loadBudgets` asks for 200 of a 1,262-account /
   *   69,959-row population), so the strongest thing these rows can support is
   *   "absent from what was read" — which is why the note says *in none of the
   *   {n} accounts read* and not *this ledger has two programs*. The wider
   *   statement is checked by the page's own truncation notice, which is where a
   *   reader learns the payload was a page; a note that made the ledger-wide
   *   claim from a 200-row window would be a measurement wearing a conclusion.
   *
   * ★ MEASURED, and the measurement is the reason the note is worth printing.
   *   Over the whole scoped position view (1,262 accounts, not the 200 read):
   *   **1,177 accounts carry program 862, 85 carry 861, and 863 holds 0** — the
   *   second figure confirmed independently by `?q=863`, which answers
   *   `total: 0`. The two `86x` counts sum to the total exactly, so the split is
   *   a partition and not a coincidence of substring matching. **The scope names
   *   three programs and this ledger has only ever had two of them** — a reader
   *   who takes the chips for the data would otherwise be entitled to wonder what
   *   else is missing.
   */
  const scopeObserved = useMemo(() => {
    if (!data) return null;

    /** `['04/862 (419)', '04/861 (81)']` — each pair with the rows that carry it. */
    const listed = (pairs: string[]) => {
      const counts = new Map<string, number>();
      for (const pair of pairs) counts.set(pair, (counts.get(pair) ?? 0) + 1);
      return [...counts.entries()].sort().map(([pair, n]) => `${pair} (${n})`);
    };

    const accountPair = (p: PositionRow) => {
      const parts = p.BUDGET_ACCOUNT.split('.');
      return `${parts[0] ?? ''}/${parts[2] ?? ''}`;
    };

    // What the ledger served, before this page's own filter: the basis for saying a
    // program is absent from the data rather than absent from the screen.
    const carried = new Set([
      ...data.positions.map((p) => p.BUDGET_ACCOUNT.split('.')[2] ?? ''),
      ...data.budgets.map((r) => String(r.SEGMENT3 ?? '')),
    ]);

    return {
      accounts: listed(inScopeRows.positions.map(accountPair)),
      movements: listed(inScopeRows.budgets.map((r) => `${r.SEGMENT1}/${r.SEGMENT3}`)),
      absentPrograms: (scopeTenant?.programs ?? []).filter((p) => !carried.has(p)),
    };
  }, [data, inScopeRows, scopeTenant]);

  const view = useMemo(() => {
    const rowsByKey = new Map<string, BudgetRow[]>();
    for (const row of inScopeRows.budgets) {
      const key = keyOf(row);
      rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
    }
    for (const [key, rows] of rowsByKey) rowsByKey.set(key, [...rows].sort(byPeriod));

    const versionById = new Map((data?.versions ?? []).map((v) => [v.BUDGET_VERSION_ID, v]));
    const typeById = new Map((data?.types ?? []).map((t) => [t.BUDGET_TYPE_ID, t]));

    /**
     * The accounts, in account order.
     *
     * Ordered by the account key rather than by any money column: the four
     * accounts differ only in segment 4, so account order is the order they were
     * authorised in and it does not move when a figure changes. A table that
     * reorders itself because an expenditure landed is a table a reader has to
     * re-read from the top every time.
     */
    const accounts = [...inScopeRows.positions]
      .map((p) => {
        const key = keyOfPosition(p);
        return { key, position: p, rows: rowsByKey.get(key) ?? [] };
      })
      .sort((a, b) => a.key.localeCompare(b.key));

    const totals = accounts.reduce(
      (acc, a) => ({
        budget: acc.budget + (Number(a.position.WCPSS_BUDGET) || 0),
        allocations: acc.allocations + (Number(a.position.ALLOCATIONS_REIMB) || 0),
        encumbrances: acc.encumbrances + (Number(a.position.ENCUMBRANCES) || 0),
        expenditures: acc.expenditures + (Number(a.position.EXPENDITURES) || 0),
        available: acc.available + (Number(a.position.AVAILABLE_FUNDS) || 0),
      }),
      { budget: 0, allocations: 0, encumbrances: 0, expenditures: 0, available: 0 },
    );

    const rowTotal = inScopeRows.budgets.reduce((s, r) => s + (Number(r.NET_AMOUNT) || 0), 0);
    const periods = [...new Set(inScopeRows.budgets.map((r) => r.PERIOD_NAME))].sort();

    return { accounts, rowsByKey, versionById, typeById, totals, rowTotal, periods };
  }, [data, inScopeRows]);

  /** The deep link, resolved against the accounts actually present. */
  const requested = useMemo(
    () => (wanted ? view.accounts.find((a) => a.key === wanted) ?? null : null),
    [view.accounts, wanted],
  );

  /**
   * A deep link opens its own row — once.
   *
   * Arriving at `?account=…` from the invoice register should land on that
   * account's detail, not merely highlight a row and leave the reader to guess
   * that there is anything under it. The guard makes it a one-shot: a reader who
   * then closes the row, or opens a different one, must not be overruled by an
   * effect deciding the URL knows better.
   *
   * ★ THE TOKEN IS SPENT ONLY ONCE THE ACCOUNT HAS RESOLVED, AND THAT ORDER IS
   *   THE WHOLE TRICK. The first render happens before the five budget endpoints
   *   answer, so `view.accounts` is empty and `requested` is null — and an effect
   *   that marked `wanted` as seeded on that render would find, when the rows
   *   finally arrived, that the URL had already been dealt with. The row would
   *   highlight and never open, which is precisely the state this effect exists to
   *   prevent. Waiting for `requested` first costs nothing when the account has a
   *   budget row and is a no-op when it does not.
   */
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || seeded.current === wanted) return;
    if (!requested) return;
    seeded.current = wanted;
    setOpenKey((current) => current ?? wanted);
  }, [wanted, requested]);

  const derivations = useMemo(() => (data ? describeDerivation(data) : []), [data]);
  const derivationsOk = derivations.length > 0 && derivations.every(derivationHolds);

  /**
   * What this ledger does not answer about versions, read off the rows.
   *
   * ★ DERIVED FROM THE DATA, NOT FROM A MODE FLAG. `DB_MODE` would be a one-line check and
   *   the wrong one: it names which store answered, not which columns came back, and the two
   *   are only correlated because this deployment happens to be the thin one. Reading the rows
   *   means a store that fills some version columns leaves this null and the page goes on
   *   describing its versions normally — and if the ledger ever starts serving budget types,
   *   the note retires itself with no code change. `null` also covers "no version rows came
   *   back at all", which needs no note because the table is empty and says so.
   */
  const ledgerGap = useMemo(() => {
    const versions = data?.versions ?? [];
    if (versions.length === 0) return null;
    const gap = {
      type: versions.every((v) => v.BUDGET_TYPE_ID === null),
      span: versions.every((v) => v.FIRST_PERIOD_NAME === null && v.LAST_PERIOD_NAME === null),
      status: versions.every((v) => v.STATUS_CODE === null),
      latest: versions.every((v) => v.LATEST_FLAG === null),
    };
    return gap.type || gap.span || gap.status || gap.latest ? gap : null;
  }, [data]);

  /** The derivation check for the one account a row belongs to. */
  const derivationByKey = useMemo(
    () => new Map(derivations.map((d) => [d.key, d])),
    [derivations],
  );

  /**
   * How many distinct values each segment takes across the accounts on this page.
   *
   * ★ MEASURED HERE BECAUSE NOWHERE ELSE CAN. The combination page's `distinct`
   *   describes a filtered set the reader chose; this one describes the budget
   *   population itself, which is what makes "four accounts that differ only in
   *   segment 4" a checkable statement rather than a claim about the extract.
   *   Both numbers are honest and they are not the same number, so the panel says
   *   which set it counted.
   */
  const spread = useMemo<SegmentSpread[]>(() => {
    const parts = view.accounts.map((a) => a.key.split('-'));
    return SEGMENT_ORDER.map((name, i) => ({
      name,
      distinct: new Set(parts.map((p) => p[i] ?? '')).size,
    }));
  }, [view.accounts]);

  /**
   * Open or close one account's detail.
   *
   * ★ THIS IS NOW ONLY STATE, AND THAT IS THE WHOLE DIFF. It used to move focus by
   *   hand: the inline panel was closed by a *Hide* button living inside the thing
   *   being removed, so the focused element was gone by the time the commit landed
   *   and the browser had dropped focus to `<body>`. `BudgetPanel` captures its
   *   opener on the way in and restores it on the way out, which is the same fix
   *   done in the one place that can do it for every panel in this app — so a
   *   hand-rolled focus line here would now be a second, contradicting answer.
   */
  const setRow = useCallback((key: string, open: boolean) => {
    setOpenKey(open ? key : null);
  }, []);

  /** Stable, because `BudgetPanel` lists it as a dependency of its key handler. */
  const closePanel = useCallback(() => setOpenKey(null), []);

  /**
   * The one account the panel is describing, looked up rather than held.
   *
   * ★ RESOLVED FROM `view.accounts` ON EVERY RENDER INSTEAD OF STORED AS AN OBJECT.
   *   `openKey` is a string, so changing the scope re-resolves it against the new
   *   population: an account the scope has just removed closes its own panel rather
   *   than leaving a dialog describing a row that is no longer on the page. Holding
   *   the account object would keep the stale copy alive, and the panel's `open` is
   *   therefore "the account resolved" rather than "a key is set" — the two differ
   *   in exactly that case.
   */
  const openAccount = useMemo(
    () => (openKey ? view.accounts.find((a) => a.key === openKey) ?? null : null),
    [openKey, view.accounts],
  );

  /**
   * The assignment range, as one sentence and one pair of bounds.
   *
   * Read off the data rather than written down: the range is a property of the
   * four budget versions in *this* ledger, and a page that hard-coded
   * `04.6570.862.…` would keep claiming it after the versions moved. Where the
   * versions disagree the sentence says so, because "all four cover the same
   * range" is the fact that explains the population and it is worth being wrong
   * out loud about.
   */
  const assignment = useMemo(() => {
    const list = data?.assignments ?? [];
    if (list.length === 0) return { from: '', to: '', same: false, count: 0 };
    const same = list.every((a) => a.RANGE_FROM === list[0]?.RANGE_FROM && a.RANGE_TO === list[0]?.RANGE_TO);
    return { from: list[0]?.RANGE_FROM ?? '', to: list[0]?.RANGE_TO ?? '', same, count: list.length };
  }, [data]);

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Budgets</h1>
            <p className="page-head__sub">
              {data
                ? `What was set aside, against ${pluralise(view.accounts.length, 'account')} — ${num(inScopeRows.budgets.length)} budget rows across ${pluralise(view.periods.length, 'period')} and ${pluralise(data.versions.length, 'version')}. Housing the capital budget, the appropriations against it, and what is left of them.`
                : 'The capital budget, the appropriations against it, and what is left of them.'}
            </p>
          </div>
        </div>
      </div>

      {/*
        ★ THE PAGE STATES ITS SCOPE, WHICH IS THE ONE THING A READER CANNOT
          DERIVE FROM THE SCREEN.

        This is the vendor register's note, on the same terms: the flag carries
        the fact, the body carries the ask (`scopeLabel`, which reads the control)
        and then the answer (`scopeObserved`, which reads the rows). Neither half
        is decoration — the scope is applied *in the ledger query*, so nothing on
        this page would otherwise reveal that 69,959 budget rows and 1,262
        accounts are a subset rather than a total.

        ★ THE PROSE IS WRAPPED, AND THAT IS NOT COSMETIC. `.scopenote` is
          `display: flex; gap: 8px`, so a bare text node beside the flag becomes
          its own flex item and the gap lands between the fragments instead of
          between the flag and the sentence. `.scopenote__text` is the item.

        ★ IT RENDERS ON EVERY VISIT AND THE COST NOTE BELOW DOES NOT. Two
          different questions: "what is this page scoped to" is always true and
          always owed, while "what did the scope cost" is only owed when it cost
          something — a sentence reading "0 rows removed" on every visit is how a
          reader learns to skip the one place the number is not zero. Keeping
          only the second was the bug: it is invisible exactly when the narrowing
          happened upstream, which is every visit to this page.
      */}
      {data && scopeObserved ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Scoped</span>
          <span className="scopenote__text">
            <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}.</strong> The rule is applied in
            the ledger query rather than in the browser —{' '}
            <code>/api/funding/budgets</code> and <code>/api/funding/positions</code> are composed
            with it by the API, so the rows arrive narrowed and{' '}
            {inScopeRows.removed === 0
              ? 'nothing on this page advertises it.'
              : 'this page narrows them further, which the note below puts a number on.'}{' '}
            Read off the rows that came back — {num(data.positions.length)} budgeted accounts and{' '}
            {num(data.budgets.length)} budget rows, one page of each — the accounts here are{' '}
            <strong>{scopeObserved.accounts.join(', ')}</strong> and the budget rows are{' '}
            <strong>{scopeObserved.movements.join(', ')}</strong>. The control above is what is
            asked for; this is what the answer carries.{' '}
            {scopeObserved.absentPrograms.length > 0 ? (
              <>
                <strong>
                  Program {scopeObserved.absentPrograms.join(', ')} is among this organization’s
                  programs and appears in none of the {num(data.positions.length)} accounts read
                </strong>{' '}
                — no account and no budget row came back under it, so its absence is the ledger’s
                rather than the screen’s.
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {/* The cost side, and still only owed where it cost something. Renders only
          once a reader narrows the control further than the ledger already did —
          measured: 0 on every default visit, which is exactly why the note above
          had to be written. */}
      {data && inScopeRows.removed > 0 ? (
        <p className="scopenote scopenote--removed" role="note">
          <span className="scopenote__flag">{num(inScopeRows.removed)} accounts removed</span> The{' '}
          <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}</strong> scope removed{' '}
          {num(inScopeRows.removed)} of{' '}
          {num(data.positions.length)} budgeted accounts before this page was built. Every figure
          below, and every total, describes the remaining {num(view.accounts.length)}.
        </p>
      ) : null}

      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The budget views could not be read."
          hint={
            <>
              <p>
                Unlike every other page, this one does not read a file from{' '}
                <code>app/public/oracle/</code>. The two budget views are served by the API at{' '}
                <code>/api/funding/budgets</code> and <code>/api/funding/positions</code>, so a
                failure here is the server rather than a missing extract.
              </p>
              <p className="budstat__n">
                In local mode the API reads <code>data/sql/turso/sample.db</code>. If that file has
                not been built, run <code>npm run sample:turso</code>.
              </p>
            </>
          }
        />
      ) : null}

      {/* ★ A PARTIAL READ IS A WRONG TOTAL, AND THE ONLY PLACE TO SAY SO IS ABOVE
          THE TOTAL. Every list here is complete at the limit asked for, so this
          renders nothing today. It exists because the budget population is a
          property of the ledger: the same screen against a fuller one would print
          the first page as though it were the whole budget, and a reader has no
          way to tell a small budget from a truncated response by looking. */}
      {data && data.truncated.length > 0 ? (
        <div className="notice notice--warn" role="alert">
          <div>
            <p>
              <strong>This is not the whole budget.</strong> The API returned more rows than one
              request can carry, so the figures below are a page of the population rather than the
              population itself.
            </p>
            <ul className="budtrunc">
              {data.truncated.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {data ? (
        <div className="budstats">
          <Stat
            label="Budgeted accounts"
            value={num(view.accounts.length)}
            note={`of the ${num(combos.length)} on the chart of accounts`}
          />
          <Stat
            label="Capital budget"
            value={money0(view.totals.budget)}
            note="the CAPITAL version, one per account"
          />
          <Stat
            label="Appropriations"
            value={money0(view.totals.allocations)}
            note={`${pctSlim(share(view.totals.allocations, view.totals.budget))} of the capital budget`}
          />
          <Stat
            label="Available funds"
            value={money0(view.totals.available)}
            note={`after ${money0(view.totals.encumbrances)} encumbered and ${money0(view.totals.expenditures)} spent`}
          />
        </div>
      ) : null}

      {/*
        ★ THE DEEP-LINK PANEL THAT USED TO SIT HERE IS GONE, AND ITS JOB MOVED
          INTO THE ROW.

        It existed because a link from the invoice register arrives holding an
        account rather than a budget row, and the page had to show that it had
        understood which account was meant. A row that opens can say that better:
        the linked account is highlighted *and* already showing its own detail,
        inside the same table and under the same column headings as every other
        account. Keeping the panel as well would print one account's five figures
        twice on one screen and invite a reader to maintain two versions of one
        number.

        The absence case below is a different question — there is no row to
        open — so it stays a panel.
      */}

      {/*
        ★ THIS IS THE NOTICE 70 OF 71 LINKS FROM THE INVOICE REGISTER LAND ON, AND
          IT HAS TO BE WORTH READING.

        It does three things and none of them is decorative: it names the account
        that was asked for so the reader knows the link arrived; it says the
        absence is a property of the budget extract rather than of the account,
        with the counts that make that checkable; and it offers the two
        destinations that do hold the account. A dead end here would be a reader
        concluding the page is broken, which is the failure mode the whole
        two-action account cell was built to avoid.
      */}
      {data && wanted && !requested ? (
        <section className="panel budabsent" role="status" aria-label="No budget for this account">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">No budget for this account</h2>
              <p className="panel__sub">
                The budget extract has no row for <code>{wanted}</code>.
              </p>
            </div>
            <button type="button" className="btn btn--system btn--sm" onClick={clearFocus}>
              Show the {num(view.accounts.length)} that do
            </button>
          </div>
          <div className="panel__body">
            <p>
              {num(view.accounts.length)} accounts carry a budget row in this ledger and{' '}
              <code>{wanted}</code> is not one of them. That is not a filter and not a failure to
              load: it is the whole budgeted population, and every version here is assigned the same
              range{assignment.from ? <> — <code>{assignment.from}</code> to <code>{assignment.to}</code></> : null} —
              so an account outside it has no budget to show.
            </p>
            <p className="chart-note">
              The account is still real and still used. Its purchase orders and its invoices are
              booked to it, and{' '}
              <Link to={`/coa/combinations?combo=${encodeURIComponent(wanted)}`}>
                the chart of accounts holds this account
              </Link>
              . This page is the narrower of the two populations, not the more authoritative one.
            </p>
          </div>
        </section>
      ) : null}

      {/* ── the accounts ──────────────────────────────────────────────────── */}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">The budgeted accounts</h2>
            <p className="panel__sub">
              One row per account. The two budget columns come from the CAPITAL and APPROP versions;
              encumbrances and expenditures come from the same <code>GL_BALANCES</code> table under
              the <code>E</code> and <code>A</code> actual flags, which is why a budget and a
              commitment can be read side by side at all.
            </p>
          </div>
          <span className="panel__count">
            {data ? pluralise(view.accounts.length, 'account') : '—'}
          </span>
        </div>

        {!data ? (
          <div className="panel__body">
            <p className="budempty">Reading the budget views…</p>
          </div>
        ) : view.accounts.length === 0 ? (
          <div className="budempty">
            <p>No budgeted account is inside the {scopeLabel(scope, scopeTenant?.programs ?? [])} scope.</p>
            <p className="budempty__hint">
              The budget rows carry a fund and a program, so this page honours the scope control
              like the purchase-order register does. Widening the scope brings them back.
            </p>
          </div>
        ) : (
          <div
            className="table-wrap budacctwrap"
            ref={accountsRef}
            tabIndex={-1}
            role="region"
            aria-label="The budgeted accounts"
          >
            <table className="data budtable budtable--accounts">
              <caption className="sr">
                The budgeted accounts, with the capital budget, the appropriations against it,
                encumbrances, expenditures and the funds remaining.
              </caption>
              <colgroup>
                <col className="c-account" />
                <col className="c-budget" />
                <col className="c-alloc" />
                <col className="c-enc" />
                <col className="c-exp" />
                <col className="c-avail" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" className="n">
                    Capital budget
                  </th>
                  <th scope="col" className="n">
                    Allocations&nbsp;/&nbsp;Reimb.
                  </th>
                  <th scope="col" className="n">
                    Encumbrances
                  </th>
                  <th scope="col" className="n">
                    Expenditures
                  </th>
                  <th scope="col" className="n">
                    Available funds
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* ★ ONE ROW PER ACCOUNT, AND THAT IS THE POINT OF THE PANEL.
                    An account's detail used to be a second `<tr>` returned from
                    this same `map`, spanning all six columns. It only ever
                    worked because that detail was a *table-shaped* thing; what it
                    cost was that opening it pushed the six money columns apart,
                    in a table already scrolling sideways, at exactly the moment a
                    reader asked a question about one of them. The detail is now a
                    dialog on the right, so this is one row per account again. */}
                {view.accounts.map((a) => {
                  const odd = shortfall(a.position);
                  const open = openKey === a.key;
                  return (
                    <tr
                      key={a.key}
                      className={
                        [a.key === wanted ? 'is-focused' : '', open ? 'is-open' : '']
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onClick={(e) => {
                        /* The account key is a control of its own. Without this
                           guard the row's handler fires as well, and two calls to
                           a toggle is a toggle that does nothing. */
                        if ((e.target as HTMLElement).closest('a, button')) return;
                        setRow(a.key, !open);
                      }}
                    >
                      <th scope="row" className="budacct">
                        {/*
                          ★ THE ACCOUNT OPENS THE BUDGET DETAIL — this page's own
                            detail, not a jump to the chart of accounts.

                          It used to link to `/coa/combinations`, on the argument
                          that the budget facts for an account stay on this page
                          while the combinations page is where the account's rows
                          live. Both halves of that are still true; the conclusion
                          was wrong. A reader looking at a budget row and clicking
                          the account is asking about the **budget**, and the answer
                          is the detail — the segments, the appropriation, the
                          phasing, the derivation. Sending them to another page to
                          read a different fact about the same key costs a
                          navigation and loses their place in the table.

                          So the cross-reference did not disappear, it moved: it is
                          the `Account combinations ›` link in the panel's foot,
                          which is where every other panel in this app keeps its
                          one cross-reference, and where a reader who has finished
                          with the budget figures will want it.

                          ★ A `<button>`, not a `<Link to="?account=…">`. The panel
                          is a disclosure driven by `openKey`, so routing this click
                          through the URL would write a history entry for opening a
                          panel — Back would close it instead of leaving the page.
                          A deep link still *seeds* `openKey` on arrival, which is
                          the only thing the URL is asked to do.

                          ★ THIS CARRIED THE TWO-BUTTON ARRANGEMENT UNTIL THE PANEL
                            LANDED: a caret and this wide button side by side, both
                            toggling, both holding `aria-expanded`. Two controls for
                            one boolean is a thing a screen reader has to be told
                            about and a reader has to guess at, and it was only ever
                            there because the wide half needed to *look* like a link
                            and two targets read as one. With the panel, the cue is
                            the only affordance required, so there is one button. */}
                        <button
                          type="button"
                          className="budacct__open"
                          aria-haspopup="dialog"
                          aria-expanded={open}
                          aria-controls="budget-detail"
                          onClick={() => setRow(a.key, !open)}
                          title={`${a.key}\n${open ? 'Hide' : 'Show'} the budget detail for this account`}
                        >
                          {a.key}
                          <span className="budacct__go">
                            {open ? 'Hide detail ›' : 'Budget detail ›'}
                          </span>
                        </button>
                        <span className="budacct__when">{phasing(a.rows)}</span>
                        {odd ? <span className="budacct__odd">{odd}</span> : null}
                      </th>
                      <Money value={a.position.WCPSS_BUDGET} />
                      <Money value={a.position.ALLOCATIONS_REIMB} />
                      <Money value={a.position.ENCUMBRANCES} />
                      <Money value={a.position.EXPENDITURES} />
                      <Money value={a.position.AVAILABLE_FUNDS} />
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">
                    All {num(view.accounts.length)} accounts
                    <span className="budacct__when">
                      {num(inScopeRows.budgets.length)} rows · {money0(view.rowTotal)} of budget
                      movements
                    </span>
                  </th>
                  <Money value={view.totals.budget} />
                  <Money value={view.totals.allocations} />
                  <Money value={view.totals.encumbrances} />
                  <Money value={view.totals.expenditures} />
                  <Money value={view.totals.available} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* ── the timeline ──────────────────────────────────────────────────── */}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Every budget row, in period order</h2>
            <p className="panel__sub">
              All {data ? num(inScopeRows.budgets.length) : '—'} rows behind the table above, oldest
              period first. This is the only view that can say whether a budget was set once or
              assembled over years — a position row cannot, because it has no dates in it.
            </p>
          </div>
          <span className="panel__count">
            {data ? pluralise(view.periods.length, 'period') : '—'}
          </span>
        </div>

        {data && inScopeRows.budgets.length > 0 ? (
          <div className="table-wrap">
            <table className="data budtable budtable--periods">
              <caption className="sr">
                Every budget row, grouped by account and ordered by period, showing the version and
                budget type each movement belongs to.
              </caption>
              <colgroup>
                <col className="c-period" />
                <col className="c-version" />
                <col className="c-type" />
                <col className="c-rows" />
                <col className="c-amount" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Version</th>
                  <th scope="col">Budget type</th>
                  <th scope="col" className="n">
                    Rows
                  </th>
                  <th scope="col" className="n">
                    Movement
                  </th>
                </tr>
              </thead>
              {/* One `tbody` per account, so the group heading is part of the table
                  rather than a heading floating above a fragment of it. The
                  alternative — a single flat list — loses the account each row
                  belongs to the moment the table is scrolled. */}
              {view.accounts.map((a) => (
                <tbody key={a.key} className="budgroup">
                  <tr className="budgroup__head">
                    <th scope="colgroup" colSpan={5}>
                      <span className="budgroup__key">{a.key}</span>
                      <span className="budgroup__when">{phasing(a.rows)}</span>
                      <span className="budgroup__sum">{money0(a.position.ALLOCATIONS_REIMB)} appropriated</span>
                    </th>
                  </tr>
                  {a.rows.map((r, i) => {
                    const v = view.versionById.get(r.BUDGET_VERSION_ID);
                    const t = v ? view.typeById.get(v.BUDGET_TYPE_ID) : undefined;
                    const badge = budTypeBadge(t);
                    return (
                      <tr key={`${r.BUDGET_VERSION_ID}-${r.PERIOD_NAME}-${i}`}>
                        <td className="bud-period">
                          {r.PERIOD_NAME}
                          <span className="bud-period__num">
                            Y{r.PERIOD_YEAR} · P{String(r.PERIOD_NUM).padStart(2, '0')}
                          </span>
                        </td>
                        <td>
                          {r.BUDGET_VERSION_ID}
                          {v ? <span className="bud-version__name">{v.BUDGET_NAME}</span> : null}
                        </td>
                        <td>
                          {badge.label ? (
                            <span className={`budtype budtype--${badge.modifier}`}>
                              {badge.label}
                            </span>
                          ) : (
                            <span className="budtype">—</span>
                          )}
                        </td>
                        <td className="n bud-num">{num(r.BALANCE_ROWS)}</td>
                        <td className="n bud-num bud-num--move">{money(r.NET_AMOUNT)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        ) : null}
      </section>

      {/* ── the versions ──────────────────────────────────────────────────── */}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">The budget versions</h2>
            <p className="panel__sub">
              Every movement above belongs to one of these.
              {ledgerGap?.latest ? (
                <>
                  {' '}
                  This ledger does not serve <code>LATEST_FLAG</code> on a version, so the column
                  below says so rather than claiming one of these replaced another.
                </>
              ) : (
                <>
                  {' '}
                  Exactly one version per budget type carries <code>LATEST_FLAG</code>, which is
                  what makes a current budget distinguishable from a superseded one without
                  reading dates.
                </>
              )}
            </p>
          </div>
          <span className="panel__count">{data ? pluralise(data.versions.length, 'version') : '—'}</span>
        </div>

        {/*
          ★ THERE ARE TWO DIFFERENT FACTS THAT CAN SIT UNDER THIS HEADING, AND ONLY ONE OF THEM
            IS ABOUT THE SAMPLE — so the note changes rather than disappearing.

          On the sample, the provenance table in `sample.db` records `GL_BUDGET_VERSIONS` as
          `derived` (“Version spans follow the BOE dates of the funding lines”) and
          `GL_BUDGET_TYPES` as `synthetic`, while the balances this page is otherwise built on
          are `transcribed`. So the table below quotes real money under invented version names,
          and the note says so; the rows themselves are left exactly as they are, because they
          are what demonstrates the `LATEST_FLAG` logic.

          On the live ledger there is no version *model* to describe: it serves no budget type,
          no period span, no status and no `LATEST_FLAG` on any version. A sentence about “the
          four rows below” would then be a false statement about a table holding two, and the
          absence is the thing worth saying — a reader who knows `LATEST_FLAG` is gone stops
          looking for a current budget and reads the movements instead.

          Which note applies is read off the rows, not off a build flag, so the pair cannot
          drift away from the data. See `ledgerGap`.
        */}
        {!data ? null : ledgerGap ? (
          <p className="scopenote scopenote--panel" role="note">
            <span className="scopenote__flag">Not supplied by this ledger</span>
            <span className="scopenote__text">
              This ledger&#8217;s budget tables are not shaped like the ones this page reads, and it
              answers none of the questions below: <code>GL_BUDGET_TYPES</code> carries nothing
              this resource names, and <code>GL_BUDGET_VERSIONS</code> serves no budget type, no
              period range, no status and no <code>LATEST_FLAG</code>. Those cells read{' '}
              <em>not supplied</em> rather than a guess — the latest column in particular, because
              an absent flag is not <code>N</code>, and labelling every version superseded would
              have been the opposite of the truth. The version names and every movement above are
              read from the ledger in full.
            </span>
          </p>
        ) : (
          <p className="scopenote scopenote--panel" role="note">
            <span className="scopenote__flag">Derived, not extracted</span>
            <span className="scopenote__text">
              The four version rows below are authored for this sample rather than read from the ledger —
              their fiscal-year spans were written to match the BOE dates of the funding lines, and the{' '}
              <code>APPROP</code>/<code>CAPITAL</code> split is this build&#8217;s reading of the
              report&#8217;s two budget columns. The instance itself holds <strong>two</strong> versions,{' '}
              <code>WCPSS</code> and <code>WCPSS BUDGET</code>, both of the single type{' '}
              <code>STANDARD</code>, and every budgeted row there carries the same version{' '}
              <code>1001</code> from FY2023 to FY2027. So the names, the types and the
              one-version-per-fiscal-year shape describe this sample; the balances they are laid against
              come from the report.
            </span>
          </p>
        )}

        {data ? (
          <div className="table-wrap">
            <table className="data budtable budtable--versions">
              <caption className="sr">
                The budget versions, with the budget type each belongs to, the period range it
                covers, and whether it is the latest version of its type.
              </caption>
              <colgroup>
                <col className="c-vid" />
                <col className="c-type" />
                <col className="c-name" />
                <col className="c-range" />
                <col className="c-status" />
                <col className="c-latest" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Budget type</th>
                  <th scope="col">Name</th>
                  <th scope="col">Period range</th>
                  <th scope="col">Status</th>
                  <th scope="col">Latest</th>
                </tr>
              </thead>
              <tbody>
                {[...data.versions]
                  .sort((a, b) => a.BUDGET_VERSION_ID - b.BUDGET_VERSION_ID)
                  .map((v: BudgetVersion) => {
                    const badge = budTypeBadge(view.typeById.get(v.BUDGET_TYPE_ID));
                    const latest = latestState(v);
                    const rowCount = inScopeRows.budgets.filter(
                      (r) => r.BUDGET_VERSION_ID === v.BUDGET_VERSION_ID,
                    ).length;
                    return (
                      <tr key={v.BUDGET_VERSION_ID}>
                        <td className="bud-num">{v.BUDGET_VERSION_ID}</td>
                        <td>
                          {badge.label ? (
                            <span className={`budtype budtype--${badge.modifier}`}>
                              {badge.label}
                            </span>
                          ) : (
                            <span className="budtype">—</span>
                          )}
                        </td>
                        <td className="bud-name">
                          {v.BUDGET_NAME}
                          <span className="bud-name__note">
                            {rowCount === 0
                              ? 'no movement in this extract'
                              : `${pluralise(rowCount, 'movement')} on this page`}
                          </span>
                        </td>
                        <td className="bud-range">
                          {v.FIRST_PERIOD_NAME && v.LAST_PERIOD_NAME ? (
                            <>
                              {v.FIRST_PERIOD_NAME} → {v.LAST_PERIOD_NAME}
                            </>
                          ) : (
                            <span className="budabsent">not supplied</span>
                          )}
                        </td>
                        <td className="bud-status">
                          {v.STATUS_CODE ?? <span className="budabsent">not supplied</span>}
                        </td>
                        <td>
                          {latest === 'yes' ? (
                            <span className="budlatest budlatest--yes">latest</span>
                          ) : latest === 'no' ? (
                            <span className="budlatest">superseded</span>
                          ) : (
                            <span className="budlatest budlatest--unknown">not supplied</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* ── why four accounts, and what the columns are made of ───────────── */}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Why four accounts, and what the columns are made of</h2>
            <p className="panel__sub">
              The two things a reader should be able to check rather than take on trust: how far the
              budget reaches, and whether the figures are read or recomputed.
            </p>
          </div>
        </div>
        <div className="panel__body">
          {data ? (
            <>
              <p>
                All {num(assignment.count)} versions are assigned the same account range
                {assignment.same ? '' : ' (they do not all agree, which is worth knowing)'}
                {assignment.from ? (
                  <>
                    : <code>{assignment.from}</code> to <code>{assignment.to}</code>. Every budgeted
                    account is inside it and nothing outside it has a budget, which is why this page
                    is {num(view.accounts.length)} accounts rather than the {num(combos.length)} on
                    the chart of accounts.
                  </>
                ) : null}
              </p>
              <p>
                A version&#8217;s assignment is a <em>permission to be budgeted</em>, not a budget:{' '}
                {num(assignment.count)} versions cover the whole range and only{' '}
                {num(new Set(inScopeRows.budgets.map((r) => keyOf(r))).size)} accounts in it were ever
                given an amount.
              </p>

              <h3 className="budsub">The position columns, checked against their own rows</h3>
              <p className="budderiv__verdict">
                {derivationsOk
                  ? `Holds on all ${num(derivations.length)} accounts: the capital budget equals the CAPITAL rows summed, the appropriations equal the APPROP rows summed, and available funds equal appropriations less encumbrances less expenditures.`
                  : 'One or more of the rules below does not hold on this data — the arithmetic is stated per account rather than being summarised.'}
              </p>
              <div className="table-wrap">
                <table className="data budtable budtable--deriv">
                  <caption className="sr">
                    For each account, what the position view reports against what the budget rows
                    add up to.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col" className="n">
                        Capital budget — view / rows
                      </th>
                      <th scope="col" className="n">
                        Appropriations — view / rows
                      </th>
                      <th scope="col" className="n">
                        Available funds — view / arithmetic
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivations.map((d: Derivation) => (
                      <tr key={d.key}>
                        <th scope="row" className="budacct budacct--plain">
                          {d.key}
                          {d.uncolumned.length > 0 ? (
                            <span className="budacct__odd">
                              {d.uncolumned.join(', ')} rows carry no column here
                            </span>
                          ) : null}
                        </th>
                        <td className="n bud-num" data-ok={String(near(d.capitalFromRows, d.capitalFromView))}>
                          {money(d.capitalFromView)} <span className="budderiv__of">/ {money(d.capitalFromRows)}</span>
                        </td>
                        <td className="n bud-num" data-ok={String(near(d.appropFromRows, d.appropFromView))}>
                          {money(d.appropFromView)} <span className="budderiv__of">/ {money(d.appropFromRows)}</span>
                        </td>
                        <td className="n bud-num" data-ok={String(near(d.availableFromColumns, d.availableFromView))}>
                          {money(d.availableFromView)}{' '}
                          <span className="budderiv__of">/ {money(d.availableFromColumns)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="chart-note">
                <code>AVAILABLE_FUNDS</code> is the report&#8217;s formula rather than a stored
                column — the view subtracts. It is shown here as the view reports it, with the
                subtraction alongside, so a reader can see that the two agree instead of being asked
                to assume it. And the budget columns are not a second source of truth: they are the
                period rows above, grouped by budget type.
              </p>
            </>
          ) : null}
        </div>
      </section>

      {/* ── the detail, which is a panel rather than a row ────────────────── */}

      {/*
        ★ LAST CHILD OF THE PAGE AND OUTSIDE EVERY TABLE, WHICH IS WHERE IT HAS TO
          BE. `.drawer` is `position: fixed`, so its DOM position does not decide
          where it paints — but it does decide two things that matter: an element
          inside a `<tr>` would be invalid HTML the browser silently reparents out
          of the table (taking the grid, the borders and the hover with it), and a
          fixed element inside `.table-wrap`'s `overflow: auto` is clipped by it
          unless that wrapper is also its containing block. Both problems vanish by
          putting the panel where the other panels in this app live: a sibling of
          the content, at the end.

        It is rendered even when nothing is open, and `aria-hidden` when shut. That
        is what gives the exit transition something to animate — and it is why
        `BudgetPanel` may see a null account, and why its `AccountDetail` is
        conditional inside.
      */}
      <BudgetPanel
        account={openAccount}
        open={openAccount !== null}
        onClose={closePanel}
        count={view.accounts.length}
        combosOnChart={combos.length}
        spread={spread}
        derivation={openAccount ? derivationByKey.get(openAccount.key) : undefined}
        versionById={view.versionById}
        typeById={view.typeById}
      />
    </div>
  );
}
