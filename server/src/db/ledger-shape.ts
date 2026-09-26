/**
 * Where a ledger descriptor's columns actually live, per dialect.
 *
 * ★ THE PROBLEM, STATED FROM MEASUREMENT
 *
 * `data/sql/turso/sample.db` was built as a *narrowed projection of the extract
 * views, loaded under the base-table names*. So in libSQL `PO_HEADERS_ALL` has 13
 * columns including `PO_NUMBER` / `EXP_PROJECT_NAME` / `EXP_PO_NUMBER`, and
 * `GL_CODE_COMBINATIONS` has 15 including `DESCRIPTION` / `CREATION_DATE`. Live
 * Oracle keeps EBS's own shape — `APPS.PO_HEADERS_ALL` is a synonym for
 * `PO.PO_HEADERS_ALL#` with **213** columns and no `PO_NUMBER` — and exposes the
 * extract shape only under the customer's granted `WCSEXP_*` views, of which
 * `WCSEXP_PO_HEADERS` (10 columns) is exactly the PO-header contract.
 *
 * A route's static descriptor can therefore be true of only ONE of the two
 * stores, which is why endpoints answered 500 with no line number that localised
 * the cause. Deleting the columns was never an option: they are real and
 * populated in libSQL, and `searchable` / `sortable` / `filters` / `defaultSort`
 * name them too.
 *
 * ★ WHY AVAILABILITY IS MEASURED RATHER THAN WRITTEN DOWN
 *
 * The first version of this file was a hand-written map of "which column is
 * missing where", compiled from a probe that had diffed **18** descriptors. Its
 * own control then found **9 more** drifted tables it had never been told about —
 * `PA_PROJECTS_ALL`, `GL_BUDGET_VERSIONS`, `GL_BUDGET_TYPES`,
 * `GL_BUDGET_ASSIGNMENTS`, `GL_BUDGET_ENTITIES`, `PA_BUDGET_VERSIONS`,
 * `PA_BUDGET_LINES`, `V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD` — and one
 * column name the map had simply invented. A map compiled from a sample of the
 * descriptors cannot be right about the whole set, and its failure mode is
 * precisely the one this file exists to remove: a 500 on a route the framework
 * promised would work. So availability is now **asked of the database**.
 *
 * The oracle is `SELECT * FROM <obj> WHERE ROWNUM <= 1` and its result metadata —
 * the same `columns` array the routes already receive. `ALL_TAB_COLUMNS` is
 * useless here: it returns **nothing** for these names, because the catalogue does
 * not follow the synonym hop to `PO.PO_HEADERS_ALL#` for this account. Measured
 * consequence of that hop, and the reason a missing *column* is so hard to read
 * from an error: on a table-backed synonym it is reported as `ORA-00942` against
 * the **table**, with the offset on the object name — never `ORA-00904` against
 * the column. Set membership is the only reliable oracle, which is what this does.
 *
 * The descriptor stays the source of truth for the *contract*; the database is the
 * source of truth for what it can serve.
 *
 * ★ THE SHAPE OF THE ANSWER
 *
 * An inline view that projects **exactly the descriptor's column names**, aliased
 * `src`. Everything downstream is then unchanged: `selectList`, `orderByClause`,
 * the filter WHERE builder and the `?q=` LIKE builder keep quoting descriptor
 * names, keep working, and need no dialect knowledge of their own — and because
 * there is exactly one object in the FROM clause, no reference is ever ambiguous.
 * One seam.
 *
 * A column no readable object can supply is projected as `NULL` **under its own
 * name**, not dropped: dropping it would change the response shape between
 * dialects so a client could not write one decoder. Nulling keeps one contract and
 * puts the absence in the data. Each one is logged once per table at resolution
 * time, so a grant that vanishes is a line in the log rather than a mystery blank.
 *
 * ★ WHAT IS STILL WRITTEN DOWN, AND WHY THAT SPLIT IS THE HONEST ONE
 *
 * `DIVERGENCES` holds only what measurement *cannot* discover, because it is a
 * claim about meaning rather than about presence:
 *   - a renamed column (`APPLICATION_COLUMN` is `APPLICATION_COLUMN_NAME`);
 *   - a column that lives on a different object (`DESCRIPTION` is on
 *     `FND_FLEX_VALUES_TL`; `FLEX_VALUE` is not on `_TL`);
 *   - two objects that are not supersets of one another and must be joined:
 *     `PO_HEADERS_ALL` has `AGENT_ID` / `ORG_ID` / `CANCEL_FLAG` and no
 *     `PO_NUMBER`, and `WCSEXP_PO_HEADERS` has `PO_NUMBER` / `EXP_*` and none of
 *     the first three, so reading either alone loses three columns.
 * That is four entries against thirty-one ledger descriptors, and each is
 * *verified* rather than assumed: the control in `server/tmp-read-source.ts`
 * re-runs every statement against the base table and requires it to FAIL wherever
 * a divergence is declared and to SUCCEED wherever one is not.
 */

import { quoteIdent as q } from './sql.js';
import { storeDriver } from './client.js';
import { storeForTable } from './store.js';
import { derivedPlan, type SegmentFilter } from './derived.js';
import { config } from '../config/env.js';

/** The public contract of a resource: which columns its responses contain. */
export interface LedgerShapeRequest {
  readonly table: string;
  readonly columns: readonly string[];
  /**
   * A key-space narrowing for a **derived** table's own `WHERE`.
   *
   * ★ IT NEVER CHANGES THE ANSWER, ONLY THE WORK. The caller still applies its own
   *   filter on top (a descriptor's `filters` entry, so `LEVEL_CODE = :f_level`
   *   still appears in the outer `WHERE`); this only tells the composed fragment
   *   that `SEGMENT5` is already known, which lets the database drop the accounts
   *   before it joins `GL_BALANCES` rather than after aggregating them. Measured on
   *   the live ledger, `/api/funding/positions?level=0450`: **10,755 ms → 58 ms**
   *   for the same five rows (`identical: true`).
   *
   * ★ AND IT IS NOT CACHED. `planCacheDerived` is keyed by table alone, which is
   *   only sound while a table's read source is a property of the table. A filtered
   *   request makes it a property of the request, so a filtered plan must never
   *   enter that cache — otherwise the next unfiltered caller would silently read a
   *   fragment that only knows about one level. A wrong answer that looks like a
   *   fast one is the worst failure this module could produce, so filtered plans
   *   are composed per request and the cache is left for the unfiltered case.
   */
  readonly filter?: SegmentFilter;
}

/**
 * A divergence is a measured claim about where a column lives.
 *
 * `object` is the object the descriptor's *unlisted* columns come from, and `alias`
 * qualifies them inside `from` (empty for a single-object source). `at` holds the
 * few columns that come from somewhere else, as ready-quoted expressions.
 */
interface Divergence {
  readonly object: string;
  readonly from: string;
  readonly alias: string;
  readonly at?: Readonly<Record<string, string>>;
}

/**
 * ★ A 1:1 JOIN ON A PRIMARY KEY, WHICH IS WHY IT IS NOT A ROW-MULTIPLIER.
 *
 * The join key is `PO_HEADER_ID`, the primary key of both objects, so each side
 * contributes exactly one row per header. The view is the LEFT side on purpose: it
 * is the customer's own definition of the purchasable population, so if it is
 * narrower than the 213-column table the join inherits that narrowing instead of
 * undoing it.
 */
const DIVERGENCES: Readonly<Record<string, Divergence>> = {
  PO_HEADERS_ALL: {
    object: 'PO_HEADERS_ALL',
    alias: 'h',
    from:
      `${q('WCSEXP_PO_HEADERS')} v\n` +
      `  JOIN ${q('PO_HEADERS_ALL')} h ON h.${q('PO_HEADER_ID')} = v.${q('PO_HEADER_ID')}`,
    at: {
      PO_NUMBER: `v.${q('PO_NUMBER')}`,
      EXP_PROJECT_NAME: `v.${q('EXP_PROJECT_NAME')}`,
      EXP_PO_NUMBER: `v.${q('EXP_PO_NUMBER')}`,
    },
  },

  /** The column is named `APPLICATION_COLUMN_NAME` on the object. */
  FND_ID_FLEX_SEGMENTS: {
    object: 'FND_ID_FLEX_SEGMENTS',
    alias: '',
    from: q('FND_ID_FLEX_SEGMENTS'),
    at: { APPLICATION_COLUMN: q('APPLICATION_COLUMN_NAME') },
  },

  /**
   * `DESCRIPTION` lives on `FND_FLEX_VALUES_TL`, which is granted. LEFT JOIN so a
   * value with no US translation still appears: a value with no English name is
   * still a value an account combination can use, and dropping it would silently
   * shrink the value set.
   */
  FND_FLEX_VALUES: {
    object: 'FND_FLEX_VALUES',
    alias: 'v',
    from:
      `${q('FND_FLEX_VALUES')} v\n` +
      `  LEFT JOIN ${q('FND_FLEX_VALUES_TL')} t\n` +
      `    ON t.${q('FLEX_VALUE_ID')} = v.${q('FLEX_VALUE_ID')}\n` +
      `   AND t.${q('LANGUAGE')} = 'US'`,
    at: { DESCRIPTION: `t.${q('DESCRIPTION')}` },
  },

  /**
   * The mirror of the entry above: `FLEX_VALUE_SET_ID` and `FLEX_VALUE` are not on
   * `_TL` at all, so the translation table is joined back to its base to recover
   * them. The row count stays the translation table's, so a value with two
   * translations is still two rows.
   */
  FND_FLEX_VALUES_TL: {
    object: 'FND_FLEX_VALUES_TL',
    alias: 't',
    from:
      `${q('FND_FLEX_VALUES_TL')} t\n` +
      `  JOIN ${q('FND_FLEX_VALUES')} v ON v.${q('FLEX_VALUE_ID')} = t.${q('FLEX_VALUE_ID')}`,
    at: {
      FLEX_VALUE_SET_ID: `v.${q('FLEX_VALUE_SET_ID')}`,
      FLEX_VALUE: `v.${q('FLEX_VALUE')}`,
    },
  },

  /**
   * ★★ THE FOUR BUDGET SETUP TABLES: THE SAMPLE AND THE LEDGER ARE NOT SUPERSETS
   *    OF ONE ANOTHER, SO THIS IS A DIVERGENCE AND NOT A RENAME.
   *
   * The bundled sample (`data/sql/turso/00-schema.sql:231–283`) was authored to the
   * *extract's* vocabulary — `BUDGET_TYPE_ID`, `BUDGET_TYPE_CODE`, `STATUS_CODE`,
   * `LATEST_FLAG`, `FIRST_PERIOD_NAME`, `BUDGET_ENTITY_NAME`, `RANGE_FROM`/`RANGE_TO`
   * — and the sample's own reporting views join on those names (`:688–702`). The
   * live ledger keeps EBS's real shape instead: `GL_BUDGET_TYPES` is keyed on
   * `BUDGET_TYPE` (a VARCHAR) and has no `BUDGET_TYPE_ID` at all; a version carries
   * `BUDGET_TYPE`, `VERSION_NUM`, `STATUS`, `DATE_OPENED`; an entity's name is `NAME`.
   *
   * Measured with `ledgerPlan` on both arms — the sample reports `unavailable: []`
   * for all four while the ledger reports **4 of 5**, **8 of 11**, **3 of 4** and
   * **3 of 4** respectively. So neither store holds the other's columns, and the
   * descriptor cannot be renamed to suit one without breaking the other.
   *
   * ★ WHY THE EXISTING GUARD DID NOT CATCH THIS. `resolve` refuses an object that
   *   supplies *none* of the declared columns (the "different shape" 503). Every one
   *   of these four keeps one to three declared columns, so the guard is not reached
   *   and the endpoints answered **200 with the missing fields null** — a defect no
   *   status-code check can see.
   *
   * ★ THE MAPPING IS BY MEANING, NOT BY RESEMBLANCE. `BUDGET_TYPE_CODE` and
   *   `BUDGET_TYPE` are the same key; `STATUS_CODE` and `STATUS` are the same column
   *   under two names; `BUDGET_ENTITY_NAME` is `NAME`. Two are *not* renames and are
   *   deliberately left absent rather than guessed:
   *     - `ENABLED_FLAG` has no counterpart on any of the three objects. EBS encodes
   *       "not in use" as `STATUS_CODE` on an *entity*, and a type has no such
   *       column — so an entity's status is exposed through its own `STATUS_CODE`
   *       (see `GL_BUDGET_ENTITIES` below) and a type's `ENABLED_FLAG` stays null.
   *     - `LATEST_FLAG` genuinely does not exist on the ledger. It is not `'N'`; it
   *       is absent, and the UI must say so rather than label every version
   *       superseded. Leaving it out of `at` is what keeps that honest.
   *
   * ★ CASE DIFFERS BETWEEN TWO OF THEM AND THE JOIN DEPENDS ON IT. A version stores
   *   `BUDGET_TYPE = 'standard'` (lowercase) while the type table stores
   *   `'STANDARD'`. Any join between the two needs `UPPER()` on both sides or it
   *   silently matches nothing — see the detail route in `routes/funding.ts`.
   */
  GL_BUDGET_TYPES: {
    object: 'GL_BUDGET_TYPES',
    alias: '',
    from: q('GL_BUDGET_TYPES'),
    at: {
      BUDGET_TYPE_CODE: q('BUDGET_TYPE'),
      BUDGET_NAME: q('BUDGET_TYPE'),
    },
  },

  GL_BUDGET_VERSIONS: {
    object: 'GL_BUDGET_VERSIONS',
    alias: '',
    from: q('GL_BUDGET_VERSIONS'),
    at: {
      BUDGET_TYPE_ID: q('BUDGET_TYPE'),
      STATUS_CODE: q('STATUS'),
      FIRST_PERIOD_NAME: q('DATE_OPENED'),
    },
  },

  GL_BUDGET_ENTITIES: {
    object: 'GL_BUDGET_ENTITIES',
    alias: '',
    from: q('GL_BUDGET_ENTITIES'),
    at: {
      BUDGET_ENTITY_NAME: q('NAME'),
      ENABLED_FLAG: q('STATUS_CODE'),
    },
  },

  /**
   * ★ `GL_BUDGET_ASSIGNMENTS` IS THE ONE THAT CANNOT BE MAPPED, AND SAYING SO IS
   *   THE ANSWER.
   *
   * The sample keys a range row on `(BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO)`. The
   * ledger has **no `BUDGET_VERSION_ID`** — it has `FUNDING_BUDGET_VERSION_ID`,
   * which is **NULL on all 234,074 rows** (measured), plus `CODE_COMBINATION_ID`,
   * `RANGE_ID` and `ORDERING_VALUE`. So on this deployment an assignment is a
   * per-account-combination row that no version can be joined to, and the honest
   * mapping is: expose the entity and the combination, and leave the version key
   * null rather than substituting a column that is empty everywhere.
   *
   * `RANGE_FROM`/`RANGE_TO` are left absent for the same reason — `ORDERING_VALUE`
   * is a single segment value (e.g. `5110`), not an end of a concatenated key, and
   * calling it `RANGE_FROM` would invent a range that does not exist.
   */
  GL_BUDGET_ASSIGNMENTS: {
    object: 'GL_BUDGET_ASSIGNMENTS',
    alias: '',
    from: q('GL_BUDGET_ASSIGNMENTS'),
    at: {
      CODE_COMBINATION_ID: q('CODE_COMBINATION_ID'),
    },
  },
};

/**
 * ★ A TRANSIENT FAILURE IS NOT A FACT ABOUT GRANTS, AND MUST NOT BE CACHED.
 *
 * `probeCache` and `planCache` exist to hold stable facts: which columns an object
 * has, and what grants this account holds. Both used to cache *any* outcome,
 * including the reason a probe failed. A probe that failed because the pool was
 * momentarily exhausted remembered `NJS-040: connection request timeout` forever,
 * so `ledgerPlan` kept answering `ok:false` and the affected endpoints returned
 * `503 … cannot be read on this deployment` in ~100 ms — for the life of the
 * process, long after the database was answering again. `GET /api/health` stayed
 * green throughout, because it does not consult this module, so the screen said
 * "unreachable" while the probe beside it said the ledger was fine.
 *
 * Measured: a single 60-request burst was enough to poison twelve endpoints
 * (`/api/coa/*` among them) into permanent 503s that survived every later
 * request; the same endpoints answered 200 after the process restarted. The
 * cached reason named a 45 s queue timeout on a request that had returned in
 * 0.1 s, which is what gave the cache away.
 *
 * So: a connection-shaped error is reported once and then forgotten, and the next
 * request measures again. A grant-shaped error (`ORA-00942`) is still cached, as
 * intended — that one really does not change while the process lives.
 */
function isTransientFailure(err: unknown): boolean {
  const e = err as { code?: unknown; errorNum?: unknown };
  // NJS-* are the driver's own errors: pool exhaustion, timeouts, closed pools.
  if (typeof e?.code === 'string' && e.code.startsWith('NJS-')) return true;
  // The ORA numbers that mean "the connection", not "the object".
  return (
    typeof e?.errorNum === 'number' &&
    [3113, 3114, 12170, 12514, 12541, 12547, 25408].includes(e.errorNum)
  );
}

/** The customer's extract views are named after the object they project. */
const EXTRACT_VIEW_PREFIX = 'WCSEXP_';

interface ObjectProbe {
  /** Uppercased column names, or `null` when the object is not readable. */
  readonly columns: Set<string> | null;
  /** The database's own words for why, when it is not readable. */
  readonly error: string | null;
  /** True when the reason was the connection rather than the object. */
  readonly transient: boolean;
}

const probeCache = new Map<string, Promise<ObjectProbe>>();

/**
 * A one-row read of `object`, spelled for the ledger's dialect.
 *
 * ★ THE THREE SPELLINGS ARE NOT INTERCHANGEABLE, AND THE PROBE IS THE WORST PLACE
 *   FOR A DIALECT GUESS. It exists to *discover* what an object looks like, so a
 *   syntax error here is reported as "this object cannot be read" — a claim about
 *   the data, made on the strength of a claim about the engine. That is how
 *   `ROWNUM` turned two readable tables into 503s under `DB_MODE=sqlserver`.
 *
 * ★ `TOP (1)` RATHER THAN `OFFSET … FETCH NEXT 1 ROWS ONLY`. `FETCH` requires an
 *   `ORDER BY` in its own query block, and this probe deliberately has none — the
 *   row's contents are never read, only its column metadata. `TOP` carries no such
 *   requirement, so it is the only T-SQL form that fits a statement with no
 *   ordering.
 *
 * The row itself is never used: the caller reads `res.columns`. Any one row will
 * do, which is why an unordered limit is the right tool rather than a compromise.
 */
function oneRowSelect(object: string): string {
  const dialect = storeDriver('ledger').dialect;
  if (dialect === 'sqlserver') return `SELECT TOP (1) * FROM ${q(object)}`;
  if (dialect === 'oracle') return `SELECT * FROM ${q(object)} WHERE ROWNUM <= 1`;
  return `SELECT * FROM ${q(object)} LIMIT 1`;
}

/**
 * Which columns an object actually has, or why it cannot be read.
 *
 * Read through the *ledger store* rather than the routed driver on purpose: the
 * routed driver decides a statement's store from the tables it names and throws
 * for a name it does not know, so probing `WCSEXP_PO_HEADERS` through it would
 * need that name registered before it could be discovered. This runs against the
 * ledger directly and so cannot be refused for that reason.
 */
function probeObject(object: string): Promise<ObjectProbe> {
  const cached = probeCache.get(object);
  if (cached) return cached;

  const pending = (async (): Promise<ObjectProbe> => {
    try {
      const res = await storeDriver('ledger').execute({
        // ★★ THE ROW LIMIT IS DIALECT-SPELLED, AND `ROWNUM` IS NOT PORTABLE.
        //
        //   Measured under `DB_MODE=sqlserver`: every probe failed with
        //   `Invalid column name 'ROWNUM'`, so `GL_CODE_COMBINATIONS` and
        //   `PO_HEADERS_ALL` — two tables that exist and read perfectly — were
        //   reported as "cannot be read on this deployment" and their endpoints
        //   answered 503. The failure named a *column*, which reads like a schema
        //   problem rather than a dialect one.
        //
        //   All three return one row, which is all this probe wants — it reads
        //   `res.columns`, never the row.
        sql: oneRowSelect(object),
        args: {},
      });
      const cols = res.columns ?? [];
      if (cols.length === 0) {
        return { columns: null, error: 'the database returned no column metadata for it', transient: false };
      }
      return { columns: new Set(cols.map((c) => c.toUpperCase())), error: null, transient: false };
    } catch (err) {
      const transient = isTransientFailure(err);
      // See `isTransientFailure`: an error about the connection is not a fact
      // about the object, so it must not be remembered. Dropping the entry here
      // means the next request probes again and the endpoint heals itself the
      // moment the pool recovers, with no restart.
      if (transient) probeCache.delete(object);
      return {
        columns: null,
        error: (err as { message?: string }).message ?? String(err),
        transient,
      };
    }
  })();

  probeCache.set(object, pending);
  return pending;
}

/** A resolved read source for one descriptor. */
export type LedgerResolution =
  | {
      readonly ok: true;
      /** The `FROM` expression: a quoted object, or an inline view aliased `src`. */
      readonly from: string;
      /** Declared columns with no readable source, served as null. Empty usually. */
      readonly unavailable: readonly string[];
    }
  | {
      readonly ok: false;
      /** Why the object cannot be read, in the database's own words. */
      readonly reason: string;
      /**
       * True when the reason was the connection rather than the object, so the
       * caller must not treat it as durable. See `isTransientFailure`.
       */
      readonly transient?: boolean;
    };

function inlineView(projection: string, from: string): string {
  return `(\n  SELECT ${projection}\n  FROM ${from}\n) src`;
}

/**
 * Resolve the read source for a descriptor on Oracle.
 *
 * Order of preference, each step measured rather than assumed:
 *   1. a declared divergence — the only statement of where a renamed or
 *      cross-object column actually is;
 *   2. the base table, when it holds every declared column. This is the common
 *      case (25 of 31 descriptors) and returns the plain quoted name, so those
 *      routes emit byte-identical SQL to before this module existed;
 *   3. the customer's `WCSEXP_<table>` view, when it holds every declared column —
 *      this is how `FND_ID_FLEX_STRUCTURES` gets its `DESCRIPTION`, with no entry
 *      in any table here;
 *   4. otherwise the base table with the genuinely absent columns served as null.
 */
async function resolve(
  table: string,
  columns: readonly string[],
): Promise<LedgerResolution> {
  const divergence = DIVERGENCES[table];

  if (divergence) {
    /**
     * ★ ZERO COLUMNS IS NOT A SMALLER REQUEST HERE, IT IS AN IMPOSSIBLE ONE.
     *
     *   The projection *is* this table's read: the inline view exists to rename the
     *   columns that live elsewhere, and it is built by mapping over the column list.
     *   Handed an empty one it composes
     *
     *       SELECT
     *         
     *       FROM (…) src
     *
     *   which Oracle rejects — so the caller got a syntax error for a table that reads
     *   perfectly, and (before the cache guard above) so did every caller after it.
     *   Say what is missing instead of emitting a statement that cannot parse.
     */
    if (columns.length === 0) {
      return {
        ok: false,
        reason:
          `${table} is read through a composed projection (its columns are renamed ` +
          `or live on another object), so it cannot be resolved without a column list`,
      };
    }

    const probe = await probeObject(divergence.object);
    if (probe.columns === null) {
      return { ok: false, reason: probe.error ?? 'not readable', transient: probe.transient };
    }
    const available = probe.columns;
    const unavailable: string[] = [];
    const projection = columns
      .map((c) => {
        const elsewhere = divergence.at?.[c];
        if (elsewhere) return `${elsewhere} AS ${q(c)}`;
        if (available.has(c.toUpperCase())) {
          return divergence.alias === '' ? q(c) : `${divergence.alias}.${q(c)}`;
        }
        unavailable.push(c);
        return `NULL AS ${q(c)}`;
      })
      .join(', ');
    return { ok: true, from: inlineView(projection, divergence.from), unavailable };
  }

  const base = await probeObject(table);
  if (base.columns === null) {
    return { ok: false, reason: base.error ?? 'not readable', transient: base.transient };
  }

  const missing = columns.filter((c) => !base.columns!.has(c.toUpperCase()));
  if (missing.length === 0) return { ok: true, from: q(table), unavailable: [] };

  const viewName = `${EXTRACT_VIEW_PREFIX}${table}`;
  const view = await probeObject(viewName);
  if (view.columns !== null && columns.every((c) => view.columns!.has(c.toUpperCase()))) {
    return { ok: true, from: q(viewName), unavailable: [] };
  }

  /**
   * ★ AN OBJECT THAT SUPPLIES NONE OF THE DECLARED COLUMNS IS NOT THE OBJECT THE
   *   RESOURCE DESCRIBES, so it gets the 503 rather than rows of nulls.
   *
   *   Measured: the base tables that back the budget resources are real and
   *   readable, but they are *not shaped like the descriptor at all* — a probe
   *   finds the object and then logs "8 of 11 declared columns have no readable
   *   source". Serving that would return every row of `GL_BUDGET_ASSIGNMENTS`
   *   (234,074 of them) with three of its four fields blank, which is not a
   *   truncated answer, it is an invented one. A gap of one or two columns is a
   *   real gap and is served as null; an object with no overlap at all means the
   *   resource refers to something this database does not have.
   *
   *   Deliberately no threshold between the two: "zero overlap" is a fact and
   *   "less than half" is a taste, and a taste encoded here would be a silent
   *   policy that changes an answer.
   */
  if (missing.length === columns.length) {
    return {
      ok: false,
      reason:
        `none of its ${columns.length} declared column(s) exist on ${table} ` +
        `(the object on this database is a different shape)`,
    };
  }

  return {
    ok: true,
    from: inlineView(
      columns
        .map((c) => (base.columns!.has(c.toUpperCase()) ? q(c) : `NULL AS ${q(c)}`))
        .join(', '),
      q(table),
    ),
    unavailable: missing,
  };
}

/**
 * The live expression for one ledger column, for a query that is written by hand.
 *
 * `ledgerPlan` covers a whole described table, which is the right answer for the
 * resource routes. But several routes build their SQL directly and therefore never
 * consult it — and one of those named a column under its *libSQL* name on the
 * Oracle side, where the object calls it something else. The result was
 * `ORA-00904: "APPLICATION_COLUMN": invalid identifier`, a 500 on
 * `/api/coa/levels` and `/api/coa/segments`, on an object that reads perfectly.
 *
 * This exists so the fix is the same single source of truth the resolver uses,
 * rather than a second hard-coded column name that can drift from `DIVERGENCES`:
 * on any dialect but Oracle it returns the quoted logical name unchanged, and on
 * Oracle it returns whatever `DIVERGENCES` says that column actually is. A column
 * with no declared divergence is returned as-is, so this is a no-op everywhere the
 * shape already matches — which is the whole of libSQL/Turso.
 *
 * ★ Note the value returned is an EXPRESSION, not an identifier: for
 *   `PO_HEADERS_ALL.EXP_PROJECT_NAME` it carries its own `v.` qualifier, because
 *   that column lives on the joined view and cannot be named unqualified. Callers
 *   that need to prefix it (`s.`) should use `ledgerPlan` for the table instead;
 *   this helper is for unqualified projections.
 */
export function ledgerIdent(table: string, column: string): string {
  // ★ libSQL ONLY, for the same reason as `ledgerPlan` above: `DIVERGENCES`
  //   records the columns the *live* instance spells differently, and a SQL Server
  //   copy of the same tables has the same divergences. Under `local`/`turso` the
  //   sample already holds the logical names, so this stays a no-op there.
  if (config.db.mode === 'local' || config.db.mode === 'turso') return q(column);
  return DIVERGENCES[table]?.at?.[column] ?? q(column);
}

const planCache = new Map<string, Promise<LedgerResolution>>();

/**
 * The read source for a descriptor, cached per table.
 *
 * Every dialect except Oracle short-circuits to the plain table, so this costs
 * nothing where the extract-shaped tables already hold the extract shape. On
 * Oracle the first request per table pays one metadata query; the rest are free.
 *
 * ★ BUT ONLY FOR TABLES THAT LIVE IN THE LEDGER. `resource.ts` calls this for
 *   every descriptor it serves, and the descriptors include app-owned tables
 *   (`organization`, `saved_view*`) and the `X_REPORT_*` extract tables, which are
 *   rows this application wrote. Probing one of those against Oracle answers
 *   `ORA-00942` — they do not exist there — and the resolver would then report the
 *   whole resource as unreadable and answer 503, breaking endpoints that were
 *   working. Caught by the smoke suite, not by the probe, because the probe
 *   filtered to `EBS`/`DERIVED` exactly as this function now does.
 *
 *   `storeForTable` is the authority on which database holds a table, so asking it
 *   is the same decision statement routing makes — one answer, two callers.
 */
export function ledgerPlan(d: LedgerShapeRequest): Promise<LedgerResolution> {
  const identity: LedgerResolution = { ok: true, from: q(d.table), unavailable: [] };

  // ★★ THE GATE IS "IS THE LEDGER libSQL", NOT "IS IT ORACLE" — the same
  //    correction `derivedPlan` needed, and this is the copy that actually
  //    mattered. `resource.ts` resolves its read source through *this* function,
  //    not through `derivedPlan`, so under `DB_MODE=sqlserver` the identity plan
  //    was returned and the raw view name went to the server:
  //
  //      /api/spend/encumbrances → Invalid object name 'V_ACCOUNT_POSITION'
  //      /api/coa/levels         → Invalid object name 'FND_FLEX_VALUES'
  //
  //    ★ `FND_FLEX_VALUES` IS NOT ONE OF THE THREE DERIVED VIEWS, AND THAT IS THE
  //      POINT. It is a real table that the *live instance* lacks — `coa.ts` reads
  //      it through `ledgerIdent`, which substitutes a readable source. So the
  //      "not libSQL" condition has to hold for the whole module, not just for the
  //      three composed views below: every branch here exists to cope with an
  //      object the live ledger does not present the way the sample does.
  //
  //    Under `local`/`turso` the real views and tables are present, so the identity
  //    plan is correct and the emitted SQL stays byte-identical to before.
  if (config.db.mode === 'local' || config.db.mode === 'turso') return Promise.resolve(identity);

  /**
   * ★ THE THREE DERIVED VIEWS ARE CHECKED FIRST, AND BEFORE THE STORE LOOKUP.
   *
   *   They are the one class of table whose Oracle SQL cannot be *discovered*,
   *   because the object does not exist there at all: the views live in the libSQL
   *   store and their Oracle equivalents are composed from predicates. So they are
   *   answered from `db/derived.ts` before anything probes — which also means the
   *   metadata round-trip a probe would cost is never paid (`derivePlan` is cached
   *   per table like everything else here, and the fragment is a string).
   *
   *   Ordered before `storeForTable` on purpose: routing classifies these as ledger
   *   tables, and relying on that would make the fragment's availability depend on a
   *   registry decision in another module. Composing first makes it independent.
   */
  if (d.filter === undefined) {
    /**
     * ★ THE CACHE KEY CARRIES THE SCOPE, BECAUSE THE FRAGMENT IS A FUNCTION OF IT.
     *
     *   This used to be keyed by table alone, on the stated premise that "a derived
     *   fragment is a string composed from the organization row and never goes stale
     *   within a process". **That premise is false**, and it produced a defect a reader
     *   could see: the organization row is editable at runtime — that is what the
     *   Settings screen is for — so changing `start_fy` left every budget statement
     *   filtering on the OLD year for the life of the process. Measured: the row read
     *   `startFy = 2025` while `/api/funding/positions` still composed
     *   `PERIOD_YEAR >= 2026`.
     *
     *   `derivedPlan` is async (it awaits the tenant), so the key cannot be built
     *   here without awaiting it first. Instead the cache is keyed by table and
     *   **invalidated on write** (`forgetDerivedPlans`, called by the organizations
     *   route), which is the same pattern `forgetReadCap` uses for the cap registry
     *   and for the same reason: a stored setting that a screen can change has to be
     *   able to invalidate what was derived from it.
     */
    const derived = planCacheDerived.get(d.table);
    if (derived) return derived;

    const pendingDerived = derivedPlan(d.table);
    if (pendingDerived !== null) {
      planCacheDerived.set(d.table, pendingDerived);
      return pendingDerived;
    }
  } else {
    // A filtered read is composed per request and never cached — see `filter` on
    // `LedgerShapeRequest`. `derivedPlan` still returns `null` for a table that is
    // not one of the three composed views, which is the signal to fall through to
    // the ordinary probe below.
    const filtered = derivedPlan(d.table, undefined, d.filter);
    if (filtered !== null) return filtered;
  }

  try {
    if (storeForTable(d.table) !== 'ledger') return Promise.resolve(identity);
  } catch {
    // An unregistered table is routing's error to report, not this module's.
    return Promise.resolve(identity);
  }

  /**
   * ★ A PLAN IS SHARED BY EVERY CALLER OF THE TABLE, SO A REQUEST THAT NAMED NO
   *   COLUMNS MUST NOT BE THE ONE THAT SETS IT.
   *
   *   The projection inside `plan.from` is composed *from the caller's column list*,
   *   and this cache is keyed by table alone. So an empty list would not merely give
   *   that one caller a smaller answer — it would install a plan every resource route
   *   afterwards inherits. Measured: `PO_HEADERS_ALL` asked for with `[]` composed an
   *   empty projection (`SELECT\n  \n  FROM (…) src`), and the failed plan sat in the
   *   cache for the life of the process.
   *
   *   Not caching it costs one metadata probe for the next real caller, which is the
   *   same price the first caller always paid. Every caller that describes a table
   *   supplies its columns (`registeredResources()[].columns`), so this branch is
   *   reached only by a caller counting or listing an object no descriptor covers.
   */
  const shareable = d.columns.length > 0;

  const cached = shareable ? planCache.get(d.table) : undefined;
  if (cached) return cached;

  const pending = resolve(d.table, d.columns).then((plan) => {
    if (plan.ok && plan.unavailable.length > 0) {
      console.error(
        `[ledger] ${d.table}: ${plan.unavailable.length} declared column(s) have no ` +
          `readable source on this deployment and will be served as null: ` +
          `${plan.unavailable.join(', ')}`,
      );
    }
    if (!plan.ok) {
      console.error(`[ledger] ${d.table}: cannot be read on this deployment — ${plan.reason}`);
    }
    return plan;
  });

  if (shareable) planCache.set(d.table, pending);

  /**
   * ★ AND EVICT IT AGAIN IF THE REASON TURNED OUT TO BE THE CONNECTION.
   *
   *   `probeObject` already forgets a transient probe failure, but `planCache` is
   *   keyed per described table and would otherwise hold the failed resolution
   *   anyway — the second cache would undo the first one's fix. Evicting on
   *   completion keeps the two in step: a durable failure stays cached (one
   *   metadata query per table per process), a transient one is retried.
   */
  void pending.then((plan) => {
    if (!plan.ok && plan.transient) planCache.delete(d.table);
  });

  return pending;
}

/**
 * The derived-view plans, cached separately from `planCache`.
 *
 * Same reason in both cases — one resolution per table — but a different lifetime: a
 * derived fragment is composed from the organization row, while the entries in
 * `planCache` describe grants. Keeping them apart means `resetLedgerPlans()` can clear
 * the grant cache without also purging a fragment that is still correct.
 *
 * ★ IT IS NOT PERMANENT, AND THE FIRST VERSION OF THIS COMMENT CLAIMED IT WAS. It said
 *   the fragment "never goes stale within a process" — which is true of a grant and
 *   false of a tenant setting. `forgetDerivedPlans` is what the organizations write
 *   path calls, and the note at the lookup above records the measured defect that made
 *   it necessary.
 */
const planCacheDerived = new Map<string, Promise<LedgerResolution>>();

/**
 * Drop the composed-view plans, so the next read re-derives them from the tenant.
 *
 * ★ CALLED BY THE ORGANIZATIONS WRITE PATH, AND IT IS NOT OPTIONAL. Every field of the
 *   scope — the fund, the programs and `start_fy` — is baked into these fragments as a
 *   literal, so a saved organization row that does not purge this cache changes what
 *   the Settings screen displays and nothing about what the ledger reads. That is the
 *   worst shape of bug: the screen agrees with itself and the data does not.
 *
 * Cheap by construction — three tables, one string each — so it is called on every
 * successful write rather than being made clever.
 */
export function forgetDerivedPlans(): void {
  planCacheDerived.clear();
}

/** Drop the caches. Test seam only — the grants behind them do not change at runtime. */
export function resetLedgerPlans(): void {
  probeCache.clear();
  planCache.clear();
  forgetDerivedPlans();
}
