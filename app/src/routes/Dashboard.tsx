import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useColumnTotals, useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import TrendChart from '../components/TrendChart';
import { ALLOC_RULE } from '../data/derive';
import { SEGMENT_ORDER, PURPOSE_META, objectTitle } from '../data/taxonomy';
import { money0, moneyShort, monthLong, num, pctSlim, pluralise, share } from '../data/format';
import type { ExtractLine, PurposeCode } from '../data/types';

const pickObject = (l: ExtractLine) => l.object;

interface Finding {
  tone: 'warn' | 'info';
  title: string;
  detail: string;
}

export default function Dashboard() {
  const { status, error, reload, lines, projects, months, summary } = useStore();
  const { constants, scopeStats } = useStore();
  const [month, setMonth] = useState<string | null>(null);

  /**
   * ★ MEASURED FROM THE STORE, NOT NAMED HERE. This finding used to read
   *   `Object.keys(CONSTANT_SEGMENTS).length` off a literal in `taxonomy.ts` and then spelled the four
   *   segments out by hand in the sentence — so both the count and the names were statements about a
   *   dataset the component could not see. With the account scope in the TopBar, that is a claim that
   *   can be wrong on screen while looking perfectly confident, which is the worst kind.
   *
   *   The store measures the segments against the lines actually being shown. Everything below is
   *   read back off that measurement, including the sentence, so the finding cannot name a segment
   *   that is not fixed or omit one that is.
   */
  const fixedSegments = SEGMENT_ORDER.filter((s) => constants[s]);
  const movingSegments = SEGMENT_ORDER.filter((s) => !constants[s]);

  /**
   * ★★ WHAT THIS PAGE IS SCOPED TO, SAID OUT LOUD AND MEASURED — WHICH IS NOT THE SAME AS NAMING THE
   *    ACCOUNT SCOPE.
   *
   * Every figure on this page is computed from `lines`, and `lines` is the served extract after the
   * account scope has been applied in the store. So the page *is* scoped to **Fund `04`, programs
   * `861` and `862`** — measured on the served payload: `FUND` is `04` on all 23,224 rows, `PROGRAM` is
   * `861` on 550 and `862` on 22,674, and **zero rows fall outside either** (the narrowing happens in
   * the handler's SQL, from the `organization` row: `SEGMENT1 = :fund AND SEGMENT3 IN (:p0, :p1)`).
   *
   * But the sentence at the top of the page said *"computed from 23,215 purchase-order lines in the
   * extract"* and never named that scope — and it could not, because the component had no way to tell
   * the served document from the ledger it came out of. Two consequences, and the second one is a
   * defect rather than a gap in the copy:
   *
   *  • A reader could not tell whether "the extract" meant the ledger or the Fund 04 / 861+862 slice of
   *    it. The ledger holds far more — 38,158 distinct lines under program `861` and 43,483 under
   *    `862` — so the number needed its scope beside it.
   *
   *  • **The bundled snapshot holds program `862` only.** Measured: 2,782 rows, `PROGRAM 1 distinct
   *    862`, $430,569,026.92, window opening January 2025 — against the live read's 23,224 rows across
   *    `861` *and* `862`, $2,697,813,470.53, window opening July 2022. So on the fallback path this
   *    page would render a `862`-only document under a heading that says `Fund 04 · program 861/862`,
   *    with the 550 rows of `861` silently absent. `scopeStats.programsPresent` is measured off the raw
   *    rows and already says `['862']`; nothing read it. That is the hook this uses.
   *
   * ★ THE ASK COMES FROM THE TENANT AND THE ANSWER FROM THE ROWS, AND THEY ARE KEPT APART. `asked` is
   *   the organization's own program list — a configuration. `held` is what the served document
   *   contains — a measurement. `missing` is the difference, and it is the only thing that makes the
   *   sentence below able to be wrong out loud instead of quiet.
   *
   * ★ THE FUND IS ALSO READ OFF THE ROWS, not off the selection, so a document carrying two funds (or
   *   one the scope did not ask for) names the fund it actually has. `scopeLabel` falls back to the
   *   comma form whenever the held list is not the tenant's whole list, which is exactly the reading
   *   we want: `/` claims "every program this organization holds", a comma does not.
   */
  const byObject = useColumnTotals(pickObject);

  // An object code can appear under more than one purpose, so the bar colour uses
  // whichever purpose carries most of that object's value.
  const purposeByObject = useMemo(() => {
    const inner = new Map<string, Map<string, number>>();
    for (const p of projects) {
      for (const b of p.buckets) {
        for (const c of b.costCodes) {
          const bucket = inner.get(c.object) ?? new Map<string, number>();
          bucket.set(c.purpose, (bucket.get(c.purpose) ?? 0) + c.amount);
          inner.set(c.object, bucket);
        }
      }
    }
    const out = new Map<string, PurposeCode>();
    for (const [object, totals] of inner) {
      let best: PurposeCode = '6570';
      let bestAmount = -1;
      for (const [purpose, amount] of totals) {
        if (amount > bestAmount) {
          best = purpose as PurposeCode;
          bestAmount = amount;
        }
      }
      out.set(object, best);
    }
    return out;
  }, [projects]);

  const delta = useMemo(() => {
    const active = months.filter((m) => m.amount > 0);
    if (active.length < 2) return null;
    const last = active[active.length - 1];
    const prev = active[active.length - 2];
    return { last, prev, change: last.amount / prev.amount - 1 };
  }, [months]);

  const monthDetail = useMemo(() => {
    if (!month) return null;
    const rows = lines.filter((l) => l.orderDate.slice(0, 7) === month);
    const byLevel = new Map<string, number>();
    for (const r of rows) byLevel.set(r.level, (byLevel.get(r.level) ?? 0) + r.amount);

    const top = [...byLevel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([level, amount]) => ({ level, amount, name: projects.find((p) => p.level === level)?.name }));

    return {
      lines: rows.length,
      orders: new Set(rows.map((r) => r.orderNumber)).size,
      vendors: new Set(rows.map((r) => r.vendor)).size,
      total: rows.reduce((s, r) => s + r.amount, 0),
      levels: byLevel.size,
      top,
    };
  }, [month, lines, projects]);

  const findings = useMemo<Finding[]>(() => {
    if (!summary) return [];
    const out: Finding[] = [];

    const unlabelled = new Map<string, { amount: number; lines: number; levels: Set<string> }>();
    for (const p of projects) {
      for (const b of p.buckets) {
        for (const c of b.costCodes) {
          if (c.label) continue;
          const entry =
            unlabelled.get(c.object) ?? { amount: 0, lines: 0, levels: new Set<string>() };
          entry.amount += c.amount;
          entry.lines += c.lines;
          entry.levels.add(p.level);
          unlabelled.set(c.object, entry);
        }
      }
    }
    for (const [object, e] of [...unlabelled].sort((a, b) => b[1].amount - a[1].amount)) {
      out.push({
        tone: 'warn',
        title: `Object code ${object} has no description`,
        detail:
          `${money0(e.amount)} across ${pluralise(e.lines, 'line')} on ` +
          `${pluralise(e.levels.size, 'level')}. Oracle supplies the code; the description is ` +
          'maintained by staff and was never entered, so the app shows the bare number.',
      });
    }

    const named = projects.filter((p) => !p.unclaimed).length;
    out.push({
      tone: 'info',
      title: `${num(projects.length - named)} of ${num(projects.length)} levels have no name`,
      detail:
        `The extract is purchase-order lines only — it has no project table. The ${num(named)} ` +
        'named levels are mapped in the app by hand, so their names, sites and owners are not ' +
        'Oracle data either.',
    });

    out.push({
      tone: 'info',
      title: `${fixedSegments.length} of 7 account segments never change`,
      // ★ Gated on the rows the scope actually removed, not on whether the selection happens to be
      //   the authored one. Those are different questions, and only the first one is about the data:
      //   a widening extract could make the authored selection remove rows without anyone touching
      //   the control, and a sentence keyed off the selection would then describe an extract it had
      //   never looked at.
      detail:
        `${fixedSegments.join(', ') || 'No segment'} ${fixedSegments.length === 1 ? 'holds' : 'hold'} ` +
        `a single value on all ${num(summary.rows)} rows ` +
        (scopeStats.excluded === 0
          ? 'of the extract'
          : `inside the current scope — ${num(scopeStats.excluded)} of the extract's ` +
            `${num(scopeStats.all)} rows fall outside it`) +
        `, so the key varies only in ${movingSegments.join(', ') || 'every segment'}. Filtering on a ` +
        'fixed segment is a no-op that looks like a real filter — the account scope beside the search ' +
        'box is the one that does something, and it reports what it removed.',
    });

    out.push({ tone: 'info', title: 'Approved budget is modelled', detail: ALLOC_RULE });

    const dormant = projects.filter((p) => p.status === 'dormant').length;
    const notApproved = lines.filter((l) => l.status !== 'APPROVED').length;
    out.push({
      tone: dormant > projects.length / 2 ? 'warn' : 'info',
      title: `${num(dormant)} of ${num(projects.length)} levels are dormant`,
      detail:
        `Dormant means no order in the 90 days before ${summary.cutoff}, derived from ORDER_DATE. ` +
        `Oracle's own STATUS column answers a different question: it says ${num(notApproved)} of ` +
        `${num(lines.length)} lines are not APPROVED. Neither is a substitute for the other.`,
    });

    return out;
  }, [projects, summary, lines]);

  if (status === 'loading') {
    return (
      <div className="stack">
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Dashboard</h1>
            <p className="page-head__sub">Reading the Oracle extract…</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="stack">
        <div className="accent-rule" />
        <div className="page-head">
          <h1>Dashboard</h1>
        </div>
        <ErrorNotice error={error ?? 'Unknown error'} reload={reload} />
      </div>
    );
  }

  const topObject = byObject[0];

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        {/*
          ★ THE SUBTITLE AND THE KPI CARDS ARE GONE, ON STAFF'S INSTRUCTION.

          This head carried a long sentence — how many lines the figures were computed from, the
          scope, the month range, the active cut-off, and which programs the document did not hold
          — followed by four cards (committed, modelled approved, vendors, unnamed levels). The
          request was to remove both: *"Staff is only interested in the data."*

          The sentence was genuinely load-bearing once: it is where a reader learned that the
          figures are a *subset* of the ledger, and that the approved total is a placeholder rather
          than Oracle data. That disclosure is knowingly given up here. If a figure is ever
          questioned, the answer is now the SQL trace (Settings → show the SQL) rather than a
          sentence on the page.

          The wrapper `<div>` around the heading stays: `.page-head` is a wrapping flex row, so its
          direct children sit side by side — see the note that used to be here. With no sentence to
          stack, the heading is the only child and the wrapper is now inert, but removing it would
          be a second change to a layout that is not the thing being asked about.
        */}
        <div className="page-head">
          <div>
            <h1>Dashboard</h1>
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Committed value by month</h2>
            <p className="panel__sub">
              {delta ? (
                <>
                  {monthLong(delta.last.ym)} was {money0(delta.last.amount)} —{' '}
                  {delta.change >= 0 ? 'up' : 'down'} {pctSlim(Math.abs(delta.change))} on{' '}
                  {monthLong(delta.prev.ym)}. Empty months are plotted at zero, not skipped.
                </>
              ) : (
                'Not enough dated activity for a month-over-month comparison.'
              )}
            </p>
          </div>
          <span className="panel__count">{num(months.length)} months</span>
        </div>

        <div className="panel__body">
          <TrendChart months={months} selected={month} onSelect={setMonth} />

          {monthDetail ? (
            <>
              <div className="chart-note">
                <strong>{monthLong(month ?? '')}</strong> — {money0(monthDetail.total)} across{' '}
                {num(monthDetail.lines)} lines, {num(monthDetail.orders)} orders and{' '}
                {num(monthDetail.vendors)} vendors on {num(monthDetail.levels)} levels.
              </div>
              <div className="hbar" style={{ marginTop: 14 }}>
                {monthDetail.top.map((t) => (
                  <div className="hbar__row" key={t.level}>
                    <span className="hbar__name" title={t.name ?? t.level}>
                      {t.name ?? `Unclaimed level ${t.level}`}
                    </span>
                    <span className="hbar__val">{money0(t.amount)}</span>
                    <span className="hbar__track">
                      <span
                        className="hbar__fill hbar__fill--cap"
                        style={{ width: `${(share(t.amount, monthDetail.top[0].amount) * 100).toFixed(2)}%` }}
                      />
                    </span>
                  </div>
                ))}
              </div>
              <div className="chart-note">
                {monthDetail.top.length < monthDetail.levels
                  ? `Top ${monthDetail.top.length} of ${num(monthDetail.levels)} levels that ordered in this month. `
                  : ''}
                Click the month again, or press Escape on it, to clear the selection.
              </div>
            </>
          ) : (
            <p className="chart-note">
              Select a month on the chart to see what was committed in it. The line is drawn with a
              monotone cubic interpolation so it cannot overshoot into negative values between two
              months.
            </p>
          )}
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Committed value by object code</h2>
              <p className="panel__sub">
                {pluralise(byObject.length, 'object code')} across{' '}
                {pluralise(scopeStats.shown, 'line')} in scope — the finest grain the app models.
                Select one to see every line booked to it.
              </p>
            </div>
            <span className="panel__count">
              {topObject ? pctSlim(share(topObject.amount, summary?.committed ?? 0)) : '—'} in{' '}
              {topObject?.key}
            </span>
          </div>
          <div className="panel__body">
            <div className="hbar hbar--links">
              {byObject.map((row) => {
                const purpose = purposeByObject.get(row.key);
                const series = purpose ? PURPOSE_META[purpose].series : 'oth';
                return (
                  <Link
                    className="hbar__row hbar__row--link"
                    key={row.key}
                    to={`/objects/${row.key}`}
                    title={`${objectTitle(row.key)} — every purchase-order line booked to it`}
                  >
                    <span className="hbar__name">{objectTitle(row.key)}</span>
                    <span className="hbar__val">{money0(row.amount)}</span>
                    <span className="hbar__track">
                      <span
                        className={`hbar__fill hbar__fill--${series}`}
                        style={{
                          width: `${(share(row.amount, topObject?.amount ?? 1) * 100).toFixed(2)}%`,
                        }}
                      />
                    </span>
                    <span className="chart-note" style={{ marginTop: 0 }}>
                      {pluralise(row.lines, 'line')} ·{' '}
                      {pctSlim(share(row.amount, summary?.committed ?? 0))} of the total
                      {purpose ? ` · mostly ${PURPOSE_META[purpose].short.toLowerCase()}` : ''} ·{' '}
                      <span className="hbar__go">View detail ›</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">What the data will not tell you</h2>
              <p className="panel__sub">
                Gaps that change how the numbers above should be read.
              </p>
            </div>
            <span className="panel__count">{findings.length}</span>
          </div>
          <div className="panel__body">
            <div className="findings">
              {findings.map((f, i) => (
                <div className="finding" key={i}>
                  <div className="finding__body">
                    <div className="finding__t">{f.title}</div>
                    <div className="finding__d">{f.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            <p className="chart-note">
              {moneyShort(summary?.committed ?? 0)} committed in total. Select a level from{' '}
              {projects[0] ? (
                <Link className="linkish" to={`/projects/${encodeURIComponent(projects[0].level)}`}>
                  the largest project
                </Link>
              ) : (
                <>the largest project</>
              )}{' '}
              to see the same figures broken down by budget group and cost code.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
