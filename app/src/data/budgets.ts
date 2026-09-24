/**
 * The budget measure, read from the API rather than from an extract.
 *
 * ── WHY THIS MODULE EXISTS AND WHAT IT IS NOT ────────────────────────────────
 *
 * Every other data module in `app/src/data/` parses a file under
 * `app/public/oracle/`. This one cannot: `V_BUDGET_BY_ACCOUNT_PERIOD` and
 * `V_ACCOUNT_POSITION` are **not in the client extract at all**. That was
 * established by probe, not assumed — a first attempt to find the budget views in
 * `app/public/oracle/*.json` found no file carrying `NET_AMOUNT` beside
 * `BUDGET_VERSION_ID`. They are server-side views served at `/api/funding/*`, so
 * the Budgets screen is the first screen whose figures arrive over HTTP and whose
 * complete absence from the extract is a fact the screen has to live with.
 *
 * ── THE TWO VIEWS, AND WHY BOTH ARE READ ────────────────────────────────────
 *
 *   `V_BUDGET_BY_ACCOUNT_PERIOD` — one row per (account, version, period).
 *     This is the *evidence*: 13 rows, which is small enough to show in full. It
 *     is what makes a phased budget distinguishable from a lump sum.
 *
 *   `V_ACCOUNT_POSITION` — one row per account, four money columns.
 *     This is the *reading*: budget, allocations, encumbrances, expenditures,
 *     available funds. Its `BUDGET_ACCOUNT` is the dotted form of the same
 *     7-segment key, which is why `keyOf()` and `keyOfDotted()` both exist here.
 *
 * ★ THE TWO ARE NOT INDEPENDENT, AND THE SCREEN PROVES IT RATHER THAN ASSERTING
 *   IT. Measured on this sample: for all four accounts, `WCPSS_BUDGET` is exactly
 *   the sum of that account's rows under the `CAPITAL` budget type, and
 *   `ALLOCATIONS_REIMB` is exactly the sum under `APPROP`. The position view is
 *   therefore derivable from the 13 rows, and `describeDerivation()` checks that
 *   it is — a rule the screen states only where it holds.
 *
 * ── THE COVERAGE FACT THAT SHAPES THE SCREEN ────────────────────────────────
 *
 * The four versions are each assigned the range
 * `04.6570.862.000.0000.0000.000` – `04.6570.862.999.9999.9999.999`, so the
 * budgeted population is exactly the accounts inside that one fund / purpose /
 * program. Measured:
 *
 *     accounts in the extract / chart-of-accounts page   328
 *     accounts with a budget row                           4
 *     accounts on the invoice register                    71
 *     invoice accounts that have a budget row              1
 *
 * So a deep link from an invoice account to a budget lands on a populated screen
 * **once in seventy-one**. That is not a defect in the link; it is the size of the
 * budgeted population, and the screen says so instead of rendering four rows and
 * letting a reader conclude the rest is missing.
 */

import { readTrace, sqlUrl } from './sqlTrace';
import type { SqlTrace } from '../components/SqlNote';

/** The page envelope the API wraps every list in. */
interface Envelope<T> {
  data: T[];
  page: { limit: number; offset: number; total: number; returned: number };
  /**
   * The statements this request ran — present only while the reader has the SQL trace switched on.
   *
   * ★ OPTIONAL, AND THAT IS THE CONTRACT. With the toggle off the server never sends it, so every
   *   reader of this envelope has to tolerate its absence; making it required would be a lie the
   *   compiler would then force a placeholder into.
   */
  sql?: SqlTrace | null;
}

/** One budgeted account, for one version, for one posting period. */
export interface BudgetRow {
  LEDGER_ID: number;
  CODE_COMBINATION_ID: number;
  SEGMENT1: string;
  SEGMENT2: string;
  SEGMENT3: string;
  SEGMENT4: string;
  SEGMENT5: string;
  SEGMENT6: string;
  SEGMENT7: string;
  BUDGET_VERSION_ID: number;
  PERIOD_YEAR: number;
  PERIOD_NUM: number;
  PERIOD_NAME: string;
  /** Debits less credits for that period. The measure `01-budgets.sql` defines. */
  NET_AMOUNT: number;
  /** How many `GL_BALANCES` rows the sum was taken over. */
  BALANCE_ROWS: number;
}

/**
 * One account's position: four money columns, two of them derived.
 *
 * `WCPSS_BUDGET` and `ALLOCATIONS_REIMB` are budget; `ENCUMBRANCES` and
 * `EXPENDITURES` are read from the same `GL_BALANCES` table under the `E` and `A`
 * actual flags. `AVAILABLE_FUNDS` is arithmetic — see `describeDerivation()`.
 */
export interface PositionRow {
  CODE_COMBINATION_ID: number;
  OBJECT_CODE: string;
  LEVEL_CODE: string;
  /** The same key as `keyOf(BudgetRow)`, dot-separated instead of dash-separated. */
  BUDGET_ACCOUNT: string;
  WCPSS_BUDGET: number;
  ALLOCATIONS_REIMB: number;
  ENCUMBRANCES: number;
  EXPENDITURES: number;
  AVAILABLE_FUNDS: number;
}

/**
 * A version of the budget. In the sample four exist and two carry `LATEST_FLAG = 'Y'`.
 *
 * ★ EIGHT OF THESE ELEVEN COLUMNS ARE NULL ON THE LIVE LEDGER, AND THE TYPE NOW SAYS SO.
 *
 *   Measured against the instance under `DB_MODE=oracle`: `/api/funding/budget-versions`
 *   fills `BUDGET_VERSION_ID`, `BUDGET_NAME` and `CREATION_DATE` and serves the other
 *   eight as `null`. There is no `BUDGET_TYPE_ID` on the instance at all — its join key
 *   is the *name* `BUDGET_TYPE` — and no period span, no `STATUS_CODE` and no
 *   `LATEST_FLAG`. `server/src/db/ledger-shape.ts` projects each absent column as `NULL`
 *   **under its own name** rather than dropping it, deliberately, so a client needs one
 *   decoder for both stores.
 *
 *   These declarations used to say `string` and `number`, which was a lie the compiler
 *   could not see through and the renderer therefore trusted: `t.BUDGET_TYPE_CODE
 *   .toLowerCase()` on the null type code took the whole page down in a nested `map`,
 *   which is exactly the white screen this page was reported as. Declaring the absence
 *   is what turns "the ledger does not answer this column" from a crash into a dash.
 */
export interface BudgetVersion {
  BUDGET_VERSION_ID: number;
  LEDGER_ID: number | null;
  BUDGET_TYPE_ID: number | null;
  BUDGET_NAME: string;
  FIRST_PERIOD_NAME: string | null;
  LAST_PERIOD_NAME: string | null;
  DEFAULT_PERIOD_NAME: string | null;
  STATUS_CODE: string | null;
  LATEST_FLAG: string | null;
  BUDGET_ENTRY_STATUS: string | null;
  CREATION_DATE: string;
}

/**
 * A budget type — and the mapping that makes the position columns readable.
 *
 * `CAPITAL` is the column the report calls *WCPSS Budget*; `APPROP` is the column
 * it calls *Allocations/Reimb.*. `GRANT` exists in the sample with no rows against
 * it, which is why the screen reads the type of a row rather than assuming the
 * two that happen to be present.
 */
/**
 * ★ ON THE LIVE LEDGER THIS RESOURCE ANSWERS ONE ROW OF PURE NULLS.
 *
 *   The descriptor names the sample's five columns; the instance's `GL_BUDGET_TYPES`
 *   holds `BUDGET_TYPE` / `DESCRIPTION` / five `ATTRIBUTE`s / audit / `CONTEXT` instead,
 *   so none of the five exist — except `DESCRIPTION`, which the two shapes happen to
 *   share and which is null on the only row. Because *one* declared column is present,
 *   the resolver's "an object with no overlap at all gets the 503" guard never fires and
 *   the response is a single row that identifies nothing.
 *
 *   That row is dropped in `loadBudgets` — see the note there, which is where the crash
 *   actually came from. Every field stays nullable because the declaration describes what
 *   the contract can carry, not what one store happens to fill.
 */
export interface BudgetType {
  BUDGET_TYPE_ID: number | null;
  BUDGET_TYPE_CODE: string | null;
  BUDGET_NAME: string | null;
  DESCRIPTION: string | null;
  ENABLED_FLAG: string | null;
}

/** An account range assigned to a version. All four are the same range. */
export interface BudgetAssignment {
  BUDGET_VERSION_ID: number;
  RANGE_FROM: string;
  RANGE_TO: string;
  BUDGET_ENTITY_ID: number;
}

export interface BudgetsData {
  budgets: BudgetRow[];
  positions: PositionRow[];
  versions: BudgetVersion[];
  types: BudgetType[];
  assignments: BudgetAssignment[];
  /**
   * Names of any list the API held back more of than it returned.
   *
   * ★ THIS IS NOT DEFENSIVE PADDING. Read at `limit=200` every list here is
   *   complete, but the budget population is a property of the *sample*: a fuller
   *   ledger could exceed one page, and a screen that silently printed the first
   *   page as the whole population would understate the budget with no sign that
   *   it had. Naming the truncation is the only way the total above the table can
   *   be trusted.
   */
  truncated: string[];
  /**
   * The statements behind each list, when the reader has the SQL trace switched on.
   *
   * ★ ONE ENTRY PER LIST SO THE PAGE CAN PUT THE RIGHT STATEMENT BESIDE THE RIGHT PANEL. The five
   *   requests run concurrently and each runs its own count-then-page pair, so a flat list would
   *   interleave ten statements with no way to say which panel they explain. Every value is `null`
   *   with the toggle off, which is the ordinary case.
   */
  traces: {
    budgets: SqlTrace | null;
    positions: SqlTrace | null;
    versions: SqlTrace | null;
    types: SqlTrace | null;
    assignments: SqlTrace | null;
  };
}

/**
 * The type chip for one budget type: what to write, and which modifier class.
 *
 * ★ ONE HELPER FOR THREE CALL SITES, AND THAT IS THE POINT. The chip is drawn in the
 *   account panel, in the overview table and in the versions table, and each site used
 *   to spell `t.BUDGET_TYPE_CODE.toLowerCase()` for itself. So the null code threw from
 *   whichever site rendered first — the page died rather than the cell — and repairing
 *   one site would have left two live. The same argument already governs `keyOf`.
 *
 * `modifier` is `null` rather than `''` when there is no code, so the caller emits a bare
 * `.budtype` instead of the meaningless `budtype--`. The code is slugged rather than
 * lowercased so a code containing a space or a slash cannot produce a broken class name.
 */
export function budTypeBadge(t: BudgetType | null | undefined): {
  label: string | null;
  modifier: string | null;
} {
  const code = t?.BUDGET_TYPE_CODE;
  if (typeof code !== 'string' || code.trim() === '') return { label: null, modifier: null };
  return { label: code, modifier: code.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
}

/**
 * `LATEST_FLAG` as three states rather than two.
 *
 * ★ A NULL FLAG IS NOT `N`, AND THE CELL USED TO ASSUME IT WAS. It rendered
 *   "superseded" for anything that was not `'Y'` — which is a claim, not a default. On
 *   the live ledger `LATEST_FLAG` is not served at all, so every version including the
 *   current one would have been labelled superseded, under a panel whose whole purpose
 *   is to make a current budget distinguishable from a replaced one. `unknown` is the
 *   honest third answer and it is the reason the panel can say what is missing.
 */
export function latestState(v: BudgetVersion): 'yes' | 'no' | 'unknown' {
  if (v.LATEST_FLAG === 'Y') return 'yes';
  if (v.LATEST_FLAG === 'N') return 'no';
  return 'unknown';
}

/** `SEGMENT1-…-SEGMENT7`, the key every other screen in the app uses. */
export function keyOf(row: BudgetRow): string {
  return [
    row.SEGMENT1,
    row.SEGMENT2,
    row.SEGMENT3,
    row.SEGMENT4,
    row.SEGMENT5,
    row.SEGMENT6,
    row.SEGMENT7,
  ]
    .map((s) => String(s ?? '').trim())
    .join('-');
}

/**
 * `04.6570.862.527.0450.0840.000` → `04-6570-862-527-0450-0840-000`.
 *
 * The position view spells the key with dots and the budget view spells it with
 * dashes. They are the same key — verified: both forms appear for all four
 * accounts — so the screen normalises to the dashed form everywhere and treats a
 * dot-separated `?combo=` as the same request. Accepting only one spelling would
 * make a link work or not depending on which page built it.
 */
export function keyOfDotted(account: string): string {
  return String(account ?? '').trim().replace(/\./g, '-');
}

/** A row as `?combo=` carries it, so a dotted link and a dashed link agree. */
export function keyOfPosition(row: PositionRow): string {
  return keyOfDotted(row.BUDGET_ACCOUNT);
}

/** Newest period first is *not* the right order here — see `byPeriod`. */
export function periodKey(periodYear: number, periodNum: number): number {
  return periodYear * 100 + periodNum;
}

/**
 * Rows ordered oldest period first.
 *
 * ★ ASCENDING, DELIBERATELY. `V_BUDGET_BY_ACCOUNT_PERIOD`'s served default sort
 *   is year-descending, which is right for "what is the latest position" and
 *   wrong for the one thing this list is for: reading a budget as it accumulated.
 *   Descending prints the phasing backwards, so a lump entered in 2022 and
 *   re-appropriated three times reads as three small amounts followed by one
 *   enormous one.
 */
export function byPeriod(a: BudgetRow, b: BudgetRow): number {
  return (
    periodKey(a.PERIOD_YEAR, a.PERIOD_NUM) - periodKey(b.PERIOD_YEAR, b.PERIOD_NUM) ||
    a.BUDGET_VERSION_ID - b.BUDGET_VERSION_ID
  );
}

/** One request, unwrapped, with a refusal that names its own status. */
async function getList<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const res = await fetch(sqlUrl(path), { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* The status line stands. */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as Envelope<T>;
  if (!Array.isArray(body?.data) || !body.page) {
    throw new Error(`The response from ${path} did not contain a list.`);
  }
  /*
   * ★ THE TRACE RIDES ON THE ENVELOPE SO THE CALLER CAN SHOW IT. It is attached here rather than
   *   read by the page, because this function is the only place that holds the parsed body — and
   *   `readTrace` returns null when the toggle is off, so nothing downstream has to branch.
   */
  return { ...body, sql: readTrace(body) };
}

/**
 * Everything the Budgets screen reads, in one pass.
 *
 * Five lists rather than one because they answer five different questions and a
 * screen that showed only the money would have no way to say *which version* a
 * figure belongs to or *why* these four accounts. `Promise.all` because they are
 * independent and the screen has nothing to render until all of them land.
 *
 * The limit is well above every total in this sample on purpose; `truncated`
 * carries the names of any list that would have been cut, so the screen can say
 * so rather than quietly printing a page as a population.
 */
/**
 * Just the account positions for ONE level: Oracle's budget per object on that level.
 *
 * ★ ONE ENDPOINT, NOT FIVE. `loadBudgets` reads five because the Budgets page shows
 *   five things. The accounts panel under a project needs one of them — the budget
 *   on the accounts a level owns.
 *
 * ★ AND ONE LEVEL, NOT THE WHOLE POPULATION — because the cap was answering the wrong
 *   question. This used to ask for `?limit=200` and `find` the level in the result.
 *   But the position view holds **1,262 rows** and its sort key is
 *   `Fund.Purpose.Program.Object.Level.Special.Project`, so Level is the **fifth**
 *   segment: rows for one level are scattered throughout the set and are very unlikely
 *   to fall inside the first 200. A search of a capped list is not a smaller answer, it
 *   is the wrong one — it reports "this level has no budget" for levels that have one.
 *   The filter belongs in the SQL, where it also happens to be much faster.
 *
 * ★ MEASURED, which is what settles the shape: the same query costs **3,815 ms** for
 *   the whole scoped population and **142 ms** for one level. The cheaper request is
 *   also the correct one, so there is no trade to weigh.
 *
 * The caller only ever looks up the level it is showing (`DetailDrawer`'s
 * `positionFor(level, object)` is called with the shown project's own level), so this
 * cannot hide a row the panel needs.
 */
export async function loadPositions(level: string, signal?: AbortSignal): Promise<PositionRow[]> {
  const query = new URLSearchParams({ level, limit: '200' });
  const envelope = await getList<PositionRow>(`/api/funding/positions?${query}`, signal);
  return envelope.data;
}

export async function loadBudgets(signal?: AbortSignal): Promise<BudgetsData> {
  const LIMIT = 200;
  const [budgets, positions, versions, types, assignments] = await Promise.all([
    getList<BudgetRow>(`/api/funding/budgets?limit=${LIMIT}`, signal),
    getList<PositionRow>(`/api/funding/positions?limit=${LIMIT}`, signal),
    getList<BudgetVersion>(`/api/funding/budget-versions?limit=${LIMIT}`, signal),
    getList<BudgetType>(`/api/funding/budget-types?limit=${LIMIT}`, signal),
    getList<BudgetAssignment>(`/api/funding/budget-assignments?limit=${LIMIT}`, signal),
  ]);

  const truncated: string[] = [];
  const watch = (label: string, e: { page: { total: number; returned: number } }) => {
    if (e.page.total > e.page.returned) {
      truncated.push(`${label}: ${e.page.total} rows exist, the first ${e.page.returned} were read`);
    }
  };
  watch('budgeted accounts (by period)', budgets);
  watch('account positions', positions);
  watch('budget versions', versions);
  watch('budget types', types);
  watch('account ranges assigned to a version', assignments);

  /**
   * ★ A ROW THAT IDENTIFIES NO BUDGET TYPE IS NOT A BUDGET TYPE — AND KEEPING IT WAS
   *   WHAT ACTUALLY BROKE THE PAGE.
   *
   *   Under `DB_MODE=oracle` `/api/funding/budget-types` answers **one row of pure
   *   nulls** (see the note on `BudgetType`). Dropping it is not tidiness; the row's
   *   presence was load-bearing in the worst way. `typeById` is keyed
   *   `BUDGET_TYPE_ID`, the versions also carry `BUDGET_TYPE_ID = null`, so
   *   `typeById.get(null)` **matched** — the lookup succeeded where it should have found
   *   nothing, every `t ? … : '—'` guard on the page was satisfied, and the first render
   *   called `toLowerCase()` on a null code and unmounted the tree.
   *
   *   So this is the fix's load-bearing half: with the row gone the lookup misses, the
   *   existing guards do the job they already appear to be doing, and the type column
   *   reads "—" — which is the truth, because this ledger has no budget type this screen
   *   can name. A row is kept if it carries an id or a code, so a store that supplies
   *   only one of the two still gets its types.
   */
  const identifiableTypes = types.data.filter(
    (t) => t.BUDGET_TYPE_ID !== null || (t.BUDGET_TYPE_CODE ?? '').trim() !== '',
  );

  return {
    budgets: budgets.data,
    positions: positions.data,
    versions: versions.data,
    types: identifiableTypes,
    assignments: assignments.data,
    truncated,
    /**
     * ★ THE TRACES ARE KEPT PER LIST, NOT CONCATENATED, BECAUSE EACH ONE ANSWERS A DIFFERENT
     *   QUESTION ON THE PAGE. A reader checking the version count wants the two statements behind
     *   *that* list — the count and the page — not all ten the page ran, in an order that does not
     *   match the panels. The page renders the relevant one beside the panel it belongs to and the
     *   whole set once at the foot.
     */
    traces: {
      budgets: budgets.sql ?? null,
      positions: positions.sql ?? null,
      versions: versions.sql ?? null,
      types: types.sql ?? null,
      assignments: assignments.sql ?? null,
    },
  };
}

/**
 * What the position view's columns are made of, as a claim the caller can test.
 *
 * Returns one line per account saying whether the arithmetic actually holds. The
 * screen renders these rather than a sentence asserting the rule, because the rule
 * is a property of *this* data: `AVAILABLE_FUNDS = ALLOCATIONS_REIMB −
 * ENCUMBRANCES − EXPENDITURES` holds on all four accounts here and would stop
 * being true if the view were changed to net something else. An assertion that
 * cannot fail is not evidence.
 *
 * The `CAPITAL → WCPSS_BUDGET` / `APPROP → ALLOCATIONS_REIMB` split is the other
 * half: it is what makes the 13 rows and the 4 position rows the same fact stated
 * twice, and it is checked by summing the rows per type per account.
 */
export interface Derivation {
  key: string;
  /** `WCPSS_BUDGET` and the CAPITAL rows summed per account. */
  capitalFromRows: number;
  capitalFromView: number;
  /** `ALLOCATIONS_REIMB` and the APPROP rows summed per account. */
  appropFromRows: number;
  appropFromView: number;
  /** `AVAILABLE_FUNDS` and the view's own arithmetic. */
  availableFromColumns: number;
  availableFromView: number;
  /** `BUDGET_NAME` of any type carrying rows but no column — `GRANT` here. */
  uncolumned: string[];
}

const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

/**
 * Build the per-account derivation checks.
 *
 * `types` is passed in rather than assumed: the mapping from a type code to a
 * column is a fact about this view, and the sample carries a third type (`GRANT`)
 * with no column against it precisely so that a caller which hard-codes the two
 * it has seen is wrong out loud. Anything in `uncolumned` is surfaced instead of
 * being dropped into one of the other two totals.
 */
export function describeDerivation(data: BudgetsData): Derivation[] {
  const codeById = new Map(data.types.map((t) => [t.BUDGET_TYPE_ID, t.BUDGET_TYPE_CODE]));
  const nameById = new Map(data.types.map((t) => [t.BUDGET_TYPE_ID, t.BUDGET_NAME]));
  const versionType = new Map(data.versions.map((v) => [v.BUDGET_VERSION_ID, v.BUDGET_TYPE_ID]));

  const perAccount = new Map<string, { capital: number; approp: number; other: Set<string> }>();
  for (const row of data.budgets) {
    const key = keyOf(row);
    const bucket = perAccount.get(key) ?? { capital: 0, approp: 0, other: new Set<string>() };
    const typeId = versionType.get(row.BUDGET_VERSION_ID);
    const code = typeId === undefined || typeId === null ? undefined : codeById.get(typeId);
    if (code === 'CAPITAL') bucket.capital += Number(row.NET_AMOUNT) || 0;
    else if (code === 'APPROP') bucket.approp += Number(row.NET_AMOUNT) || 0;
    else {
      /*
       * `type ${typeId}` would print "type null" against the live ledger, where a null
       * type id is the *normal* state rather than an anomaly — a label a reader cannot
       * act on. Say which of the two absences this is, because they are different facts:
       * the version exists and carries no type, versus no version record at all.
       */
      const label =
        typeId == null
          ? 'the version carries no budget type'
          : nameById.get(typeId) ?? `type ${typeId}`;
      bucket.other.add(label);
    }
    perAccount.set(key, bucket);
  }

  return data.positions
    .map((p) => {
      const key = keyOfPosition(p);
      const bucket = perAccount.get(key) ?? { capital: 0, approp: 0, other: new Set<string>() };
      return {
        key,
        capitalFromRows: bucket.capital,
        capitalFromView: Number(p.WCPSS_BUDGET) || 0,
        appropFromRows: bucket.approp,
        appropFromView: Number(p.ALLOCATIONS_REIMB) || 0,
        availableFromColumns:
          (Number(p.ALLOCATIONS_REIMB) || 0) -
          (Number(p.ENCUMBRANCES) || 0) -
          (Number(p.EXPENDITURES) || 0),
        availableFromView: Number(p.AVAILABLE_FUNDS) || 0,
        uncolumned: [...bucket.other].sort(),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** True where every stated rule held. Used for the one-line verdict. */
export function derivationHolds(d: Derivation): boolean {
  return (
    close(d.capitalFromRows, d.capitalFromView) &&
    close(d.appropFromRows, d.appropFromView) &&
    close(d.availableFromColumns, d.availableFromView) &&
    d.uncolumned.length === 0
  );
}
