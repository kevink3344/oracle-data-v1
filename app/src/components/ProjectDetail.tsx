import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../state/store';
import { UsageBar } from './Bars';
import BucketBlock from './BucketBlock';
import AttentionList from './AttentionList';
import { CostCentreRelease, CostCentreUnheld } from './CostCentreEditor';
import { loadPositions, type PositionRow } from '../data/budgets';
import { money0, num, pctSlim, pluralise, share } from '../data/format';
import { SEGMENT_ORDER } from '../data/taxonomy';
import type { Project } from '../data/types';

const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const slug = (p: Project): string =>
  `${p.code}-${p.name}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export function exportProjectCsv(project: Project) {
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

/**
 * The seven-segment spine, with the fixed segments MEASURED rather than asserted.
 *
 * ★ `constants` IS MEASURED, NOT STATED. It used to be `CONSTANT_SEGMENTS`, a literal map in
 *   `taxonomy.ts` naming fund, program, cost centre and future-use — a description of the one
 *   extract in the served file. The account scope is now a control, so a description can go stale
 *   between two clicks, and this spine would have gone on asserting "four of the seven never
 *   change" while the reader was looking at data where six of them did. The store measures the
 *   segments against the lines actually being shown; this reads the result.
 */
export function Spine({ project }: { project: Project }) {
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

/**
 * Everything the project detail shows, with no chrome of its own.
 *
 * ★★ THIS WAS THE DRAWER'S BODY, AND IT IS A COMPONENT NOW BECAUSE THE DRAWER IS GONE.
 *   The project detail used to be a sliding panel rendered by `DetailDrawer` from the store's
 *   `selected`. The user's instruction was that clicking a project should open a PAGE rather than
 *   a panel, so the content moved here and the page renders it. Nothing about the content changed:
 *   the same sections, the same measurements, the same notes — and the notes are the reason this is
 *   an extraction rather than a rewrite. Every ★ block below records a defect that was measured and
 *   fixed, and re-typing them into a new file is how those records get lost.
 *
 * ★ NO `role="dialog"`, NO FOCUS TRAP, NO ESCAPE HANDLER. Those belonged to the drawer because it
 *   was modal. A page is not: the rail and the topbar stay usable, the URL is shareable, and Back
 *   works. Carrying the trap over would have made a page that behaves like a modal — the worst of
 *   both, because a reader can see the navigation and cannot reach it.
 */
export default function ProjectDetail({ project }: { project: Project }) {
  const { registry } = useStore();
  const p = project;

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

  /**
   * Oracle's budget per account, fetched by the section that shows it.
   *
   * ★ LOCAL TO THIS COMPONENT ON PURPOSE. `loadBudgets` reads five endpoints because the
   *   Budgets page shows five things; this is one endpoint for one column. Putting it in the store
   *   would make every screen pay for a page most of them never open. It keeps the store's rule for
   *   a read that is not the extract, though: a failure is a sentence beside the figure, never a
   *   page error.
   *
   * ★ PER LEVEL, NOT ONCE. It used to run on mount and ask for the first 200 rows of the whole
   *   population, on the reasoning that "the answer is the same whichever project is open". It is
   *   not: the answer is one level's rows, the population is 1,262 rows, and the level is the fifth
   *   segment of the sort key — so the rows this needs are scattered through the set and were
   *   usually outside the window. Scoped to the level it is both exact and cheap (**142 ms** for
   *   one level against **3,815 ms** for the lot).
   *
   *   Filtering by level makes a stale response self-correcting as well: a reply from a previously
   *   viewed level carries a different `LEVEL_CODE`, so the `find` below cannot match it.
   */
  const [positions, setPositions] = useState<PositionRow[] | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  const positionLevel = p.level;

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
   * ★ THE FIX IS `filter`, NOT A BETTER KEY, because summing is already this page's
   *   convention for a multi-combination account: `ProjectAccount.lines`, `.orders` and
   *   `.vendors` are all documented as "summed over this account's combinations", and
   *   `combinations` is carried precisely so the reader knows the account rolls up more
   *   than one seven-segment row. Budget has the same grain and must be read the same way;
   *   anything else makes one column count rows and another count accounts.
   */
  const positionFor = (level: string, object: string): PositionRow[] =>
    (positions ?? []).filter((r) => r.LEVEL_CODE === level && r.OBJECT_CODE === object);

  /**
   * The registry row that holds this project's level, if any.
   *
   * ★ `null` IS THE ORDINARY CASE, NOT A FAILURE. Most levels in the extract
   *   belong to no project in this app — 129 of 139 in the sample — and the page
   *   still has to render on them, because every other section of it is about the
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
   * number nobody had.
   *
   * `budgetTotal` is the denominator wherever there is one, and `null` where there is not — and
   * null is the ordinary case, because four accounts in the whole sample carry a budget row. A
   * level with no budget row gets the committed figure and a sentence, never a modelled
   * denominator and never a `$0` one: `$0` would claim Oracle budgeted nothing, and the
   * placeholder would claim Oracle budgeted something it did not.
   */
  const oracleBudget = budgetRows.length > 0 ? budgetTotal : null;
  const oracleRemaining = oracleBudget === null ? null : oracleBudget - p.committed;
  const oracleUsed = oracleBudget === null ? null : share(p.committed, oracleBudget);

  return (
    <>
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
            failed fetch can tell you. The `catch` above empties the rows, so a failure is
            otherwise indistinguishable from a level that genuinely has none.
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
        {/* ★ THE MATCH IS BY LEVEL, AND THAT IS THE ONLY KEY THAT WORKS. The page
            is opened from a row of the level table, so what it knows is the level;
            the registry row that holds it is what carries the slug the release is
            written against. A project can hold at most one level and a level at most
            one project — the API enforces both — so there is exactly one row to
            find, or none. */}
        {held ? <CostCentreRelease row={held} onDone={setReleased} /> : <CostCentreUnheld level={p.level} />}
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
    </>
  );
}
