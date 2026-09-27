/**
 * Journal entries — the register under `/funding/journals`.
 *
 * ── WHAT THIS SCREEN IS ─────────────────────────────────────────────────────
 *
 * `nav/menu.ts` describes this leaf as *"the unfiltered journal. Adjustments and
 * Changes are two readings of this list; this leaf is the list itself, with a
 * per-journal detail route already served."* So: one row per journal header, a
 * filter bar over the columns the server actually indexes, and a drill-in to the
 * journal's own totals and lines.
 *
 * ── ★ THE THREE FACTS THIS SCREEN IS BUILT AROUND, ALL MEASURED ──────────────
 *
 * 1. **AN UNFILTERED READ IS REFUSED, AND THAT IS THE DESIGN.**
 *    `GET /api/funding/journals` with no filter answers `503 DB_UNAVAILABLE`,
 *    because the list runs `COUNT(*)` over every `GL_JE_HEADERS` row, finds more
 *    than `ALL_MAX_RECORDS` (1,000,000) of them, and `refuseIfOverCeiling`
 *    refuses rather than truncating. This is not a broken screen: it is the
 *    ledger telling the truth about a table that is too big to summarise.
 *
 *    The screen therefore does not, and cannot, default to "everything". It is
 *    built so the *narrowed* read is the normal one, and the refusal is rendered
 *    as a first-class state with the server's own sentence, the ceiling, the
 *    variable that sets it and the fix — rather than as a red box that a reader
 *    reads as "this page is broken".
 *
 * 2. **`ACTUAL_FLAG` IS THE PARTITION THE CEILING FORCES, SO IT IS THE PRIMARY
 *    CONTROL.** Measured: `B` 143,587 · `E` 564,101 · `A` 303,771. Each is under
 *    the ceiling on its own; the three together are over it. That is not a
 *    coincidence to be worked around — it is the shape of the ledger, and the
 *    control is laid out as what it is.
 *
 * 3. **INTEGER IDS ARRIVE AS STRINGS.** `JE_HEADER_ID` is `"12891592"`. The
 *    interfaces in `data/journals.ts` say `string`, and the row's id is used as a
 *    URL segment and a React key without ever passing through `Number()`.
 *
 * ── WHAT THIS SCREEN DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 *   · **It does not classify a journal as an adjustment.** The sibling leaf
 *     `/funding/adjustments` says the split *"is a classification the screen has
 *     to make, not one the table carries"*. Having read the table, the honest
 *     answer is that this screen declines too: there is no adjustment column, and
 *     the two columns that could be mistaken for one are contradictory —
 *     `JE_CATEGORY` holds `"1"`, `"2"`, `"4"`, `"Budget"`, `"Payroll"` and
 *     `"Purchase Invoices"` in one column. Inventing a rule and then trusting it
 *     is worse than leaving the leaf unbuilt, so *adjustment* is not offered.
 *
 *   · **It does not resolve a line's account.** A line names a
 *     `CODE_COMBINATION_ID`; turning that into fund and program segments is a
 *     join against `GL_CODE_COMBINATIONS` per line, over a line register of
 *     294,855 rows. The page states this rather than joining it quietly.
 *
 *   · **It does not recompute a journal's totals.** `/{id}/detail` computes
 *     debits, credits and their difference server-side; the page prints them and
 *     says what they are, including when they do not agree.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import ErrorNotice from '../components/ErrorNotice';
import { ScopeNotApplied } from '../components/ScopeNote';
// ★ A NAMED EXPORT, unlike the two above it. `SqlNote` is the only one of the
// three shell components with no default — it ships alongside the `SqlTrace` type
// in the same module, so the module exports the type and the component together
// rather than a default plus a type.
import { SqlNote } from '../components/SqlNote';
import { money, money0, num, pluralise } from '../data/format';
import { printElement } from '../lib/printPanel';
import {
  ACTUAL_FLAGS,
  DEFAULT_FLAG,
  JOURNALS_LIMIT,
  JournalReadError,
  balanceOf,
  dayOrDash,
  flagLabel,
  groupPeriods,
  isAbort,
  isAdjustmentPeriod,
  journalTitle,
  journalsCsv,
  journalsUrl,
  loadFlagCounts,
  loadJournalDetail,
  loadJournals,
  loadPeriods,
  moneyOrDash,
  observed,
  statusLabel,
  truncationOf,
  type JournalDetail,
  type JournalHeader,
  type JournalPage,
  type PeriodRow,
} from '../data/journals';

/** A URL parameter that means "this filter is not applied". */
const ALL = 'all';

/**
 * The sortable columns — the descriptor's own `sortable` list, minus
 * `JE_HEADER_ID` on the table (it is the key, and sorting by it twice is noise).
 *
 * ★ ONLY THESE MAY REACH `?sort=`. `parseSort` rejects a name outside the
 *   descriptor's `sortable` array with a `400`, so a column offered here that the
 *   server does not know is a click that breaks the page.
 */
const SORTABLE = {
  period: 'PERIOD_NAME',
  category: 'JE_CATEGORY',
  created: 'DATE_CREATED',
  effective: 'DEFAULT_EFFECTIVE_DATE',
  id: 'JE_HEADER_ID',
} as const;

/** The server's own default, spelled out so the header can show which column is active. */
const DEFAULT_SORT = `-${SORTABLE.effective}`;

/** Clicking a header ascends, clicking it again descends. `-` is the server's descending prefix. */
function nextSort(column: string, current: string): string {
  return current.startsWith('-') && current.slice(1) === column ? column : `-${column}`;
}

function sortDirection(column: string, current: string): 'ascending' | 'descending' | undefined {
  const active = current.startsWith('-') ? current.slice(1) : current;
  if (active !== column) return undefined;
  return current.startsWith('-') ? 'descending' : 'ascending';
}

/** What the filter bar says the current read is, for the print masthead. */
function scopeSentence(f: {
  flag: string;
  period: string | null;
  category: string | null;
  source: string | null;
  status: string | null;
  q: string;
}): string {
  const parts: string[] = [f.flag === ALL ? 'Every flag' : `${flagLabel(f.flag)} journals`];
  parts.push(f.period ? `period ${f.period}` : 'every period');
  if (f.category) parts.push(`category ${f.category}`);
  if (f.source) parts.push(`source ${f.source}`);
  if (f.status) parts.push(`status ${statusLabel(f.status)}`);
  if (f.q) parts.push(`matching “${f.q}”`);
  return parts.join(' · ');
}

export default function JournalEntries() {
  const [params, setParams] = useSearchParams();

  /* The filter state lives in the URL, so a narrowed register is a link somebody
     can send — the same reading `Encumbrances` and `PurchaseOrders` take. */
  const flag = params.get('flag') ?? DEFAULT_FLAG;
  const period = params.get('period');
  const category = params.get('category');
  const source = params.get('source');
  const status = params.get('status');
  const sort = params.get('sort') ?? DEFAULT_SORT;
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
  const journalId = params.get('journal');

  /* `q` is the one filter that is *not* committed per keystroke: the search runs
     in SQL over five columns of a 143,587-row partition, so it is committed on
     submit and on blur rather than on every character. */
  const [draft, setDraft] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');

  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((n) => n + 1);

  const [page, setPage] = useState<JournalPage | null>(null);
  const [failure, setFailure] = useState<JournalReadError | null>(null);
  const [status_, setStatus_] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [periodsNote, setPeriodsNote] = useState<string | null>(null);
  /** The size of each flag, or `null` where the count itself was refused. */
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* ── The register ────────────────────────────────────────────────────────── */

  useEffect(() => {
    const controller = new AbortController();
    setStatus_('loading');
    loadJournals(
      {
        flag: flag === ALL ? null : flag,
        period,
        q,
        category,
        source,
        status,
        sort,
        limit: JOURNALS_LIMIT,
        offset,
      },
      controller.signal,
    )
      .then((result) => {
        setPage(result);
        setFailure(null);
        setStatus_('ready');
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setPage(null);
        setFailure(
          err instanceof JournalReadError
            ? err
            : new JournalReadError(err instanceof Error ? err.message : String(err), {
                code: 'UNKNOWN',
                status: 0,
                details: null,
              }),
        );
        setStatus_('failed');
      });
    return () => controller.abort();
  }, [flag, period, q, category, source, status, sort, offset, attempt]);

  /* ── The calendar, for the period control ────────────────────────────────
     A failure here is not a failed page: the register reads without a period
     filter and the reader can still search. So it degrades to a note on the
     control rather than to an error screen. */
  useEffect(() => {
    const controller = new AbortController();
    loadPeriods(controller.signal)
      .then((rows) => {
        setPeriods(rows);
        setPeriodsNote(null);
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setPeriods([]);
        setPeriodsNote(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [attempt]);

  /* ── The size of each flag ───────────────────────────────────────────────
     Three counts, best-effort — `loadFlagCounts` never rejects. They label the
     control with how much is behind it, which is what makes "Encumbrance is four
     times Budget" visible before a reader commits to one. */
  useEffect(() => {
    const controller = new AbortController();
    loadFlagCounts(controller.signal)
      .then(setCounts)
      .catch(() => undefined);
    return () => controller.abort();
  }, [attempt]);

  /* ── The drill-in ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!journalId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    loadJournalDetail(journalId, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [journalId, attempt]);

  /* ── Writing the URL ───────────────────────────────────────────────────── */

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    /* ★ A FILTER CHANGE RETURNS TO THE FIRST WINDOW. Page 4 of one register is a
       different set of rows in another, and an `offset` left behind would show an
       empty table whose emptiness is arithmetic rather than a fact about the
       filter. A selection (`journal`) is not a filter, so it keeps the window. */
    if (key !== 'offset' && key !== 'journal') next.delete('offset');
    setParams(next, { replace: true });
  };

  const commitSearch = () => {
    const term = draft.trim();
    if (term === q) return;
    setQ(term);
    setParam('q', term);
  };

  const clearAll = () => {
    setDraft('');
    setQ('');
    setParams(new URLSearchParams(), { replace: true });
  };

  /* ── Derived ────────────────────────────────────────────────────────────── */

  const rows = page?.rows ?? [];
  const filtered = Boolean(period || category || source || status || q);
  const narrowed = flag !== ALL || filtered;

  const periodGroups = useMemo(() => groupPeriods(periods), [periods]);

  /* The facet options are the values **on this page**, not a vocabulary written
     into the app — see `observed()` in `data/journals.ts` for why there is no
     vocabulary to write. */
  const categories = useMemo(() => observed(rows.map((r) => r.JE_CATEGORY)), [rows]);
  const sources = useMemo(() => observed(rows.map((r) => r.JE_SOURCE)), [rows]);
  const statuses = useMemo(() => observed(rows.map((r) => r.STATUS), 4), [rows]);

  const shownFlag = flag === ALL ? null : flag.trim().toUpperCase();
  const anyEncumbrance = rows.some((r) => (r.ACTUAL_FLAG ?? '').trim().toUpperCase() === 'E');
  const anyBlankEffective = rows.some((r) => !r.DEFAULT_EFFECTIVE_DATE);

  const truncation = page ? truncationOf(page, shownFlag ? `The ${flagLabel(shownFlag)} register` : 'The register') : null;

  const printRef = useRef<HTMLDivElement>(null);
  const print = () => {
    if (!printRef.current) return;
    printElement(printRef.current, {
      title: 'Journal entries',
      scope: scopeSentence({ flag, period, category, source, status, q }),
      orientation: 'landscape',
    });
  };

  const download = (csv: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const csvName = `journals-${(shownFlag ?? 'all-flags').toLowerCase()}${period ? `-${period}` : ''}.csv`;

  /* ── The two failure states ──────────────────────────────────────────────
     ★ SPLIT ON PURPOSE. A refusal caused by the row ceiling is not a fault; it is
     the ledger declining to count 1,011,459 rows, and it has a fix the reader can
     apply in one click. Every other failure is a fault and gets the ordinary
     notice. Rendering both the same way would tell a reader to go and check the
     database when the answer is "narrow the read". */

  if (status_ === 'failed' && failure) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          <div className="page-head">
            <div>
              <h1>Journal entries</h1>
              <p className="page-head__sub">
                The journal register, {shownFlag ? <>{flagLabel(shownFlag).toLowerCase()} journals</> : 'every flag'},
                read from <code>GL_JE_HEADERS</code> over the API.
              </p>
            </div>
          </div>
        </div>

        {failure.overCeiling ? (
          <JrnCeiling
            error={failure}
            request={journalsUrl({ flag: flag === ALL ? null : flag, period, q, category, source, status, sort, limit: JOURNALS_LIMIT, offset })}
            /* ★ ONE URL WRITE PER CLICK. `setParam` builds its next URL from the
               params of the render it was created in, so two calls in a row would
               write the second on top of the first and drop the flag — leaving the
               reader refused again by a button that promised to narrow. */
            onApply={(name) => {
              const next = new URLSearchParams(params);
              next.set('flag', name);
              next.delete('offset');
              setParams(next, { replace: true });
            }}
            active={flag}
            counts={counts}
          />
        ) : (
          <ErrorNotice
            error={failure.message}
            reload={reload}
            heading="The journal register could not be read."
            hint={
              <>
                <p>
                  This page reads neither the extract nor a file under{' '}
                  <code>app/public/oracle/</code>. It reads <code>/api/funding/journals</code>,
                  which lists <code>GL_JE_HEADERS</code> in the database, so a failure here is the
                  server rather than a missing file.
                </p>
                <p>
                  The request was <code>{failure.code}</code> at <code>{failure.status || 'no'}</code>{' '}
                  status{failure.details?.table ? <> against <code>{failure.details.table}</code></> : null}.
                </p>
              </>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Journal entries</h1>
            <p className="page-head__sub">
              One row per journal header in <code>GL_JE_HEADERS</code>, with the totals and lines
              of each journal served by <code>/api/funding/journals/&#123;id&#125;/detail</code>.
            </p>
          </div>
        </div>
      </div>

      {/* ── ★ THE SCOPE DECISION. Unconditional, and it has to be. ──────────
          A note shown only when the scope *would* remove something is invisible
          in the one case it matters: when the narrowing happened upstream and
          this register is the only page that disagrees with every other total in
          the app. `GL_JE_HEADERS` has no account segment at all, so the scope can
          never apply here — which is a permanent fact about this page, not a
          measurement of today's selection. */}
      <ScopeNotApplied register="A journal header" />

      {/* ── ★ THE STANDING NOTE: WHY THIS REGISTER IS FILTERED BY FLAG. ─────
          Printed above the figures rather than beside the control, because the
          misreading it prevents — "this screen is only showing me a third of the
          journals, so it is broken" — is formed on arrival, before the control is
          read. The three counts are the measured sizes of the ledger's own flags
          and they are the whole argument, and only the first two are shown: the
          third would be needed to prove the sum, and it goes stale the moment
          anybody posts a journal. */}
      <p className="scopenote scopenote--jrn" role="note">
        <span className="scopenote__flag">Flag is not optional</span>
        <span className="scopenote__text">
          The ledger holds more journals than one request is allowed to count, so an unfiltered read
          of this register is <strong>refused rather than truncated</strong> — see{' '}
          <code>ALL_MAX_RECORDS</code> below. The three values of <code>ACTUAL_FLAG</code> are each
          under that ceiling on their own and the three together are over it, which is why the flag
          is the first control on this bar rather than the last. Every row is still reachable: the
          flag picks the population, and the period, category, source and search narrow inside it.
        </span>
      </p>

      {/* ── The filter bar ─────────────────────────────────────────────────── */}
      <section className="panel jrnpanel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">The register</h2>
            <p className="panel__sub">
              One row per journal. Open a row for its totals, its balance and its lines.
            </p>
          </div>
          {status_ === 'ready' && page ? (
            <span className="panel__count">
              {num(page.returned)} of {num(page.total)}
            </span>
          ) : null}
        </div>

        <div className="filterbar jrnfilter" role="group" aria-label="Filter journals">
          {/* The flag — the population. ★ Every value is offered, including the
              one that refuses, because "why can I not see all of them" is the
              question this control exists to answer. */}
          <div className="jrnflags" role="group" aria-label="Which kind of journal">
            <span className="jrnflags__label">Ledger</span>
            {ACTUAL_FLAGS.map((f) => (
              <button
                key={f.value}
                type="button"
                className="jrnflag"
                aria-pressed={flag === f.value}
                title={f.blurb}
                onClick={() => setParam('flag', f.value)}
              >
                {f.label}
                <span className="jrnflag__n">
                  {counts[f.value] === null || counts[f.value] === undefined
                    ? '…'
                    : num(counts[f.value] as number)}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="jrnflag jrnflag--all"
              aria-pressed={flag === ALL}
              title="Every flag at once. The ledger refuses this: it is over the row ceiling."
              onClick={() => setParam('flag', ALL)}
            >
              All flags
              <span className="jrnflag__n">refused</span>
            </button>
          </div>

          {/* The period. ★ The calendar runs *ahead* of the journals — measured:
              `Jun-27-FY-27` and `Adj-27-FY-27` are the newest periods and both
              hold zero journals — so the picker is sorted newest-first and says
              which periods are future ones rather than pretending the newest is
              the fullest. */}
          <label className="jrnfield">
            <span className="jrnfield__label">Period</span>
            <select
              className="input jrnfield__input"
              value={period ?? ''}
              onChange={(e) => setParam('period', e.target.value || null)}
            >
              <option value="">Every period</option>
              {periodGroups.map((year) => (
                <optgroup key={year.year} label={`FY ${year.year}`}>
                  {year.periods.map((p) => (
                    <option key={p.PERIOD_NAME} value={p.PERIOD_NAME}>
                      {p.PERIOD_NAME}
                      {isAdjustmentPeriod(p) ? ' (adjustment)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="jrnsearch">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="6.6" cy="6.6" r="4.6" />
              <path d="M10.2 10.2 14 14" />
            </svg>
            <label className="sr" htmlFor="jrn-q">
              Search journals by name, description, period, category or source
            </label>
            <input
              id="jrn-q"
              type="search"
              autoComplete="off"
              placeholder="Name, description, period, category or source…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitSearch}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch();
                if (e.key === 'Escape') {
                  setDraft('');
                  if (q) setParam('q', null);
                }
              }}
            />
            {q ? (
              <button
                type="button"
                className="fchip"
                onClick={() => {
                  setDraft('');
                  setParam('q', null);
                }}
                title="Clear the search"
              >
                Clear “{q}”
              </button>
            ) : null}
          </div>

          {/* Category, source and status, each populated from the rows on screen.
              ★ THE OPTIONS ARE OBSERVED, NOT DECLARED: `JE_CATEGORY` really does
              hold `"1"`, `"2"`, `"4"`, `"Budget"`, `"Payroll"` and
              `"Purchase Invoices"` in one column on one ledger, so a select with a
              written-out vocabulary would offer values that do not exist and hide
              the ones that do. */}
          {categories.length > 1 ? (
            <label className="jrnfield">
              <span className="jrnfield__label">Category</span>
              <select
                className="input jrnfield__input"
                value={category ?? ''}
                onChange={(e) => setParam('category', e.target.value || null)}
              >
                <option value="">Any category</option>
                {categories.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.value} ({num(c.count)} on this page)
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {sources.length > 1 ? (
            <label className="jrnfield">
              <span className="jrnfield__label">Source</span>
              <select
                className="input jrnfield__input"
                value={source ?? ''}
                onChange={(e) => setParam('source', e.target.value || null)}
              >
                <option value="">Any source</option>
                {sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.value} ({num(s.count)} on this page)
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {statuses.length > 1 ? (
            <label className="jrnfield">
              <span className="jrnfield__label">Status</span>
              <select
                className="input jrnfield__input"
                value={status ?? ''}
                onChange={(e) => setParam('status', e.target.value || null)}
              >
                <option value="">Any status</option>
                {statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {statusLabel(s.value)} ({num(s.count)} on this page)
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="jrnfilter__actions">
            <button
              type="button"
              className="btn btn--system btn--sm"
              onClick={() => download(journalsCsv(rows), csvName)}
              disabled={rows.length === 0}
              title="The rows currently on screen — not the whole register"
            >
              Export this page
            </button>
            <button
              type="button"
              className="btn btn--system btn--sm"
              onClick={print}
              disabled={rows.length === 0}
              title="Prints the register as it looks, with the filter bar and the counts"
            >
              Print
            </button>
            {narrowed ? (
              <button type="button" className="btn btn--system btn--sm" onClick={clearAll}>
                Start over
              </button>
            ) : null}
          </div>
        </div>

        {periodsNote ? (
          <p className="chart-note jrn-pad">
            <strong>The period list could not be read</strong>, so the picker is empty and the
            register is being read without a period filter. {periodsNote}
          </p>
        ) : null}

        <p className="sr" role="status">
          {status_ === 'loading' || !page
            ? 'Reading the journal register.'
            : `${num(page.total)} journals match. Showing ${num(page.returned)}.`}
        </p>

        {status_ === 'loading' && !page ? (
          <div className="panel__body">
            <p className="jrnempty">Reading the journal register…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="jrnempty">
            <p>
              {narrowed
                ? 'No journal matches this read.'
                : 'No journal is in this register.'}
            </p>
            <p className="jrnempty__hint">
              {q
                ? `The search reads the journal's name, its description, its period, its category and its source — not its lines. “${q}” matched none of them inside the ${flagLabel(shownFlag)} population.`
                : period
                  ? `Nothing has been posted to ${period} under ${flagLabel(shownFlag).toLowerCase()} journals. An empty period is an answer: the calendar is provisioned years ahead of the postings, so the newest periods on the picker are the ones most likely to be empty.`
                  : 'An empty arrival is an answer rather than a missing one. Widen the filter bar, or pick a different flag.'}
            </p>
            {narrowed ? (
              <button type="button" className="btn btn--system btn--sm" onClick={clearAll}>
                Start over
              </button>
            ) : null}
          </div>
        ) : (
          <div className="jrn-layout">
            <div className="jrn-main" ref={printRef}>
              <div className="jrnwrap">
                <table className="data jrntable">
                  <caption className="sr">
                    Journal headers, one per row, with the ledger flag each carries and the period
                    it was posted to.
                  </caption>
                  <colgroup>
                    <col className="c-jrn-id" />
                    <col className="c-jrn-date" />
                    <col className="c-jrn-period" />
                    <col className="c-jrn-flag" />
                    <col className="c-jrn-cat" />
                    <col className="c-jrn-src" />
                    <col className="c-jrn-status" />
                    <col className="c-jrn-name" />
                  </colgroup>
                  <thead>
                    <tr>
                      <JrnTh column={SORTABLE.id} sort={sort} onSort={(c) => setParam('sort', c)} align="n">
                        Journal
                      </JrnTh>
                      <JrnTh column={SORTABLE.effective} sort={sort} onSort={(c) => setParam('sort', c)}>
                        Effective
                      </JrnTh>
                      <JrnTh column={SORTABLE.period} sort={sort} onSort={(c) => setParam('sort', c)}>
                        Period
                      </JrnTh>
                      <th scope="col">Ledger</th>
                      <JrnTh column={SORTABLE.category} sort={sort} onSort={(c) => setParam('sort', c)}>
                        Category
                      </JrnTh>
                      <th scope="col">Source</th>
                      <th scope="col">Status</th>
                      <th scope="col">Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.JE_HEADER_ID}
                        className={`jrntable__row${r.JE_HEADER_ID === journalId ? ' is-open' : ''}`}
                        onClick={() => setParam('journal', r.JE_HEADER_ID)}
                      >
                        <td className="n jrn-id">
                          <button
                            type="button"
                            className="jrn-link"
                            aria-expanded={r.JE_HEADER_ID === journalId}
                            aria-controls="journal-detail"
                            onClick={(e) => {
                              e.stopPropagation();
                              setParam('journal', r.JE_HEADER_ID);
                            }}
                          >
                            {r.JE_HEADER_ID}
                          </button>
                        </td>
                        {/* ★ `DEFAULT_EFFECTIVE_DATE` IS THE AUTHORITATIVE "WHEN WAS
                            THIS FUNDED?" — the funding module says so — so it is
                            the column the register is sorted by, ahead of
                            `DATE_CREATED`, which is when the row was written. */}
                        <td className="jrnn">{dayOrDash(r.DEFAULT_EFFECTIVE_DATE)}</td>
                        <td className="jrnn">{r.PERIOD_NAME ?? '—'}</td>
                        <td>
                          <span className={`jrnflagchip jrnflagchip--${(r.ACTUAL_FLAG ?? 'x').toLowerCase()}`}>
                            {flagLabel(r.ACTUAL_FLAG)}
                          </span>
                          {r.ENCUMBRANCE_TYPE_ID ? (
                            <span className="jrnsub"> type {r.ENCUMBRANCE_TYPE_ID}</span>
                          ) : null}
                        </td>
                        <td className="jrncat">{r.JE_CATEGORY ?? '—'}</td>
                        <td className="jrnsrc">{r.JE_SOURCE ?? '—'}</td>
                        <td className="jrnn">
                          <span className={`jrnstatus jrnstatus--${(r.STATUS ?? 'x').toLowerCase()}`}>
                            {statusLabel(r.STATUS)}
                          </span>
                        </td>
                        <td className="jrn-name">{journalTitle(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ★ THE DISCLOSURE. The count is the server's and the reader is told
                  the page is a page — the figures above describe the rows shown. */}
              {truncation ? (
                <div className="notice notice--warn jrn-pad" role="status">
                  <div>
                    <p>{truncation}</p>
                    <p className="chart-note">
                      Use the period, category or search to narrow inside the population — or step
                      through with the pager. Each page is read straight from the database; nothing
                      on this screen is a cached total.
                    </p>
                  </div>
                </div>
              ) : null}

              {page && page.total > page.returned ? (
                <div className="pager jrn-pad">
                  <button
                    type="button"
                    className="btn btn--system btn--sm"
                    disabled={offset === 0}
                    onClick={() => setParam('offset', String(Math.max(0, offset - JOURNALS_LIMIT)))}
                  >
                    Previous
                  </button>
                  <span className="pager__pages">
                    Journals {num(offset + 1)}–{num(offset + page.returned)} of {num(page.total)}
                  </span>
                  <button
                    type="button"
                    className="btn btn--system btn--sm"
                    disabled={offset + page.returned >= page.total}
                    onClick={() => setParam('offset', String(offset + JOURNALS_LIMIT))}
                  >
                    Next
                  </button>
                </div>
              ) : null}

              <p className="chart-note jrn-pad">
                The register reads <code>GL_JE_HEADERS</code> only. A journal&rsquo;s money is on its
                lines, which this table does not read — open a row for those, totalled by the server.
              </p>

              {anyEncumbrance ? (
                <p className="chart-note jrn-pad">
                  <strong>An encumbrance journal is a commitment, not a payment.</strong> Its{' '}
                  <code>ENCUMBRANCE_TYPE_ID</code> names the kind — and the ledger carries it as
                  text, not a number, which is why it prints as one.
                </p>
              ) : null}

              {anyBlankEffective ? (
                <p className="chart-note jrn-pad">
                  <strong>A dash under Effective is not a date of zero.</strong> At least one row on
                  this page carries no <code>DEFAULT_EFFECTIVE_DATE</code>, and a blank date left
                  that way is the ledger not answering the column — not the journal taking effect at
                  the epoch.
                </p>
              ) : null}
            </div>

            {/* ── The drill-in ────────────────────────────────────────────── */}
            {journalId ? (
              <aside className="jrn-detail" id="journal-detail" aria-label="Journal detail">
                <JournalDetailPanel
                  id={journalId}
                  detail={detail}
                  error={detailError}
                  onClose={() => setParam('journal', null)}
                  onRetry={reload}
                />
              </aside>
            ) : null}
          </div>
        )}

        <SqlNote trace={page?.sql} label="This page" />
      </section>

      {/* ── The footnote: what this screen declines to do, said once. ────── */}
      <p className="chart-note jrn-pad">
        <strong>What this register does not decide.</strong> There is no adjustment flag on{' '}
        <code>GL_JE_HEADERS</code>, so no row here is labelled an adjustment —{' '}
        <code>JE_CATEGORY</code> holds both codes (<code>1</code>, <code>2</code>,{' '}
        <code>4</code>) and words (<code>Budget</code>, <code>Payroll</code>,{' '}
        <code>Purchase Invoices</code>) in the same column, and a rule invented from those would be
        a classification the table does not carry. The flag above is the ledger&rsquo;s own, and
        it is the only one the row really has. A line&rsquo;s account is a{' '}
        <code>CODE_COMBINATION_ID</code>; resolving it to fund and program segments is a join this
        page does not make, which is why the account scope is stated as not applied at the top
        rather than silently obeyed.
      </p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * The characters
 * ════════════════════════════════════════════════════════════════════════════ */

/** A sortable header cell. A plain button, because the server is the sorter. */
function JrnTh({
  column,
  sort,
  onSort,
  align,
  children,
}: {
  column: string;
  sort: string;
  onSort: (column: string) => void;
  align?: 'n';
  children: ReactNode;
}) {
  const direction = sortDirection(column, sort);
  return (
    <th scope="col" aria-sort={direction} className={align === 'n' ? 'n' : undefined}>
      <button
        type="button"
        className="jrn-sort"
        onClick={() => onSort(nextSort(column, sort))}
        title={`Sort by ${column.toLowerCase().replace(/_/g, ' ')} — ${
          direction === 'descending' ? 'ascending' : 'descending'
        }`}
      >
        {children}
        <span className="jrn-sort__mark" aria-hidden="true">
          {direction === 'ascending' ? '▲' : direction === 'descending' ? '▼' : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * One journal, its totals and its lines.
 *
 * ★ EVERY FIGURE HERE IS THE SERVER'S. `/{id}/detail` computes debits, credits
 *   and `difference` over the journal's lines; this panel prints them and reports
 *   whether they agree. It never re-adds the lines shown underneath, because a
 *   total recomputed in the browser from a page of lines is a different claim
 *   from a total taken over all of them, wearing the same label.
 */
function JournalDetailPanel({
  id,
  detail,
  error,
  onClose,
  onRetry,
}: {
  id: string;
  detail: JournalDetail | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="jrn-detail__body">
        <div className="jrn-detail__head">
          <div>
            <h2 className="panel__title">Journal {id}</h2>
            <p className="panel__sub">Could not be read.</p>
          </div>
          <button type="button" className="jrn-detail__close" onClick={onClose} aria-label="Close the journal">
            ×
          </button>
        </div>
        <p className="jrn-detail__err" role="alert">
          {error}
        </p>
        <button type="button" className="btn btn--system btn--sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="jrn-detail__body">
        <div className="jrn-detail__head">
          <div>
            <h2 className="panel__title">Journal {id}</h2>
            <p className="panel__sub">Reading…</p>
          </div>
          <button type="button" className="jrn-detail__close" onClick={onClose} aria-label="Close the journal">
            ×
          </button>
        </div>
      </div>
    );
  }

  const j: JournalHeader = detail.journal;
  const balance = balanceOf(detail.totals);
  /* ★ HOISTED SO EACH OF THE THREE VERDICTS BELOW NARROWS ON ONE `const`.
     A verdict chain written on `balance.difference` directly is a chain the
     compiler is allowed to stop narrowing through, and the one thing this panel
     must never do is fall through to a claim about the ledger it cannot support. */
  const diff = balance.difference;
  /* ★ TRUNCATED LINES ARE DISCLOSED RATHER THAN SUMMED. The count is the server's,
     so if it exceeds what came with the payload the panel says so instead of
     printing a lines table that looks complete. */
  const linesShown = detail.lines.length;
  const linesHeld = detail.lineCount ?? linesShown;

  return (
    <div className="jrn-detail__body">
      <div className="jrn-detail__head">
        <div>
          <h2 className="panel__title">{journalTitle(j)}</h2>
          <p className="panel__sub">
            Journal {j.JE_HEADER_ID} · {j.PERIOD_NAME ?? 'no period'} · {flagLabel(j.ACTUAL_FLAG)}
          </p>
        </div>
        {/* ★ NO PIN HERE, AND IT IS A DECISION RATHER THAN AN OMISSION.
            `PinCategory` is `'project' | 'invoice' | 'check' | 'purchase-order'`
            — the four documents this app has a screen that can show a pinned one
            of. There is no pinned-journal destination, so a pin on this panel
            would write a row that links nowhere. The leaf is in the rail instead. */}
        <div className="jrn-detail__tools">
          <button type="button" className="jrn-detail__close" onClick={onClose} aria-label="Close the journal">
            ×
          </button>
        </div>
      </div>

      <dl className="jrndl">
        <div>
          <dt>Effective</dt>
          {/* `DEFAULT_EFFECTIVE_DATE` is the authoritative "when was this funded?". */}
          <dd>{dayOrDash(j.DEFAULT_EFFECTIVE_DATE)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{dayOrDash(j.DATE_CREATED)}</dd>
        </div>
        <div>
          <dt>Posted</dt>
          <dd>{dayOrDash(j.POSTED_DATE)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{statusLabel(j.STATUS)}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{j.JE_CATEGORY ?? '—'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{j.JE_SOURCE ?? '—'}</dd>
        </div>
        <div>
          <dt>Ledger id</dt>
          <dd>{j.LEDGER_ID ?? '—'}</dd>
        </div>
        <div>
          <dt>Encumbrance type</dt>
          <dd>{j.ENCUMBRANCE_TYPE_ID ?? '—'}</dd>
        </div>
      </dl>

      {j.DESCRIPTION ? (
        <div className="jrn-detail__desc">
          <h3 className="jrn-detail__h3">Description</h3>
          {/* The ledger's free text carries embedded newlines; `white-space: pre-line`
              is what keeps them as line breaks rather than collapsing them. */}
          <p className="jrn-detail__freetext">{j.DESCRIPTION}</p>
        </div>
      ) : null}

      <div className="jrn-totals">
        <h3 className="jrn-detail__h3">Totals, computed by the server over this journal&rsquo;s lines</h3>
        <div className="jrn-totals__grid">
          <div>
            <span className="jrn-totals__k">Debits</span>
            <span className="jrn-totals__v">{moneyOrDash(balance.debits)}</span>
          </div>
          <div>
            <span className="jrn-totals__k">Credits</span>
            <span className="jrn-totals__v">{moneyOrDash(balance.credits)}</span>
          </div>
          <div>
            <span className="jrn-totals__k">Difference</span>
            <span
              className={`jrn-totals__v jrn-totals__v--diff${
                diff === null ? '' : balance.balanced ? ' is-zero' : ' is-out'
              }`}
            >
              {moneyOrDash(diff)}
            </span>
          </div>
          <div>
            <span className="jrn-totals__k">Lines</span>
            <span className="jrn-totals__v">
              {num(linesHeld)}
              {linesHeld === 0 ? <span className="jrn-totals__note"> none served</span> : null}
            </span>
          </div>
        </div>

        {/* ★ THREE STATES, NOT TWO — see `balanceOf`. A journal whose totals were
            not reported is neither balanced nor out, and saying either would be a
            claim made from a missing number. */}
        <p className={`jrn-verdict${balance.balanced ? ' jrn-verdict--ok' : diff === null ? '' : ' jrn-verdict--out'}`}>
          {diff === null ? (
            <>
              <strong>The ledger did not report a difference</strong> for this journal, so this
              panel makes no claim about whether its two sides agree.
            </>
          ) : balance.balanced ? (
            <>
              <strong>The two sides agree.</strong> Debits less credits is {money0(diff)}, as a
              journal&rsquo;s should be.
            </>
          ) : (
            <>
              <strong>The two sides do not agree, and that is reported rather than corrected.</strong>{' '}
              Debits exceed credits by {money(diff)} on the ledger&rsquo;s own figures. This panel
              does not re-add the lines below to check them: a sum taken over a page of lines is a
              different claim from a sum taken over all of them.
            </>
          )}
        </p>
      </div>

      <h3 className="jrn-detail__h3">
        Lines{' '}
        {linesHeld > linesShown ? (
          <span className="jrn-detail__h3n">
            showing {num(linesShown)} of {pluralise(linesHeld, 'line')}
          </span>
        ) : null}
      </h3>

      {linesShown === 0 ? (
        <div className="jrnempty jrnempty--tight">
          <p>{linesHeld === 0 ? 'This journal has no lines on this ledger.' : 'No lines came back with this journal.'}</p>
          <p className="jrnempty__hint">
            The count above is the server&rsquo;s over <code>GL_JE_LINES</code>. A journal header
            with no lines is a real thing to find — the header was imported and the lines were not
            — and it is shown as zero rather than hidden.
          </p>
        </div>
      ) : (
        <div className="jrnlines">
          <table className="data jrnlinetable">
            <caption className="sr">The lines of this journal, as the server returned them.</caption>
            <thead>
              <tr>
                <th scope="col" className="n">
                  #
                </th>
                <th scope="col">Effective</th>
                <th scope="col">Account</th>
                <th scope="col" className="n">
                  Debit
                </th>
                <th scope="col" className="n">
                  Credit
                </th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l, i) => (
                <tr key={`${l.JE_HEADER_ID ?? id}-${l.JE_LINE_NUM ?? i}`}>
                  <td className="n jrnn">{l.JE_LINE_NUM ?? i + 1}</td>
                  <td className="jrnn">{dayOrDash(l.EFFECTIVE_DATE)}</td>
                  {/* ★ THE ACCOUNT IS NOT RESOLVED, AND THE CELL SAYS SO RATHER THAN
                      LOOKING EMPTY. A `CODE_COMBINATION_ID` is an id; printing it
                      under a heading called "Account" without saying that is the
                      small lie this column exists to avoid. */}
                  <td className="jrn-acct" title="A code combination id. This screen does not resolve it to fund and program segments.">
                    {l.CODE_COMBINATION_ID ?? '—'}
                  </td>
                  <td className="n jrnn">{moneyOrDash(l.ENTERED_DR)}</td>
                  <td className="n jrnn">{moneyOrDash(l.ENTERED_CR)}</td>
                  <td className="jrnlinedesc">
                    {l.DESCRIPTION ? (
                      <span className="jrn-detail__freetext">{l.DESCRIPTION}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="chart-note">
        Lines are read through <code>/api/funding/journals/&#123;id&#125;/detail</code> rather than
        by filtering <code>/api/funding/journal-lines</code> on{' '}
        <code>je_header_id</code>: the line register&rsquo;s filter is typed as an integer while the
        column is text, so the route that names the header is the one that resolves it.
      </p>
    </div>
  );
}

/**
 * The refusal, rendered as a state rather than as a fault.
 *
 * ★ THIS EXISTS BECAUSE A 503 IS NOT ALWAYS A BREAKAGE. `refuseIfOverCeiling`
 *   declines to count a register larger than `ALL_MAX_RECORDS` — and it explains
 *   itself better than any summary could, so its sentence is printed verbatim and
 *   the rest of the panel is built around it: what the ceiling is, what variable
 *   sets it, and the two things a reader can do about it.
 */
function JrnCeiling({
  error,
  request,
  onApply,
  active,
  counts,
}: {
  error: JournalReadError;
  request: string;
  /* Narrow to a ledger flag, in one URL write. */
  onApply: (flag: string) => void;
  /* The flag the reader is already on — offering it would refuse again. */
  active: string;
  /* What each flag holds, measured for the bar above. */
  counts: Record<string, number | null>;
}) {
  const { table, rows, ceiling, variable } = error.details ?? {};
  /*
   * ★ THE SHORTCUTS OFFERED HERE ARE THE FLAGS, NOT PERIODS, AND THAT IS A
   *   CORRECTION. The first version of this panel offered three periods — the
   *   newest three on the calendar — because the calendar is provisioned years
   *   ahead of the postings, and the newest periods are therefore the ones most
   *   likely to hold nothing (`Jun-27-FY-27` and `Adj-27-FY-27` both measure 0).
   *   So the escape hatch from a refusal led to an empty register, and since the
   *   filter bar is not rendered while refused, those three buttons were the only
   *   way out. A flag is the right offer: each is measured under the ceiling, each
   *   is populated, and the count beside it comes from the same probe the bar uses.
   */
  const offer = ACTUAL_FLAGS.filter((f) => f.value !== active);

  return (
    <div className="notice notice--warn jrnrefuse" role="alert">
      <div>
        <p>
          <strong>This read was refused, and the refusal is the ledger being honest.</strong>{' '}
          {error.message}
        </p>

        <dl className="jrnrefuse__facts">
          <div>
            <dt>Table</dt>
            <dd>
              <code>{typeof table === 'string' ? table : 'GL_JE_HEADERS'}</code>
            </dd>
          </div>
          <div>
            <dt>Rows it would have to count</dt>
            <dd>{typeof rows === 'number' ? num(rows) : 'more than the ceiling'}</dd>
          </div>
          <div>
            <dt>Ceiling</dt>
            <dd>{typeof ceiling === 'number' ? num(ceiling) : '1,000,000'}</dd>
          </div>
          <div>
            <dt>Set by</dt>
            <dd>
              <code>{typeof variable === 'string' ? variable : 'ALL_MAX_RECORDS'}</code> in{' '}
              <code>.env</code>
            </dd>
          </div>
        </dl>

        <p>
          Nothing was truncated and nothing was cached: the list runs a count over the whole table
          before it pages, and the server declines that count rather than answering with a total it
          cannot stand behind. So the register is <em>not</em> broken — it is being asked for more
          than it is allowed to summarise.
        </p>

        <p>
          <strong>Narrow it instead.</strong> The ledger flag is the partition the ceiling was sized
          against: each of the three values is under it on its own and the three together are over
          it, which is why the flag is the register&rsquo;s first control rather than its last.
          Choosing one here brings the filter bar back, and the period, category, source and search
          narrow inside it.
        </p>

        <div className="jrnrefuse__actions">
          {offer.map((f) => (
            <button
              key={f.value}
              type="button"
              className="btn btn--system btn--sm"
              onClick={() => onApply(f.value)}
            >
              {f.label} journals
              {typeof counts[f.value] === 'number' ? `, ${num(counts[f.value] as number)} of them` : ''}
            </button>
          ))}
        </div>

        <p className="chart-note">
          The request was <code>{request}</code>. If the ceiling is genuinely wrong for this ledger,
          it is one line in <code>.env</code> — but the three places that quote the number are
          required to move together, and <code>server/src/db/row-budget.ts</code> lists them.
        </p>
      </div>
    </div>
  );
}
