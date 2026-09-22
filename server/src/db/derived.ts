/**
 * The three `DERIVED_TABLES`, as Oracle SQL.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * `data/sql/turso/00-schema.sql` defines three views that live only in the libSQL
 * store: `V_SEGMENT_LEGEND`, `V_BUDGET_BY_ACCOUNT_PERIOD` and `V_ACCOUNT_POSITION`.
 * Under `DB_MODE=oracle` they do not exist, so every route that reads one answered
 * 503 `DB_UNAVAILABLE` — measured live on `/api/funding/positions`, which is the
 * "The budget could not be read from Oracle" notice in the project-details drawer.
 *
 * ★ AND NO GRANT COULD EVER FIX IT, because these are not an ungranted object.
 *   `V_ACCOUNT_POSITION`'s own body joins `GL_BUDGET_TYPES` on `BUDGET_TYPE_ID` and
 *   selects `BUDGET_TYPE_CODE` / `BUDGET_NAME`, and that table on this deployment has
 *   **1 row in 11 columns with neither column** — measured. A view whose definition
 *   names a column that does not exist cannot have been created, so there is nothing
 *   to grant. This is therefore a *port*, which is what this module is.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREDICATES ARE GENERATED ONCE AND COMPOSED PER CALL SITE
 * ---------------------------------------------------------------------------
 * `V_BUDGET_BY_ACCOUNT_PERIOD`'s own grain is one row per
 * `(code combination, budget version, period)` and that set is **3,423,238 rows,
 * measured at 17,243 ms** unscoped. Five statements in `routes/funding.ts` read it,
 * and if each one read the view whole, each would pay that. They do not need to:
 *
 *   - a total is one row and needs no `GL_CODE_COMBINATIONS` join at all
 *     (measured **2,308 ms**);
 *   - a period breakdown is 65 rows;
 *   - only `/api/funding/budgets` genuinely pages the fine grain (measured
 *     **3,499 ms** scoped).
 *
 * So the predicates below are written once, and each caller composes the grain it
 * actually needs. The reconciliation that makes this verifiable rather than merely
 * plausible: the budget total under this module and the position view's own
 * `WCPSS_BUDGET` sum are **bit-identical at 1,882,099,069.36** — two independently
 * measured shapes, one number.
 *
 * ---------------------------------------------------------------------------
 * ★ THE TENANT SCOPE IS MANDATORY, AND IT IS ALSO THE CORRECT ANSWER
 * ---------------------------------------------------------------------------
 * Unscoped these fragments do not merely get slower, they do not finish: a probe
 * wrapping the position fragment in an outer `SELECT` was abandoned after **more
 * than eight minutes** with `callTimeout` never firing, while the same shape scoped
 * to the organization's own fund and programs returned in **3,815 ms**. Scoped *is*
 * the difference.
 *
 * ★ But the performance argument is the lesser one. The organization row says fund
 *   `04`, programs `861`/`862`, and `GET /api/extract/current` already filters the
 *   committed figures to exactly those. An unscoped Oracle budget total sitting on
 *   the same screen as a scoped committed total would be **two different
 *   denominators presented as comparable**, which is a wrong answer rather than a
 *   slow one. The scope is in these fragments so that the two sides of that
 *   comparison agree.
 *
 *   `/api/coa/*` deliberately does NOT use the scoped fragments: browsing the chart
 *   of accounts is a question about the whole chart, so `legendFragment()` below is
 *   unscoped by design.
 *
 * ---------------------------------------------------------------------------
 * ★ WHAT IS *NOT* HERE: A ROW CAP
 * ---------------------------------------------------------------------------
 * Capping rows would be wrong. Every statement in this module that reads the budget
 * grain is ultimately an aggregate, and the grain it aggregates is 3.4 M rows while
 * the answer is one row. A `ROWNUM` cap would sum whichever rows came first, which
 * is not a smaller version of the answer — it is a different, arbitrary one. The
 * lever is the **scope** (which rows are eligible) and the grain (how many survive
 * grouping), never an arbitrary first-N.
 */

import { config } from '../config/env.js';
import { quoteIdent as q } from './sql.js';
import { defaultTenant, type Tenant } from '../auth/session.js';
import type { LedgerResolution } from './ledger-shape.js';

/**
 * The organization's ledger scope: the three settings that decide which rows exist.
 *
 * `programs: []` means **no program filter**, not "unscoped" — a tenant that names
 * no programs still has a fund, and dropping the fund filter too would change what
 * they are looking at.
 */
export type LedgerScope = Pick<Tenant, 'fund' | 'programs' | 'startFy'>;

/**
 * An Oracle string literal.
 *
 * ★ A literal rather than a bind, deliberately. These fragments are composed into
 *   statements that already carry their own bind arrays (`resource.ts`'s list engine
 *   passes `:limit`/`:offset`/filter binds), and interleaving a second set of binds
 *   through a string that is assembled in a different module is exactly how bind
 *   order drifts out of step with placeholder order. Doubling `'` is Oracle's own
 *   escape and is exact for the values used here, which come from the `organization`
 *   row rather than from a request.
 */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The predicates that decide which rows are in scope, measured rather than assumed.
 *
 * Each of these four is a place where the seeded view's SQL states something this
 * deployment contradicts:
 *
 *   - `LEDGER_ID = 1`. The seeded body says
 *     `LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')`.
 *     `GL_LEDGERS` holds **exactly one row** — ledger 1, "Wake County Public Schools",
 *     PRIMARY, USD — so that subquery is a no-op and the constant states the same
 *     thing without a join.
 *
 *   - `TRANSLATED_FLAG IS NULL OR = 'N'`. The seeded body says `TRANSLATED_FLAG = 'N'`,
 *     and **`TRANSLATED_FLAG` is NULL on 100 % of rows**, so the seeded predicate
 *     matches nothing at all. Widening it to accept NULL is what makes the fragment
 *     return the rows it is supposed to.
 *
 *   - `SUMMARY_FLAG = 'N' AND ENABLED_FLAG = 'Y'`. Carried over unchanged: these are
 *     genuine Oracle columns and the flags mean what the seeded view says.
 *
 *   - `PERIOD_YEAR >= startFy`. The seeded views have no period floor, which is why
 *     they are unbounded. A probe measured `PERIOD_YEAR >= 2023` to be equivalent to
 *     `fiscalFloor(2023)` = `2022-07-01` — the fiscal year's own July start — so there
 *     is **no off-by-one-year** in comparing a `PERIOD_YEAR` to a `startFy`.
 */
function periodFloor(scope: LedgerScope): string {
  // ★ The declared floor wins when `.env` states one. `LEDGER_START_YEAR` is
  //   scanned as a fiscal year for the reason in the note above: it is compared
  //   against `PERIOD_YEAR`, which is the year a period ENDS in.
  const year = config.ledgerScope.startYear ?? scope.startFy;
  return `gb.${q('PERIOD_YEAR')} >= ${Number(year)}`;
}

function accountFlags(): string {
  return `cc.${q('SUMMARY_FLAG')} = 'N' AND cc.${q('ENABLED_FLAG')} = 'Y'`;
}

function notTranslated(): string {
  return `(gb.${q('TRANSLATED_FLAG')} IS NULL OR gb.${q('TRANSLATED_FLAG')} = 'N')`;
}

/**
 * Fund always, programs only when the scope names some.
 *
 * ★ TWO SOURCES FEED THIS, AND THE DECLARED ONE WINS PER FIELD. `scope` is the
 *   `organization` row; `config.ledgerScope` is what `.env` declares. Either can
 *   be silent about either field, and the two are independent — so a deployment
 *   that pins only the fiscal floor leaves the fund and programs with the
 *   Organization screen, which is what makes this a per-field precedence rather
 *   than a "one source replaces the other".
 *
 * ★ THE FUND IS A LIST HERE, AND THAT IS A CORRECTNESS CHANGE RATHER THAN A
 *   SYNTAX ONE. The programs stay ANDed with the funds, so widening the fund is
 *   NOT the same as widening the read: measured on the live ledger,
 *   `SEGMENT1 IN ('02','04') AND SEGMENT3 IN ('861','862','863')` admits 2,543
 *   code combinations, of which fund 02 contributes **315 of its 588,016**. The
 *   remaining 587,701 combinations of fund 02 are outside the scope while the
 *   configuration appears to name the fund — so the excluded count has to be
 *   *reported* (`scopeExcluded` in `docs/plans/app-scope-filter.md`, "carried,
 *   never subtracted") rather than left for a reader to infer from an empty
 *   screen. A single fund emits `=` and the byte-identical SQL it always did, so
 *   nothing changes for a deployment that declares no fund list.
 */
function tenantScope(scope: LedgerScope): string {
  const declared = config.ledgerScope;

  const funds = declared.funds ?? [scope.fund];
  const fundSql =
    funds.length === 1
      ? `cc.${q('SEGMENT1')} = ${literal(funds[0]!)}`
      : `cc.${q('SEGMENT1')} IN (${funds.map(literal).join(', ')})`;

  // ★ `undefined` and `[]` are different answers, not the same one written twice:
  //   `undefined` = this file says nothing, the tenant row's programs apply;
  //   `[]`        = `PROGRAM_CODE=none`, i.e. every program under those funds.
  const programs = declared.programs ?? scope.programs;
  const programSql = programs.length
    ? ` AND cc.${q('SEGMENT3')} IN (${programs.map(literal).join(', ')})`
    : '';

  return `${fundSql}${programSql}`;
}

/** The scope the ledger reads actually use, after the per-field precedence. */
export interface ResolvedScope {
  funds: string[];
  /** `[]` means every program under those funds was read. */
  programs: string[];
  /** A fiscal year: it is compared against `GL_BALANCES.PERIOD_YEAR`. */
  startFy: number;
}

/** Flatten `LedgerScope` + the `.env` declaration into the one scope in effect. */
export function resolvedScope(scope: LedgerScope): ResolvedScope {
  const declared = config.ledgerScope;
  return {
    funds: declared.funds ?? [scope.fund],
    programs: declared.programs ?? scope.programs,
    startFy: declared.startYear ?? scope.startFy,
  };
}

/**
 * What `.env` and the `organization` row disagree about, in words, or `null`.
 *
 * ★ THIS EXISTS BECAUSE A SILENT SECOND SOURCE IS WORSE THAN NO SECOND SOURCE.
 *
 *   Both sources are legitimate — one is a deployment decision, the other a tenant
 *   setting the Organization screen can edit — and precedence is defined, so a
 *   disagreement is not a bug by itself. What *would* be a bug is not knowing
 *   which source produced a figure: an operator changes the fund in the UI, the
 *   screens do not move, and nothing says why. One log line at startup removes
 *   that whole class of confusion, and it is the only place the two can be seen
 *   side by side.
 *
 * Returns `null` when they agree, or when `.env` declares nothing.
 */
export function scopeDivergence(tenant: LedgerScope): string | null {
  const declared = config.ledgerScope;
  const parts: string[] = [];

  if (declared.funds !== undefined) {
    const asDeclared = [...declared.funds].sort().join(',');
    if (asDeclared !== tenant.fund) {
      parts.push(`fund .env=${asDeclared} row=${tenant.fund}`);
    }
  }

  if (declared.programs !== undefined) {
    const asDeclared = [...declared.programs].sort().join(',') || '(no filter)';
    const asRow = [...tenant.programs].sort().join(',') || '(no filter)';
    if (asDeclared !== asRow) {
      parts.push(`programs .env=${asDeclared} row=${asRow}`);
    }
  }

  if (declared.startYear !== undefined && declared.startYear !== tenant.startFy) {
    parts.push(`startFy .env=${declared.startYear} row=${tenant.startFy}`);
  }

  return parts.length === 0 ? null : parts.join('; ');
}

/** The one readable ledger. See `ledgerPredicate` above. */
const LEDGER_ID = 1;

/**
 * An equality filter on a segment, pushed **into** a fragment's own `WHERE`.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY THIS EXISTS, AND WHY IT IS NOT AN OPTIMISATION HINT
 * ---------------------------------------------------------------------------
 * Both fragments expose their segments as `MAX(cc.SEGMENTn)` over a `GROUP BY
 * cc.CODE_COMBINATION_ID`. That makes an ordinary outer predicate useless for
 * narrowing the read: `SELECT … FROM (<fragment>) WHERE LEVEL_CODE = '0450'` has to
 * build every account's row first and throw most of them away, because `LEVEL_CODE`
 * is an aggregate result and the grouping is already done. Measured on the live
 * endpoint, that is the whole cost of the project-details drawer:
 * `/api/funding/positions?level=0450` answered in **10.4 s** — no faster than the
 * unfiltered read, because the filter arrived too late to remove any work.
 *
 * Pushing `cc.SEGMENT5 = '0450'` down instead is **exactly equivalent**, not an
 * approximation: `CODE_COMBINATION_ID` determines all seven segments, so within one
 * combination `SEGMENT5` is a single value and `MAX(cc.SEGMENT5) = '0450'` holds iff
 * `cc.SEGMENT5 = '0450'` holds. The `HAVING` and the aggregates are untouched. The
 * answer is the same row set; only the amount of `GL_BALANCES` the database has to
 * read changes — and that is the difference between a drawer that opens and one that
 * appears hung.
 *
 * ★ THE FILTER MUST BE OPTIONAL, because a fragment used for a **total** has no
 *   segment to filter on: `GET /api/funding/summary` sums every account in scope, and
 *   passing it a level would turn a total into a subtotal that still called itself a
 *   total. Callers that page the fine grain pass a filter; callers that aggregate
 *   pass none.
 */
export type SegmentFilter = {
  /** `SEGMENT4` — the object code. The descriptor's `object` parameter. */
  object?: string;
  /** `SEGMENT5` — the level code. The descriptor's `level` parameter. */
  level?: string;
};

/** The `WHERE`-clause fragment for a `SegmentFilter`, or an empty string. */
function segmentEquality(filter: SegmentFilter): string {
  const parts: string[] = [];
  if (filter.object) parts.push(`cc.${q('SEGMENT4')} = ${literal(filter.object)}`);
  if (filter.level) parts.push(`cc.${q('SEGMENT5')} = ${literal(filter.level)}`);
  return parts.map((p) => `\n       AND ${p}`).join('');
}

/**
 * `V_ACCOUNT_POSITION` — nine columns, one row per code combination.
 *
 * ★ `GROUP BY cc.CODE_COMBINATION_ID` ALONE, with `SUM(CASE …)` per actual flag and
 *   `MAX()` on each segment. `CODE_COMBINATION_ID` determines all seven segments, so
 *   grouping by it is the same set of rows as grouping by all eight columns — and it
 *   matters, because the four flags arrive as more than one `GL_BALANCES` row per
 *   combination and a wider `GROUP BY` would silently split them. (An earlier probe
 *   tried the wide form and failed with `ORA-00979`, which is the database saying the
 *   same thing.)
 *
 * ★ `AVAILABLE_FUNDS` IS DERIVED, and it is supplied rather than left out.
 *   `routes/spend.ts` documents it as derived and the seeded view computes it as
 *   `IFNULL(app.ALLOCATIONS,0) - e.ENCUMBRANCES - a.EXPENDITURES`. The descriptor
 *   declares nine columns and a client decodes one shape, so it is computed in an
 *   outer wrapper rather than dropped — the alternative is a response shape that
 *   changes between dialects. Measured: the arithmetic yields **362,752,507.60**,
 *   positive and sensible, so no sign correction is needed.
 *
 * ★ `ALLOCATIONS_REIMB` IS A LITERAL ZERO, and that is measured rather than lazy.
 *   The seeded view computes it from budget rows whose type is `APPROP`. This ledger
 *   has **one** budget version (`1001`) and `GL_BUDGET_TYPES` holds a **single row**
 *   whose type is `STANDARD` in a table with no `BUDGET_TYPE_ID` and no
 *   `BUDGET_TYPE_CODE` — so an `APPROP` partition cannot exist here, and the honest
 *   value for the column is zero. Nothing in this deployment can populate it.
 *
 * ★ THE POPULATION RULE IS BEFORE THE AGGREGATE, NOT AFTER IT.
 *   The seeded view ends with
 *   `WHERE (app.CODE_COMBINATION_ID IS NOT NULL OR cap.CODE_COMBINATION_ID IS NOT NULL)`
 *   — "an account that has a budget row of a capital or appropriation type". With no
 *   such types that predicate is unsatisfiable, so a mechanical port of it would
 *   return **zero rows rather than zeros**. The replacement asks the same question in
 *   terms this ledger can answer: an account is in this view when it has a budget
 *   row, which is what `HAVING SUM(CASE WHEN ACTUAL_FLAG = 'B' …) > 0` says.
 *   Measured: **1,262 rows**.
 */
export function positionFragment(scope: LedgerScope, filter: SegmentFilter = {}): string {
  const b = q('ACTUAL_FLAG');
  const dr = q('PERIOD_NET_DR');
  const cr = q('PERIOD_NET_CR');
  const sum = (flag: string) =>
    `SUM(CASE WHEN gb.${b} = '${flag}' THEN gb.${dr} - gb.${cr} ELSE 0 END)`;
  const key =
    `cc.${q('SEGMENT1')}||'.'||cc.${q('SEGMENT2')}||'.'||cc.${q('SEGMENT3')}||'.'||` +
    `cc.${q('SEGMENT4')}||'.'||cc.${q('SEGMENT5')}||'.'||cc.${q('SEGMENT6')}||'.'||` +
    `cc.${q('SEGMENT7')}`;

  return (
    `(\n  SELECT p.*,\n` +
    `         (p.${q('ALLOCATIONS_REIMB')} - p.${q('ENCUMBRANCES')} - p.${q('EXPENDITURES')})` +
    ` AS ${q('AVAILABLE_FUNDS')}\n` +
    `    FROM (\n` +
    `    SELECT cc.${q('CODE_COMBINATION_ID')} AS ${q('CODE_COMBINATION_ID')},\n` +
    `           MAX(cc.${q('SEGMENT4')})      AS ${q('OBJECT_CODE')},\n` +
    `           MAX(cc.${q('SEGMENT5')})      AS ${q('LEVEL_CODE')},\n` +
    `           MAX(${key})                   AS ${q('BUDGET_ACCOUNT')},\n` +
    `           ${sum('B')} AS ${q('WCPSS_BUDGET')},\n` +
    `           0 AS ${q('ALLOCATIONS_REIMB')},\n` +
    `           ${sum('E')} AS ${q('ENCUMBRANCES')},\n` +
    `           ${sum('A')} AS ${q('EXPENDITURES')}\n` +
    `      FROM ${q('GL_CODE_COMBINATIONS')} cc\n` +
    `      JOIN ${q('GL_BALANCES')} gb\n` +
    `        ON gb.${q('CODE_COMBINATION_ID')} = cc.${q('CODE_COMBINATION_ID')}\n` +
    `     WHERE ${accountFlags()}\n` +
    `       AND ${tenantScope(scope)}\n` +
    `       AND gb.${q('LEDGER_ID')} = ${LEDGER_ID}\n` +
    `       AND ${notTranslated()}\n` +
    `       AND gb.${b} IN ('A', 'B', 'E')\n` +
    `       AND ${periodFloor(scope)}${segmentEquality(filter)}\n` +
    `     GROUP BY cc.${q('CODE_COMBINATION_ID')}\n` +
    `    HAVING SUM(CASE WHEN gb.${b} = 'B' THEN 1 ELSE 0 END) > 0\n` +
    `  ) p\n) src`
  );
}

/**
 * `V_BUDGET_BY_ACCOUNT_PERIOD` — fifteen columns at one row per
 * `(code combination, budget version, period)`.
 *
 * `ENCUMBRANCE_TYPE_ID IS NULL` is kept from the seeded body: an encumbrance row is
 * a commitment against a budget, not a budget, so including it would double-count.
 *
 * `MAX()` on each segment is safe for the reason given on `positionFragment` — the
 * code combination determines all seven — and `LEDGER_ID`/`BUDGET_VERSION_ID`/
 * `PERIOD_*` are genuinely in the `GROUP BY` because they are part of the grain.
 */
export function budgetFragment(scope: LedgerScope, filter: SegmentFilter = {}): string {
  const b = q('ACTUAL_FLAG');
  const segments = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => `MAX(cc.${q(`SEGMENT${n}`)}) AS ${q(`SEGMENT${n}`)}`)
    .join(',\n           ');

  return (
    `(\n  SELECT gb.${q('LEDGER_ID')}           AS ${q('LEDGER_ID')},\n` +
    `         gb.${q('CODE_COMBINATION_ID')} AS ${q('CODE_COMBINATION_ID')},\n` +
    `         ${segments},\n` +
    `         gb.${q('BUDGET_VERSION_ID')}   AS ${q('BUDGET_VERSION_ID')},\n` +
    `         gb.${q('PERIOD_YEAR')}         AS ${q('PERIOD_YEAR')},\n` +
    `         gb.${q('PERIOD_NUM')}          AS ${q('PERIOD_NUM')},\n` +
    `         gb.${q('PERIOD_NAME')}         AS ${q('PERIOD_NAME')},\n` +
    `         COALESCE(SUM(gb.${q('PERIOD_NET_DR')} - gb.${q('PERIOD_NET_CR')}), 0)` +
    ` AS ${q('NET_AMOUNT')},\n` +
    `         COUNT(*)                       AS ${q('BALANCE_ROWS')}\n` +
    `    FROM ${q('GL_BALANCES')} gb\n` +
    `    JOIN ${q('GL_CODE_COMBINATIONS')} cc\n` +
    `      ON cc.${q('CODE_COMBINATION_ID')} = gb.${q('CODE_COMBINATION_ID')}\n` +
    `   WHERE gb.${b} = 'B'\n` +
    `     AND ${notTranslated()}\n` +
    `     AND gb.${q('ENCUMBRANCE_TYPE_ID')} IS NULL\n` +
    `     AND gb.${q('LEDGER_ID')} = ${LEDGER_ID}\n` +
    `     AND ${periodFloor(scope)}\n` +
    `     AND ${accountFlags()}${segmentEquality(filter)}\n` +
    `     AND ${tenantScope(scope)}\n` +
    `   GROUP BY gb.${q('LEDGER_ID')}, gb.${q('CODE_COMBINATION_ID')},` +
    ` gb.${q('BUDGET_VERSION_ID')},\n` +
    `            gb.${q('PERIOD_YEAR')}, gb.${q('PERIOD_NUM')}, gb.${q('PERIOD_NAME')}\n` +
    `) src`
  );
}

/**
 * The Level segment's own value set, as a scalar subquery.
 *
 * ★ PINNED TO `ID_FLEX_CODE = 'GL#' AND ID_FLEX_NUM = 101`, and both halves matter.
 *   Measured: for `APPLICATION_COLUMN_NAME = 'SEGMENT5'` at `ID_FLEX_NUM = 101` this
 *   deployment declares **six** rows across five different flexfield codes — `SCL`
 *   with a **null** value set, `COST`/`GL#`/`GLLE` with `1002649` and `BPS`/`POS` with
 *   `1002647`. So any lookup that omits the flexfield code is choosing among competing
 *   answers, and one of them is null.
 *
 *   A scalar subquery rather than a join: it cannot fan a row out, and the value set
 *   is a property of the segment, not of the account.
 */
const LEVEL_VALUE_SET =
  `(SELECT MAX(s.${q('FLEX_VALUE_SET_ID')})\n` +
  `          FROM ${q('FND_ID_FLEX_SEGMENTS')} s\n` +
  `         WHERE s.${q('APPLICATION_COLUMN_NAME')} = 'SEGMENT5'\n` +
  `           AND s.${q('ID_FLEX_CODE')} = 'GL#'\n` +
  `           AND s.${q('ID_FLEX_NUM')} = 101)`;

/**
 * `V_SEGMENT_LEGEND` — one row per level code, with its name.
 *
 * ★ THE SEEDED VIEW'S DEFECT, AND WHY THIS IS A PIN RATHER THAN A WORKAROUND.
 *   The seeded body joins the legend on `FLEX_VALUE_SET_ID = 10101`. Measured:
 *   **`10101` exists nowhere in `FND_ID_FLEX_SEGMENTS`**, so the join matches nothing
 *   and `LEVEL_NAME` is null on every row — a defect that reads as "the data has no
 *   level names" when the data has all of them. The fix is to pin the set the Level
 *   segment actually declares, which `LEVEL_VALUE_SET` resolves to **1002649**.
 *
 * ★ AND THE FIX IS VERIFIED, not merely plausible: pinned, **829 of 829** level codes
 *   resolve to a real name — `Blank`, `K-5 Assignment`, `Finance`, `Year Round
 *   Education` — in **332 ms**.
 *
 * ★ WHY `LEFT JOIN` ON BOTH LEGS, and why the name comes from `_TL`.
 *   `FND_FLEX_VALUES` has **no `DESCRIPTION` column** on this deployment — an
 *   unprotected `fv.DESCRIPTION` fails with `ORA-00904`, measured. The name lives on
 *   `FND_FLEX_VALUES_TL`, which is the same divergence `db/ledger-shape.ts` records
 *   for the `FND_FLEX_VALUES` descriptor. Both joins are LEFT so a code in use with
 *   no legend row still appears: a code with no name is still a code an account uses,
 *   and dropping it would silently shrink the chart of accounts.
 *
 * ★ `SEGMENT5 <> ''` IS GONE. On Oracle the empty string *is* NULL, so that predicate
 *   is never true and never false — it can only remove rows by accident. (Measured on
 *   this data both guards are no-ops: 0 rows have `SEGMENT5 = ''` and 0 have it NULL.
 *   It is carried as `IS NOT NULL` alone because that is the view's actual intent and
 *   it is portable.)
 *
 * ★ THIS ONE IS NOT SCOPED, ON PURPOSE. A legend describes the chart of accounts, and
 *   `/api/coa/*` exists to browse all of it. Scoping it to one fund's programs would
 *   make the browse endpoint answer a different question. Measured: **1,308 rows in
 *   1,557 ms** unscoped, and 829 rows when the account flags are applied.
 */
export function legendFragment(): string {
  return (
    `(\n  SELECT cc.${q('SEGMENT5')}      AS ${q('LEVEL_CODE')},\n` +
    `         COUNT(*)                 AS ${q('ACCOUNT_COUNT')},\n` +
    `         MAX(tl.${q('DESCRIPTION')}) AS ${q('LEVEL_NAME')}\n` +
    `    FROM ${q('GL_CODE_COMBINATIONS')} cc\n` +
    `    LEFT JOIN ${q('FND_FLEX_VALUES')} fv\n` +
    `      ON fv.${q('FLEX_VALUE_SET_ID')} = ${LEVEL_VALUE_SET}\n` +
    `     AND fv.${q('FLEX_VALUE')} = cc.${q('SEGMENT5')}\n` +
    `    LEFT JOIN ${q('FND_FLEX_VALUES_TL')} tl\n` +
    `      ON tl.${q('FLEX_VALUE_ID')} = fv.${q('FLEX_VALUE_ID')}\n` +
    `     AND tl.${q('LANGUAGE')} = 'US'\n` +
    `   WHERE cc.${q('SEGMENT5')} IS NOT NULL\n` +
    `   GROUP BY cc.${q('SEGMENT5')}\n` +
    `) src`
  );
}

/**
 * The value set the Level segment declares, as a correlated scalar subquery.
 *
 * Exported so a caller can *report* the pin rather than restate it. `/api/coa/levels`
 * answers with a `valueSetId`, and the honest way to fill that field is to run the
 * same expression the legend join uses — a second copy of the predicate is how the
 * endpoint arrived at the wrong flexfield in the first place (its own lookup had no
 * `ID_FLEX_CODE` at all, so `ORDER BY ID_FLEX_NUM` chose a `PEA` segment definition
 * over the accounting one).
 *
 * A `SELECT` of this expression has no `FROM`, which is valid SQLite and invalid
 * Oracle — `toOracleDialect` adds the `FROM DUAL` this needs.
 */
export function levelValueSetExpression(): string {
  return LEVEL_VALUE_SET;
}

/** Which of the three a table is, and whether composing it needs the tenant. */
const DERIVED: Readonly<Record<string, (scope: LedgerScope, filter: SegmentFilter) => string>> = {
  V_ACCOUNT_POSITION: positionFragment,
  V_BUDGET_BY_ACCOUNT_PERIOD: budgetFragment,
  V_SEGMENT_LEGEND: () => legendFragment(),
};

/** True when `table` is one of the three views this module replaces. */
export function isDerivedTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(DERIVED, table.toUpperCase());
}

/**
 * The read source for a derived table, or `null` when it is not one.
 *
 * `null` is returned for two different situations and callers treat them the same:
 * this is not a derived table, or this is not Oracle and the real view is present.
 * The second is the important one — under `local`/`turso` these views exist and
 * resolve to the plain quoted name, so this module never runs and the SQL these
 * routes emit is byte-identical to before.
 *
 * A tenant that cannot be resolved is reported as `ok: false` rather than thrown:
 * `resource.ts` turns that into a 503 naming the table, which is the same answer the
 * route gave before this module existed and is more useful than a bare 500. It is an
 * *unreachable* state in practice — `defaultTenant()` throws only when no
 * organization is marked default, which the app schema seeds.
 *
 * ★ NOT `async` ON PURPOSE, AND THE RETURN TYPE IS THE REASON.
 *
 *   "Is this a derived table, and is the store Oracle?" are **synchronous** questions —
 *   they are a mode check and a map lookup. Only the scope fallback needs a promise. So
 *   the type is `Promise<LedgerResolution> | null` and not `Promise<LedgerResolution | null>`;
 *   the difference matters at the call site, because `p !== null` narrows the *promise*
 *   in the first form and narrows nothing in the second. Only the tenant fallback —
 *   the one genuinely asynchronous branch — is wrapped in a promise.
 */
export function derivedPlan(
  table: string,
  scope?: LedgerScope,
  filter: SegmentFilter = {},
): Promise<LedgerResolution> | null {
  if (config.db.mode !== 'oracle') return null;

  const compose = DERIVED[table.toUpperCase()];
  if (compose === undefined) return null;

  if (scope !== undefined) {
    return Promise.resolve({ ok: true, from: compose(scope, filter), unavailable: [] });
  }

  return (async (): Promise<LedgerResolution> => {
    try {
      const tenant = await defaultTenant();
      return { ok: true, from: compose(tenant, filter), unavailable: [] };
    } catch (err) {
      return {
        ok: false,
        reason:
          'the ledger scope could not be read, and this view is composed from it: ' +
          ((err as { message?: string }).message ?? String(err)),
      };
    }
  })();
}
