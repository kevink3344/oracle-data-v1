import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../state/store';
import PinButton from './PinButton';
import { Chip, PurposeChip, StatusChip, type ChipVariant } from './Chip';
import { UsageBar } from './Bars';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from './ResizeGrip';
import BucketBlock from './BucketBlock';
import AttentionList from './AttentionList';
import { CostCentreRelease, CostCentreUnheld } from './CostCentreEditor';
import { printElement } from '../lib/printPanel';
import { loadPositions, type PositionRow } from '../data/budgets';
import { money0, num, pctSlim, pluralise, share } from '../data/format';
import { SEGMENT_ORDER } from '../data/taxonomy';
import type { Project } from '../data/types';

const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the user's chosen panel width is remembered, alongside the theme. */
const WIDTH_KEY = 'projects-drawer-w';

const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const slug = (p: Project): string =>
  `${p.code}-${p.name}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function exportCsv(project: Project) {
  const header = [
    'level',
    'project',
    'combination',
    'purpose',
    'purpose_label',
    'object',
    'object_label',
    'cost_code',
    'lines',
    'orders',
    'vendors',
    'amount',
    'top_vendor',
    'top_vendor_amount',
  ];

  const body = project.buckets.flatMap((b) =>
    b.costCodes.map((c) => [
      project.level,
      project.name,
      c.combination,
      b.purpose,
      b.meta.label,
      c.object,
      c.label ?? '',
      c.label ? `${c.object} · ${c.label}` : c.object,
      String(c.lines),
      String(c.orders),
      String(c.vendors),
      c.amount.toFixed(2),
      c.topVendor,
      c.topVendorAmount.toFixed(2),
    ]),
  );

  const csv = [header, ...body].map((row) => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));

  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(project)}-cost-codes.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Spine({ project }: { project: Project }) {
  /**
   * ★ `constants` IS MEASURED, NOT STATED. It used to be `CONSTANT_SEGMENTS`, a literal map in
   *   `taxonomy.ts` naming fund, program, cost centre and future-use — a description of the one
   *   extract in the served file. The account scope is now a control, so a description can go stale
   *   between two clicks, and this spine would have gone on asserting "four of the seven never
   *   change" while the reader was looking at data where six of them did. The store measures the
   *   segments against the lines actually being shown; this reads the result.
   */
  const { constants, scopeStats } = useStore();
  const objects = [...new Set(project.buckets.flatMap((b) => b.costCodes.map((c) => c.object)))];
  const fixedSegments = SEGMENT_ORDER.filter((s) => constants[s]);
  const movingSegments = SEGMENT_ORDER.filter((s) => !constants[s]);
  const fixedCount = fixedSegments.length;
  const rows = scopeStats.excluded === 0
    ? `every one of the ${num(scopeStats.shown)} rows of the extract`
    : `every one of the ${num(scopeStats.shown)} rows inside the current scope`;

  const valueOf = (segment: string): string => {
    if (constants[segment]) return constants[segment];
    if (segment === 'LEVEL_') return project.level;
    if (segment === 'PURPOSE') return project.buckets.map((b) => b.purpose).join(', ');
    if (segment === 'OBJECT_') return objects.join(', ');
    return '';
  };

  return (
    <>
      <div className="spine">
        {SEGMENT_ORDER.map((segment) => {
          const fixed = Boolean(constants[segment]);
          return (
            <div
              key={segment}
              className={`spine__row${fixed ? ' spine__row--fixed' : ''}`}
              title={fixed ? `Identical on ${rows}` : undefined}
            >
              <span className="spine__k">{segment}</span>
              <span className="spine__v">{valueOf(segment)}</span>
            </div>
          );
        })}
      </div>
      <p className="spine__note">
        {fixedCount === 0 ? (
          <>Every one of the seven segments varies within the current scope, so the whole key moves.</>
        ) : (
          <>
            {fixedCount} of the seven segments hold one value across {rows}, so the whole key varies
            only in{' '}
            {movingSegments.map((s, i) => (
              <span key={s}>
                {i > 0 ? (i === movingSegments.length - 1 ? ' and ' : ', ') : ''}
                <code>{s}</code>
              </span>
            ))}
            .
          </>
        )}{' '}
        A project key is the whole combination, never a single segment.
      </p>
    </>
  );
}

export default function DetailDrawer() {
  const { selected, selectLevel, registry, constants, scopeStats } = useStore();
  const [shown, setShown] = useState<Project | null>(null);
  /**
   * What the release wrote, said in place after it succeeded.
   *
   * ★ THE SECTION HAS TO KEEP TALKING AFTER THE WRITE. Releasing removes the
   *   level from the project, so the registry row that carried the release button
   *   stops matching and the control disappears. Without a sentence left behind,
   *   the button would vanish and the panel would just look different — the one
   *   outcome a reader cannot distinguish from a failed click.
   */
  const [released, setReleased] = useState<string | null>(null);
  // null means "the stylesheet owns the width", which keeps the responsive
  // defaults (440 / 470 / 520 px by breakpoint) working until the user takes
  // over. It is only ever set by an explicit resize, so the stored value is
  // always the user's own choice.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const open = selected !== null;
  // Keep the last project on screen while the panel slides out, so the exit
  // transition has something to animate and the content does not blink away.
  useEffect(() => {
    if (selected) setShown(selected);
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus has to wait for the content to exist. On the very first open `shown`
  // is still null in this commit — the component is rendering the empty
  // placeholder, `closeRef` is unset — so focusing here would silently do
  // nothing and leave focus behind the modal. It must also stay a separate
  // effect from the one above, or the re-run would record the close button as
  // the opener and restore focus to an element inside the closed panel.
  const hasContent = shown !== null;
  useEffect(() => {
    if (!open || !hasContent) return;
    closeRef.current?.focus();
  }, [open, hasContent]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        selectLevel(null);
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el.tagName === 'SUMMARY',
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, selectLevel]);

  // The stylesheet owns the width until the user resizes, and that width is
  // responsive, so the grip reports and nudges from what is actually on screen
  // rather than a hard-coded default. Re-measuring on content change also
  // covers the first open, where `open` flips true one commit before `shown`
  // arrives and the panel is still the empty placeholder.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = panelRef.current;
      if (el) setRendered(Math.round(el.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, shown]);

  // The pointer leaves the 10px grip constantly while dragging, so the cursor
  // and the no-select rule have to live on the body for the duration.
  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  const close = useCallback(() => selectLevel(null), [selectLevel]);

  const setUserWidth = useCallback((w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    storeWidth(WIDTH_KEY, next);
  }, []);

  // Reset clears the override rather than pinning today's breakpoint default,
  // so the panel goes back to following the viewport.
  const resetWidth = useCallback(() => {
    setWidth(null);
    storeWidth(WIDTH_KEY, null);
  }, []);

  const panelStyle =
    width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);

  /**
   * Oracle's budget per account, fetched by the panel that shows it.
   *
   * ★ LOCAL TO THE PANEL ON PURPOSE. `loadBudgets` reads five endpoints because the
   *   Budgets page shows five things; this is one endpoint for one column in one
   *   panel. Putting it in the store would make every screen pay for a panel most of
   *   them never open. It keeps the store's rule for a read that is not the extract,
   *   though: a failure is a sentence beside the figure, never a page error.
   *
   * ★ PER LEVEL, NOT ONCE. It used to run on mount and ask for the first 200 rows of
   *   the whole population, on the reasoning that "the answer is the same whichever
   *   project is open". It is not: the answer is one level's rows, the population is
   *   1,262 rows, and the level is the fifth segment of the sort key — so the rows this
   *   panel needs are scattered through the set and were usually outside the window.
   *   The request is now scoped to the level being shown, which is both exact and where
   *   the cost is small (**142 ms** for one level against **3,815 ms** for the lot).
   *
   *   Filtering by level makes a stale response self-correcting as well: a reply from
   *   the previously selected level carries a different `LEVEL_CODE`, so the `find`
   *   below cannot match it against the new project even if it arrives late.
   */
  const [positions, setPositions] = useState<PositionRow[] | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  const positionLevel = shown?.level ?? null;

  useEffect(() => {
    if (positionLevel === null || positionLevel === '') {
      setPositions([]);
      setPositionsError(null);
      return;
    }

    const controller = new AbortController();
    let alive = true;

    // Cleared before the fetch so a moment of the previous level's money can never be
    // read against the newly selected project.
    setPositions(null);

    loadPositions(positionLevel, controller.signal)
      .then((rows) => {
        if (!alive) return;
        setPositions(rows);
        setPositionsError(null);
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setPositions([]);
        setPositionsError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [positionLevel]);

  /**
   * Oracle's budget rows for one of a level's accounts.
   *
   * ★ `(LEVEL_CODE, OBJECT_CODE)` IS NOT A KEY, AND `.find()` HERE WAS A SILENT UNDERCOUNT.
   *
   * The join used to be `find(...)` — one row per level+object — on the premise, written
   * down in `ProjectAccount`'s own comment, that `V_ACCOUNT_POSITION` "holds one row per
   * level+object". Measured against the live ledger that premise is **false**: the view is
   * one row per `CODE_COMBINATION_ID`, and level `0450` object `529` is booked in two
   * purposes (`6570` and `6560`), so it has **two** rows — $12,931 and $877,819.93. `.find()`
   * returned whichever came first and dropped the other, so the panel read **$18,710,282**
   * where the ledger holds **$19,588,101.84**, out by $877,819.93, with nothing on screen
   * to suggest a figure was missing.
   *
   * ★ THE FIX IS `filter`, NOT A BETTER KEY, because summing is already this panel's
   *   convention for a multi-combination account: `ProjectAccount.lines`, `.orders` and
   *   `.vendors` are all documented as "summed over this account's combinations", and
   *   `combinations` is carried precisely so the reader knows the account rolls up more
   *   than one seven-segment row. Budget has the same grain and must be read the same way;
   *   anything else makes one column of the panel count rows and another count accounts.
   */
  const positionFor = (level: string, object: string): PositionRow[] =>
    (positions ?? []).filter((r) => r.LEVEL_CODE === level && r.OBJECT_CODE === object);

  if (!shown) {
    return <aside ref={panelRef} className="drawer" style={panelStyle} aria-hidden="true" />;
  }

  const p = shown;
  const top = [...p.buckets].sort((a, b) => b.committed - a.committed)[0];
  const concentration = top ? share(top.committed, p.committed) : 0;
  const composition = top
    ? concentration >= 0.995
      ? `All ${top.meta.short.toLowerCase()}`
      : `Mostly ${top.meta.short.toLowerCase()}`
    : 'No committed value';

  /**
   * The registry row that holds this project's level, if any.
   *
   * ★ `null` IS THE ORDINARY CASE, NOT A FAILURE. Most levels in the extract
   *   belong to no project in this app — 129 of 139 in the sample — and the panel
   *   still has to open on them, because every other section of it is about the
   *   extract rather than the registry. So an absent row means "no cost centre is
   *   bound here", which the section states.
   */
  const held = registry.find((r) => (r.levelCode ?? '').trim() === p.level) ?? null;

  /**
   * Oracle's budget, totalled over this level's accounts.
   *
   * ★ THE MISSING HALF IS THE POINT. An account with no position row is not an error and
   *   is not a zero: it is an account with commitments and no budget row, which is what
   *   nearly every account in this sample is. The count of accounts that WERE found is
   *   carried alongside the total, so the figure below can say how many it covers rather
   *   than implying it covers all of them.
   *
   * ★ AND EVERY MATCHING ROW IS SUMMED, not the first one. See `positionFor`: an account
   *   spanning two purposes has two Oracle rows, and taking one of them understated this
   *   level's WCPSS budget by $877,819.93 on the live ledger. `budgetRows` is therefore a
   *   list of **accounts**, which is the unit the "n of m" hint counts, so the count and
   *   the money now refer to the same thing.
   *
   * ★ THE PER-ACCOUNT LIST THAT USED TO RENDER THIS WAS REMOVED AT THE USER'S REQUEST
   *   (2026) — the same money is on the Budgets screen, per account, in a table built
   *   for it. What did NOT change is the measurement: these rows are still read here,
   *   because they are the denominator of "Budget usage" and the source of the budget
   *   and remaining tiles. Only the second rendering of them went.
   */
  const budgetRows = p.accounts.filter((account) => positionFor(p.level, account.object).length > 0);
  const budgetTotal = budgetRows.reduce(
    (total, account) =>
      total + positionFor(p.level, account.object).reduce((n, r) => n + (r.WCPSS_BUDGET ?? 0), 0),
    0,
  );

  /**
   * ★★ THE USAGE FIGURE MEASURES AGAINST ORACLE'S TOTAL, NOT AGAINST THE MODELLED ONE.
   *
   * It used to measure against `p.approved`, which `derive.ts` invents as committed × 1.10 rounded
   * up to the next $10,000 — a placeholder standing in for a budget the *extract* does not carry.
   * The extract does not carry one, but Oracle does: `V_ACCOUNT_POSITION.WCPSS_BUDGET` is a real
   * budget held against a real account, and level 0450's four accounts hold $97.79M against the
   * $4.8M the placeholder guessed. The headline therefore read “90.8% used” — a percentage of a
   * number nobody had — while the panel's own account list, which has since been removed, was
   * adding the same accounts up to $89.8M for object 527 alone.
   *
   * `budgetTotal` is the denominator wherever there is one, and `null` where there is not — and
   * null is the ordinary case, because four accounts in the whole sample carry a budget row. A
   * level with no budget row gets the committed figure and a sentence, never a modelled
   * denominator and never a `$0` one: `$0` would claim Oracle budgeted nothing, and the
   * placeholder would claim Oracle budgeted something it did not.
   *
   * ★ The path not taken: `p.approved` is left alone in `derive.ts`, because the Projects table,
   *   the Dashboard KPI, the bucket blocks and the CSV all still mean the modelled figure by it,
   *   and each of those says so in as many words. Re-pointing `derive.ts` at Oracle's budget would
   *   have made a pure function of the extract depend on a fetch, and silently changed five other
   *   surfaces to boot.
   */
  const oracleBudget = budgetRows.length > 0 ? budgetTotal : null;
  const oracleRemaining = oracleBudget === null ? null : oracleBudget - p.committed;
  const oracleUsed = oracleBudget === null ? null : share(p.committed, oracleBudget);

  /**
   * The panel as it looks rather than as it is stored. The usage bar, the
   * cost-code spine and the derived findings are the whole point of this panel
   * and every one of them is flattened away by the CSV beside this button.
   *
   * The scope line names the level because a printed page has no URL to say
   * which project it is about, and this panel is one level of many.
   */
  const exportPdf = () => {
    const panel = panelRef.current;
    if (!panel) return;
    printElement(panel, {
      title: `${p.name} — project ${p.code}`,
      scope: `Project ${p.code} · level ${p.level} · ${p.site}`,
      orientation: 'portrait',
    });
  };

  return (
    <aside
      ref={panelRef}
      id="project-detail"
      className={`drawer${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={panelStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`${p.name} — project details`}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          {p.code} · {pluralise(p.accounts.length, 'account')}
        </div>
        <h2 className="drawer__name">{p.name}</h2>
        <div className="drawer__meta">
          {p.site}
          <br />
          <b>{num(p.lines)}</b> lines · <b>{num(p.orders)}</b> orders · <b>{num(p.vendors)}</b>{' '}
          vendors ·{' '}
          <b>{num(p.buckets.reduce((s, b) => s + b.costCodes.length, 0))}</b> cost codes
          <br />
          {p.first && p.last ? (
            <>
              Orders <b>{p.first}</b> to <b>{p.last}</b> ·{' '}
            </>
          ) : null}
          {p.owner ? <>owner {p.owner}</> : <em>unassigned</em>}
        </div>
        <div className="drawer__chips">
          <StatusChip status={p.status} quietDays={p.quietDays} />
          <Chip variant={(top?.meta.chip ?? 'neu') as ChipVariant} dot>
            {composition}
          </Chip>
          {p.buckets.map((b) => (
            <PurposeChip
              key={b.purpose}
              purpose={b.purpose}
              title={`${b.meta.label} — ${money0(b.committed)} committed`}
            />
          ))}
          {/*
            ★ WAS A LITERAL: `Fund 04 · 0840`, titled "FUND and COST_CENTER are single-valued across
              the extract". Both halves of that were statements about one dataset, in a component
              that had no way to check either — so under a scope that admitted another fund, the chip
              would still have read `04` and still have claimed it was single-valued. It now reads
              whatever the store measured, and disappears rather than guessing if the segments are
              not fixed.
          */}
          {constants.FUND || constants.COST_CENTER ? (
            <Chip
              variant="neu"
              title={
                `FUND and COST_CENTER hold one value across all ${num(scopeStats.shown)} PO lines ` +
                `in the current scope${scopeStats.excluded === 0 ? ', which is the whole extract' : ''}.`
              }
            >
              Fund {constants.FUND ?? '—'} · {constants.COST_CENTER ?? '—'}
            </Chip>
          ) : null}
        </div>
        <PinButton
          category="project"
          entityKey={p.level}
          title={p.name}
          subtitle={`${p.code} · ${p.site}`}
          href={`/projects?project=${encodeURIComponent(p.level)}`}
        />
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={close}
          aria-label="Close the project details panel"
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
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Budget usage</h3>
            <span className="dsec__hint">
              {oracleBudget === null
                ? pluralise(p.buckets.length, 'purpose group')
                : `Oracle WCPSS budget · ${pluralise(budgetRows.length, 'account')} of ${num(
                    p.accounts.length,
                  )}`}
            </span>
          </div>

          <div className="usage-head">
            <span className="usage-fig">{money0(p.committed)}</span>
            <span className="usage-of">
              {oracleBudget === null ? (
                <>committed on this level&rsquo;s PO lines</>
              ) : (
                <>
                  committed against <b>{money0(oracleBudget)}</b> WCPSS budget ·{' '}
                  {pctSlim(oracleUsed ?? 0)} used
                </>
              )}
            </span>
          </div>

          <div className="usage-bar">
            <UsageBar buckets={p.buckets} remaining={oracleRemaining} />
          </div>

          <div className="legend">
            {p.buckets.map((b) => (
              <span key={b.purpose}>
                <i className={`lg-${b.meta.series}`} />
                {b.meta.short} <b>{money0(b.committed)}</b>
              </span>
            ))}
            {oracleRemaining === null ? null : (
              <span>
                <i className="lg-rest" />
                Unallocated <b>{money0(Math.max(oracleRemaining, 0))}</b>
              </span>
            )}
          </div>

          {/*
            ★ THE FAILURE BRANCH COMES FIRST, because the sentence below it is a claim and a
              failed read makes that claim false. With no rows the headline already reads
              "committed on this level's PO lines", which is true either way — but the notice
              underneath says Oracle "holds no WCPSS_BUDGET row", and that is not something a
              failed fetch can tell you. The `catch` in the positions effect empties the rows,
              so a failure is otherwise indistinguishable from a level that genuinely has none.
          */}
          {positionsError ? (
            <div className="notice notice--warn" style={{ marginTop: 14 }}>
              <p>
                <strong>The budget could not be read from Oracle.</strong> {positionsError} The
                committed figures here come from the extract and are unaffected. Whether this
                level has a WCPSS budget is unknown rather than absent — a total on Oracle's side
                does not mean this level has one, and a missing figure on this screen does not
                mean it has none.
              </p>
            </div>
          ) : oracleBudget === null ? (
            <div className="notice notice--info" style={{ marginTop: 14 }}>
              <p>
                <strong>There is no budget to measure against, so there is no usage figure.</strong>{' '}
                Oracle holds no <code>WCPSS_BUDGET</code> row against{' '}
                {p.accounts.length === 1 ? 'this level’s account' : 'this level’s accounts'} in the
                loaded set — the ordinary answer, since four accounts in the whole sample carry one.
                The committed figure is shown on its own rather than as 0% of nothing.
              </p>
            </div>
          ) : (
            <div className="notice notice--info" style={{ marginTop: 14 }}>
              <p>
                <strong>WCPSS budget is Oracle&rsquo;s own, and it is held per account.</strong> The
                figure above is{' '}
                {budgetRows.length === p.accounts.length
                  ? `all ${num(p.accounts.length)} of this level’s accounts added together`
                  : `${num(budgetRows.length)} of this level’s ${num(
                      p.accounts.length,
                    )} accounts added together`}
                , one Oracle budget row per account <em>combination</em> — where an account spans
                two purposes it has two rows, and both are counted. Commitments have the finer
                grain — a budget is held per account, a commitment per purchase-order line — so
                the two are read side by side and never subtracted.
              </p>
            </div>
          )}

          <div className="stats">
            <div className="stat">
              <div className="stat__k">Committed</div>
              <div className="stat__v">{money0(p.committed)}</div>
            </div>
            {oracleBudget === null ? null : (
              <>
                <div className="stat">
                  <div className="stat__k">WCPSS budget</div>
                  <div className="stat__v">{money0(oracleBudget)}</div>
                </div>
                <div className="stat">
                  <div className="stat__k">Remaining</div>
                  <div className="stat__v">{money0(Math.max(oracleRemaining ?? 0, 0))}</div>
                </div>
              </>
            )}
            <div className="stat">
              <div className="stat__k">Orders</div>
              <div className="stat__v">{num(p.orders)}</div>
            </div>
            <div className="stat">
              <div className="stat__k">Vendors</div>
              <div className="stat__v">{num(p.vendors)}</div>
            </div>
            <div className="stat">
              <div className="stat__k">Quiet for</div>
              <div className="stat__v">
                {p.quietDays} {p.quietDays === 1 ? 'day' : 'days'}
              </div>
            </div>
          </div>
        </section>

        {/*
          ★★ THE PER-ACCOUNT LIST THAT STOOD HERE WAS REMOVED AT THE USER'S REQUEST (2026).

             It rendered every account the level owns with its WCPSS budget and its committed
             money, and the user's call was that "Related budgets" already shows them what they
             want and the drawer was longer for it. The money it carried is not lost: the
             per-account WCPSS budget is a column of the accounts table on /budgets, and this
             panel still reads the same Oracle rows to total them for "Budget usage" above.
        */}
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Related budgets</h3>
            <span className="dsec__hint">one group per PURPOSE_ segment</span>
          </div>
          {p.buckets.map((b) => (
            <BucketBlock key={b.purpose} bucket={b} />
          ))}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Cost-code spine</h3>
            <span className="dsec__hint">the whole account combination</span>
          </div>
          <Spine project={p} />
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Cost centre</h3>
            <span className="dsec__hint">the app’s record, not Oracle’s</span>
          </div>
          {/* ★ THE MATCH IS BY LEVEL, AND THAT IS THE ONLY KEY THAT WORKS. The
              panel is opened from a row of the level table, so what it knows is
              the level; the registry row that holds it is what carries the slug
              the release is written against. A project can hold at most one level
              and a level at most one project — the API enforces both — so there is
              exactly one row to find, or none. */}
          {held ? (
            <CostCentreRelease row={held} onDone={setReleased} />
          ) : (
            <CostCentreUnheld level={p.level} />
          )}
          {/* ★ THE SECOND OF THE TWO PLACES EDIT LIVES, AND NOT A DUPLICATE OF THE
              FIRST. The projects list can only offer Edit for a project that has no
              level, because a coded project is not a row in the recorded queue. A
              reader looking at a project's own detail — which is the only screen
              that shows what the level gathers — had no way to change its name or
              move it. This is that way, and it is one link because the write is one
              `PATCH`: the same page the recorded rows open. */}
          {held ? (
            <div className="bind__actions">
              <Link className="btn btn--ghost btn--sm" to={`/projects/${held.slug}/edit`}>
                Edit project
              </Link>
            </div>
          ) : null}
          {released ? (
            <div className="notice notice--info" role="status">
              <p>{released}</p>
            </div>
          ) : null}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">What to watch</h3>
            <span className="dsec__hint">derived, not stored</span>
          </div>
          <AttentionList project={p} />
        </section>

        {p.note ? (
          <section className="dsec">
            <div className="dsec__head">
              <h3 className="dsec__title">Note on this project</h3>
            </div>
            <p className="watch__d">{p.note}</p>
          </section>
        ) : null}
      </div>

      <div className="drawer__foot">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled
          title="The full project view is §9.3 of the plan — not built in this slice"
        >
          Open full project
        </button>
        <button
          type="button"
          className="btn btn--system btn--sm"
          disabled
          title="Needs the write API — not built in this slice"
        >
          Add budget
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportCsv(p)}>
          Export CSV
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={exportPdf}
          title="Prints this panel as it looks — the usage bar, the cost-code spine and the derived findings, none of which the CSV carries"
        >
          Export to PDF
        </button>
      </div>
    </aside>
  );
}
