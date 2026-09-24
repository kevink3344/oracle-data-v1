import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  byCommitment,
  byLevelCommitment,
  duplicateFinding,
  loadEncumbrances,
  matches,
  moneyOrDash,
  overlap,
  scopeWouldRemove,
  type EncumbrancesData,
  type EncumbranceAccount,
  type EncumbranceLevel,
} from '../data/encumbrances';
import { ordersForAccountHref, ordersForLevelHref } from '../data/purchaseOrders';
import { scopeLabel } from '../data/scope';
import { useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import { money, money0, num, pluralise } from '../data/format';

/**
 * Encumbrances — what is committed, against two sources that do not agree.
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 *
 * Every other register in this app reads one population and adds it up. This one
 * reads **two** and refuses to add them up together, because they are two
 * different populations and the difference between them is the information:
 *
 *     the purchasing extract   335 account combinations   $430,580,538.04
 *     the custom report's GL     4 accounts                 $5,198,165.65
 *
 * ★ THE PAGE IS BUILT AROUND THE GAP, NOT DESPITE IT. `00-schema.sql` above
 *   `V_ENCUMBRANCE_FROM_PO` says the two *"WILL NOT AGREE … Keep BOTH numbers side
 *   by side. Where they differ is exactly where the slice is incomplete."* A
 *   single combined total would have to pick which of two true populations to be
 *   wrong about, so there is no combined total on this page and the four
 *   accounts that appear in both carry the only difference worth computing.
 *
 * ── ★ THE THREE THINGS THIS PAGE MUST NOT LET A READER BELIEVE ──────────────
 *
 *   1. **That the purchasing figure is an independent measurement.** It is a
 *      mirror of the ordered amount on all 2,802 rows, and the schema's own
 *      provenance says why. Stated in prose, driven by
 *      `po.encumbranceMirrorsOrdered` rather than hard-coded, so it goes away by
 *      itself if a later extract carries a real encumbered figure.
 *   2. **That a blank GL cell means zero.** 331 of 335 combinations are absent
 *      from a four-account extract. `null` all the way to the cell, `—` on
 *      screen, and a standing note above the table that says *blank is not zero*.
 *   3. **That an encumbrance is money that has been spent.** It is a commitment.
 *      This page never sums one into an expenditure, and says so where a reader
 *      would be tempted — `menu.ts` records the rule on this leaf.
 *
 * ── THE TWO FOOTNOTES, WHICH ARE THE PAGE'S USEFUL ANSWERS ─────────────────
 *
 *   * The report publishes **$149,072.93 on both object 529 and object 532** and
 *     asks whether one order spans both or it is a copy bug. The distributions
 *     answer it: **529 → $354,782.00 over 9** and **532 → $15,000.00 over 1**.
 *   * Seven combinations resolve to no project and total **$11,511.12** — which is
 *     exactly the difference between this table and the line-level extract.
 */

/**
 * A money cell, with the blank/zero rule applied in exactly one place.
 *
 * `both` marks the four accounts the difference column is defined over. It is a
 * separate flag rather than something the cell could work out, because the cell
 * only knows its own value — and "$5,198,165.65 and no other" would be a
 * coincidence of this sample rather than the population rule.
 */
function MoneyCell({
  value,
  both,
}: {
  value: number | null;
  both?: boolean;
}) {
  return (
    <td
      className={`n enc-num${value === null ? ' enc-num--blank' : ''}${both ? ' enc-num--both' : ''}`}
    >
      {value === null ? (
        <span className="enc-blank" title="Not in the GL extract — an absence, not a zero">
          {moneyOrDash(value, money)}
        </span>
      ) : (
        money(value)
      )}
    </td>
  );
}

/** A difference, signed and coloured, so a reader can see which way it leans. */
function DeltaCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <td className="n enc-num">
        <span className="enc-blank">—</span>
      </td>
    );
  }
  return (
    <td className={`n enc-num ${value > 0 ? 'enc-delta--up' : value < 0 ? 'enc-delta--down' : ''}`}>
      {value > 0 ? '+' : ''}
      {money(value)}
    </td>
  );
}

const ACCOUNT_WANTED = (params: URLSearchParams): string =>
  (params.get('account') ?? params.get('combo') ?? '').trim();

export default function Encumbrances() {
  const [data, setData] = useState<EncumbrancesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The free-text filter. Local rather than in the URL: it is a glance, not a place. */
  const [q, setQ] = useState('');
  const { scope, scopeTenant } = useStore();
  const [params, setParams] = useSearchParams();

  const reload = () => setAttempt((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setError(null);

    loadEncumbrances(controller.signal)
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
   * Which grain is showing — `combination` (335 rows) or `level` (a roll-up).
   *
   * ★ IN THE URL RATHER THAN IN STATE, because it is a *view of a population*
   *   rather than a passing glance: a reader who has found the project they care
   *   about has found a link worth sending, and the level drill below builds on
   *   the same two parameters.
   */
  const grain = params.get('grain') === 'level' ? 'level' : 'combination';
  const levelFilter = (params.get('level') ?? '').trim();
  const wanted = ACCOUNT_WANTED(params);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const accounts = useMemo(() => data?.accounts ?? [], [data]);

  /** The four both sides hold. The only set a difference is meaningful over. */
  const both = useMemo(() => overlap(accounts), [accounts]);

  const finding = useMemo(() => duplicateFinding(accounts), [accounts]);

  /**
   * What the app's scope would cost if it were applied here. It is not — see the note.
   *
   * ★ THE SELECTION IS THE ARGUMENT, AND IT IS THE VALUE THE NOTE PRINTS. The scope used
   *   to be spelled out inside the helper while the note below printed
   *   `scopeLabel(scope, …)`, so a reader who narrowed the scope read a label and a count
   *   describing two different scopes. Passing `scope` makes the sentence and the number
   *   agree, and it means a narrowing reader sees the cost of *their* narrowing.
   *
   * ★ `null` WHEN THERE IS NO TENANT — the store's own guard, so this page cannot claim a
   *   cost for a scope the rest of the app is not applying either.
   */
  const scopeCost = useMemo(
    () => scopeWouldRemove(accounts, scopeTenant ? scope : null),
    [accounts, scope, scopeTenant],
  );

  /**
   * The combinations, filtered and ordered.
   *
   * ★ FILTER FIRST, THEN SORT — never sort a slice. The rule `debugging.md`
   *   records: a filter applied after a cap silently denies that matches exist
   *   outside the window, and the symptom is a query with a known-nonzero total
   *   reporting none. There is no cap on this route, and the order is kept this
   *   way so that adding one later cannot introduce it.
   */
  const rows = useMemo(() => {
    const filtered = accounts
      .filter((a) => !levelFilter || a.LEVEL_CODE === levelFilter)
      .filter((a) => matches(a, q));
    return [...filtered].sort(byCommitment);
  }, [accounts, levelFilter, q]);

  /** The unresolved bucket, kept out of the roll-up and shown on its own. */
  const unresolvedRows = useMemo(
    () => accounts.filter((a) => a.LEVEL_CODE === 'UNRESOLVED').sort(byCommitment),
    [accounts],
  );

  const levels = useMemo(() => [...(data?.levels ?? [])].sort(byLevelCommitment), [data]);

  if (error) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          <div className="page-head">
            <div>
              <h1>Encumbrances</h1>
            </div>
          </div>
        </div>
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The encumbrance endpoint could not be read."
          hint={
            <>
              <p>
                This page reads neither the extract nor a file under{' '}
                <code>app/public/oracle/</code>. It reads{' '}
                <code>/api/spend/encumbrances</code>, which joins{' '}
                <code>V_ENCUMBRANCE_FROM_PO</code> to <code>V_ACCOUNT_POSITION</code> in the
                database, so a failure here is the server rather than a missing file.
              </p>
              <p className="encstat__n">
                In local mode the API reads <code>data/sql/turso/sample.db</code>. If that file has
                not been built, run <code>npm run sample:turso</code>.
              </p>
            </>
          }
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          <div className="page-head">
            <div>
              <h1>Encumbrances</h1>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { counts, totals, po, unresolved, notes } = data;
  const showing = levelFilter || q;

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Encumbrances</h1>
          </div>
        </div>
      </div>

      {/* ── ★ THE STANDING NOTE. Not a warning: a limit on what a blank means. ──
          Rendered above the figures rather than beside the column, because the
          misreading it prevents ("the GL side is mostly zero") is formed while
          reading the KPI row, several screens before the column is reached. */}
      <p className="scopenote scopenote--enc" role="note">
        <span className="scopenote__flag">Blank is not zero</span>
        <span className="scopenote__text">
          {num(counts.PO_ONLY)} of the {num(counts.ACCOUNTS)} combinations have <strong>no row at
          all</strong> on the GL side, which is a four-account extract rather than a ledger. Those
          cells are left blank and are never printed as <code>$0.00</code> — the account was not
          read and found empty, it was not in the extract. A difference is computed only over the{' '}
          {pluralise(counts.IN_BOTH, 'account')} both sides hold.
        </span>
      </p>

      {/* ── ★ THE SCOPE DECISION, WITH THE NUMBER THAT MADE IT. ──────────────
          Every other page in the app honours the account scope. This one does
          not, and it says how much that costs and why — because applying it here
          would delete the page's own footnote quietly. */}
      {scopeCost > 0 ? (
        <p className="scopenote scopenote--enc" role="note">
          <span className="scopenote__flag">Scope not applied</span>
          <span className="scopenote__text">
            The <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}</strong> scope would remove{' '}
            {num(scopeCost)} of the{' '}
            {num(counts.ACCOUNTS)} combinations — the {num(unresolved.ACCOUNTS)} whose account
            resolves to no project, fund <code>00</code> against the extract&rsquo;s{' '}
            <code>04</code>. Those are the {money0(unresolved.AMOUNT)} the footnote at the bottom
            of this page exists to account for, so the register is shown <em>in full</em> here and
            the scope is left off deliberately. This page reads the purchasing distribution table
            rather than the scoped line extract, and its totals will not reconcile with the pages
            that are scoped.
          </span>
        </p>
      ) : null}

      {data.truncated.length > 0 ? (
        <div className="notice notice--warn" role="alert">
          <div>
            <p>
              <strong>This is not the whole population.</strong> The API returned more rows than
              one request can carry, so the figures below describe a page rather than everything
              that exists.
            </p>
            <ul className="enc-list">
              {data.truncated.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/*
        ★ THE FOUR STAT CARDS ARE GONE, ON STAFF'S INSTRUCTION. They read: committed on the
        purchasing side, committed on the GL side, agreement between the two, and the unresolved
        total — all totals over the tables below, which carry the per-account rows they summed.

        ★ THE PANEL BELOW IS KEPT, AND IT IS NOT THE SAME KIND OF THING. It is not a summary of the
        figures; it is the statement that the purchasing column is *the ordered amount under another
        name* — a fact about what the column means that no row in the table carries. Removing it
        would leave a reader comparing two columns that look like two measurements and are not.
      */}

      {/* ── ★ THE DISCLOSURE THAT MAKES THE NUMBERS HONEST. ─────────────────
          Driven by `po.encumbranceMirrorsOrdered`, which the server derives from
          the row counts — so this paragraph deletes itself the moment the extract
          carries a real encumbered figure, rather than ageing into a claim about
          data that moved. */}
      <section className="panel encpanel" aria-label="What these figures are">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">What the purchasing figure actually is</h2>
            <p className="panel__sub">
              {po.encumbranceMirrorsOrdered
                ? 'The ordered amount, under another name — and why.'
                : 'An independent encumbered figure, carried by the extract.'}
            </p>
          </div>
          <div className="panel__count">{num(po.ROWS)} distribution rows</div>
        </div>
        <div className="panel__body">
          {po.encumbranceMirrorsOrdered ? (
            <>
              <p>
                On <strong>all {num(po.ROWS)}</strong> rows of the purchasing distribution table,
                the encumbered amount is <strong>exactly equal</strong> to the ordered amount — the
                sum of the differences is <code>{money(0)}</code> — and{' '}
                <code>ENCUMBERED_FLAG</code> is <code>&#39;Y&#39;</code> on all{' '}
                {num(po.FLAGGED)} of them, so the flag narrows nothing. The purchasing total below
                is therefore <strong>the same {money0(po.ORDERED_TOTAL)} the purchase-order
                register already reports as ordered</strong>, not a second measurement that happens
                to agree with it.
              </p>
              <p className="chart-note">
                The extract carries no separate encumbered figure for these rows, which is what its
                own provenance notes. Where the GL side differs from it, the difference is between{' '}
                <em>this slice and the ledger</em> — not between two readings of the same ledger.
              </p>
            </>
          ) : (
            <p>
              The extract now carries an encumbered figure that differs from the ordered amount on{' '}
              {num(po.ROWS - po.MIRRORED)} of {num(po.ROWS)} rows, so the two are separate
              measurements and the caveat that used to stand here no longer applies.
            </p>
          )}

          <p className="chart-note">
            <strong>{num(po.BILLED_ROWS)} distributions carry a non-zero billed amount</strong>, so
            &ldquo;committed minus billed&rdquo; is not a figure this data can produce. It is not
            omitted by choice: there is nothing on the other side of the subtraction.
          </p>

          {/* ★ THE RULE FROM `menu.ts`, SAID WHERE A READER WOULD BE TEMPTED. */}
          <p className="enc-rule">
            An encumbrance is a <strong>commitment</strong>, not a cost. Nothing on this page is
            added to an expenditure total, and no total here is added to one elsewhere — committed
            money and spent money are different questions, and the only place they belong side by
            side is on a page that refuses to combine them.
          </p>
        </div>
      </section>

      {/* ── The grain toggle, and the level drill when one is active. ────── */}
      <div className="encbar">
        <div className="encgrain" role="group" aria-label="How to group the account combinations">
          <button
            type="button"
            className={`encgrain__b${grain === 'combination' ? ' is-on' : ''}`}
            aria-pressed={grain === 'combination'}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('grain');
              setParams(next, { replace: true });
            }}
          >
            By combination <span className="encgrain__n">{num(counts.ACCOUNTS)}</span>
          </button>
          <button
            type="button"
            className={`encgrain__b${grain === 'level' ? ' is-on' : ''}`}
            aria-pressed={grain === 'level'}
            onClick={() => setParam('grain', 'level')}
          >
            By project level <span className="encgrain__n">{num(counts.LEVELS)}</span>
          </button>
        </div>

        {grain === 'combination' ? (
          <label className="encsearch">
            <span className="encsearch__k">Filter</span>
            <input
              type="search"
              className="encsearch__i"
              value={q}
              placeholder="account, object, level or purpose"
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="encsearch__n" aria-live="polite">
              {num(rows.length)} of {num(counts.ACCOUNTS)}
            </span>
          </label>
        ) : null}

        {levelFilter ? (
          <button
            type="button"
            className="btn btn--system btn--sm"
            onClick={() => setParam('level', null)}
          >
            Clear level {levelFilter}
          </button>
        ) : null}
      </div>

      {/* ── ★ THE DERIVED FIGURES, LABELLED AS DERIVED. Same discipline as the
             "Derived, not extracted" note on the Budgets page: a reader is
             entitled to know which figures were read and which were computed. ── */}
      {grain === 'combination' ? (
        <>
          <div className="encnote">
            <strong>Derived, not extracted.</strong> The <em>Difference</em> column is arithmetic
            over the two sources — <code>GL encumbrance − purchasing encumbrance</code> — and is
            shown only on the {pluralise(counts.IN_BOTH, 'account')} both sides hold. The{' '}
            <em>purchasing</em> column is read from{' '}
            <code>V_ENCUMBRANCE_FROM_PO</code>; the <em>GL</em> column from{' '}
            <code>V_ACCOUNT_POSITION</code>. Neither is recomputed here, and no figure on this page
            is derived from an expenditure.
          </div>

          <section className="panel encpanel">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">Account combinations</h2>
                <p className="panel__sub">
                  Every combination the purchasing extract carries a commitment against, largest
                  first.{' '}
                  {showing
                    ? `Showing ${num(rows.length)} of ${num(counts.ACCOUNTS)}.`
                    : `${num(counts.ACCOUNTS)} rows, ${num(counts.IN_BOTH)} of them with a GL figure.`}
                </p>
              </div>
              <div className="panel__count">{money0(totals.PO_ENCUMBERED)} committed</div>
            </div>
            <div className="encwrap">
              <table className="data enctable">
                <thead>
                  <tr>
                    <th scope="col">Account combination</th>
                    <th scope="col">Object</th>
                    <th scope="col">Level</th>
                    <th scope="col" className="enc-th--n">
                      Distributions
                    </th>
                    <th scope="col" className="enc-th--n">
                      Orders
                    </th>
                    <th scope="col" className="enc-th--n">
                      Purchasing encumbrance
                    </th>
                    <th scope="col" className="enc-th--n">
                      GL encumbrance
                    </th>
                    <th scope="col" className="enc-th--n">
                      Difference
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr
                      key={a.CODE_COMBINATION_ID}
                      className={wanted && a.ACCOUNT === wanted ? 'is-wanted' : undefined}
                    >
                      <th scope="row" className="enc-acct">
                        <Link
                          className="enc-acct__link"
                          to={`/coa/combinations?combo=${encodeURIComponent(a.ACCOUNT)}`}
                          title="Where this account sits on the chart of accounts"
                        >
                          {a.ACCOUNT}
                        </Link>
                        {/* The two destinations the user asked for, side by side:
                            the orders behind the commitment, and the budget the
                            account was authorised against. */}
                        <span className="enc-acct__acts">
                          <Link className="enc-acct__act" to={ordersForAccountHref(a.ACCOUNT)}>
                            Orders <span aria-hidden="true">›</span>
                            <span className="enc-acct__n">{num(a.PO_ORDERS)}</span>
                          </Link>
                          <Link
                            className="enc-acct__act"
                            to={`/funding/budgets?account=${encodeURIComponent(a.ACCOUNT)}`}
                          >
                            Budget <span aria-hidden="true">›</span>
                          </Link>
                        </span>
                      </th>
                      <td className="enc-code">{a.OBJECT_CODE}</td>
                      <td className="enc-code">{a.LEVEL_CODE}</td>
                      <td className="n enc-num">{num(a.PO_DISTRIBUTIONS)}</td>
                      <td className="n enc-num">{num(a.PO_ORDERS)}</td>
                      <td className="n enc-num enc-num--lead">{money(a.PO_ENCUMBERED)}</td>
                      <MoneyCell value={a.GL_ENCUMBRANCE} both={a.IN_GL} />
                      <DeltaCell value={a.DELTA} />
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 ? (
                <p className="encempty" role="status">
                  No account combination matches {q ? <>“{q}”</> : <>level {levelFilter}</>}.
                  Nothing is hidden by a page limit — this route returns the whole population in
                  one response, so a combination that is absent here is absent from the
                  distributions.
                </p>
              ) : null}
            </div>
          </section>
        </>
      ) : (
        <section className="panel encpanel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Project levels</h2>
              <p className="panel__sub">
                The same {money0(totals.PO_ENCUMBERED)}, grouped by the project each combination is
                charged to. Largest first — open a level to see its combinations.
              </p>
            </div>
            <div className="panel__count">{num(counts.LEVELS)} levels</div>
          </div>
          <div className="encwrap">
            <table className="data enctable enctable--levels">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Objects charged</th>
                  <th scope="col" className="enc-th--n">
                    Combinations
                  </th>
                  <th scope="col" className="enc-th--n">
                    Orders
                  </th>
                  <th scope="col" className="enc-th--n">
                    Purchasing encumbrance
                  </th>
                  <th scope="col" className="enc-th--n">
                    GL encumbrance
                  </th>
                  <th scope="col" className="enc-th--acts" />
                </tr>
              </thead>
              <tbody>
                {levels.map((l: EncumbranceLevel) => (
                  <tr key={l.LEVEL_CODE} className={l.HAS_BOTH ? 'is-both' : undefined}>
                    <th scope="row" className="enc-code enc-level">
                      {l.LEVEL_CODE}
                    </th>
                    <td className="enc-objects">{l.OBJECT_CODES.join(' · ')}</td>
                    <td className="n enc-num">{num(l.ACCOUNTS)}</td>
                    <td className="n enc-num">{num(l.PO_ORDERS)}</td>
                    <td className="n enc-num enc-num--lead">{money(l.PO_ENCUMBERED)}</td>
                    <MoneyCell value={l.GL_ENCUMBRANCE} both={l.HAS_BOTH} />
                    <td className="enc-acts">
                      <button
                        type="button"
                        className="enc-act"
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.set('grain', 'combination');
                          next.set('level', l.LEVEL_CODE);
                          setParams(next, { replace: true });
                        }}
                      >
                        Combos <span aria-hidden="true">›</span>
                      </button>
                      <Link className="enc-act" to={ordersForLevelHref(l.LEVEL_CODE)}>
                        Orders <span aria-hidden="true">›</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="chart-note enc-pad">
            Orders are counted <strong>distinctly at each level</strong>, not summed from the
            combinations inside it: an order charged to two accounts under one project would
            otherwise be counted twice. The level carrying a GL figure is the one the report
            publishes, and it is the only row on this page where the two sides can be compared.
          </p>
        </section>
      )}

      {/* ── ★ THE FIRST FOOTNOTE: the report's duplicate, answered. ───────── */}
      {finding ? (
        <section className="panel encpanel" aria-label="An encumbrance printed twice by the report">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">
                The report prints {money(finding.reportFigure)} twice
              </h2>
              <p className="panel__sub">
                On two different objects. The distributions say they are not the same money.
              </p>
            </div>
          </div>
          <div className="panel__body">
            <p>
              The custom report publishes an encumbrance of{' '}
              <strong>{money(finding.reportFigure)}</strong> against both object{' '}
              <strong>529</strong> and object <strong>532</strong>, which raises a fair question:
              one purchase order spanning two objects, or a copy error. The purchasing extract
              answers it on the two identical account keys —
            </p>
            <table className="data enctable enctable--finding">
              <thead>
                <tr>
                  <th scope="col">Object</th>
                  <th scope="col">Account combination</th>
                  <th scope="col" className="enc-th--n">
                    Distributions
                  </th>
                  <th scope="col" className="enc-th--n">
                    Purchasing encumbrance
                  </th>
                  <th scope="col" className="enc-th--n">
                    GL encumbrance
                  </th>
                </tr>
              </thead>
              <tbody>
                {finding.rows.map((a: EncumbranceAccount) => (
                  <tr key={a.CODE_COMBINATION_ID}>
                    <th scope="row" className="enc-code">
                      {a.OBJECT_CODE}
                    </th>
                    <td className="enc-acct__cell">{a.ACCOUNT}</td>
                    <td className="n enc-num">{num(a.PO_DISTRIBUTIONS)}</td>
                    <td className="n enc-num enc-num--lead">{money(a.PO_ENCUMBERED)}</td>
                    <MoneyCell value={a.GL_ENCUMBRANCE} both />
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="chart-note">
              Two different commitments, {money(finding.rows[1] ? finding.rows[1].PO_ENCUMBERED - finding.rows[0].PO_ENCUMBERED : 0)}{' '}
              apart, against a single figure printed twice. So the report&rsquo;s pair is{' '}
              <strong>not</strong> one commitment shown from two angles — either the report has a
              copy error, or it is counting something the purchasing extract does not hold. Worth
              settling before anything is built on that column, and this is the evidence for
              settling it.
            </p>
          </div>
        </section>
      ) : null}

      {/* ── ★ THE SECOND FOOTNOTE: the bucket that reconciles the two totals. ─ */}
      <section className="panel encpanel" aria-label="Combinations that resolve to no project">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Committed to an account that names no project</h2>
            <p className="panel__sub">
              {pluralise(unresolved.ACCOUNTS, 'combination')}, {num(unresolved.ORDERS)} orders,{' '}
              {money(unresolved.AMOUNT)}
            </p>
          </div>
        </div>
        <div className="panel__body">
          <p>{unresolved.NOTE}</p>
          <p className="enc-recon">
            <strong>{money(unresolved.AMOUNT)} is exactly the reconciliation</strong> between this
            page and the purchase-order register: the distributions here total{' '}
            <code>{money(po.ORDERED_TOTAL)}</code> and the line-level extract totals{' '}
            <code>{money(po.ORDERED_TOTAL - unresolved.AMOUNT)}</code>. The extract resolves its
            accounts through the level, so it cannot carry a row whose level is{' '}
            <code>UNRESOLVED</code>. Both figures are right; they are answers about different sets.
          </p>
          <table className="data enctable enctable--finding">
            <thead>
              <tr>
                <th scope="col">Account combination</th>
                <th scope="col" className="enc-th--n">
                  Distributions
                </th>
                <th scope="col" className="enc-th--n">
                  Purchasing encumbrance
                </th>
              </tr>
            </thead>
            <tbody>
              {unresolvedRows.map((a: EncumbranceAccount) => (
                <tr key={a.CODE_COMBINATION_ID}>
                  <th scope="row" className="enc-acct__cell">
                    {a.ACCOUNT}
                  </th>
                  <td className="n enc-num">{num(a.PO_DISTRIBUTIONS)}</td>
                  <td className="n enc-num enc-num--lead">{money(a.PO_ENCUMBERED)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{num(unresolved.ACCOUNTS)} combinations</th>
                <td className="n enc-num">
                  {num(unresolvedRows.reduce((s, a) => s + a.PO_DISTRIBUTIONS, 0))}
                </td>
                <td className="n enc-num enc-num--lead">{money(unresolved.AMOUNT)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── The two sources in their own words, straight off the endpoint. ──── */}
      <section className="panel encpanel" aria-label="Where each side comes from">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">The two sides, and why they are kept apart</h2>
          </div>
        </div>
        <div className="panel__body">
          <dl className="encsrc">
            <dt>Purchasing side</dt>
            <dd>{notes.PO_SIDE}</dd>
            <dt>GL side</dt>
            <dd>{notes.GL_SIDE}</dd>
            <dt>Why no combined total</dt>
            <dd>{notes.DISAGREEMENT}</dd>
          </dl>
          <p className="chart-note">
            The {pluralise(both.length, 'account')} appearing in both:{' '}
            {both.map((a, i) => (
              <span key={a.CODE_COMBINATION_ID}>
                {i > 0 ? ', ' : ''}
                <code>{a.ACCOUNT}</code>
              </span>
            ))}
            .
          </p>
        </div>
      </section>
    </div>
  );
}
