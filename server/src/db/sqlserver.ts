import sql from 'mssql';
import { config } from '../config/env.js';
import type { Args, Row, SqlDriver } from './driver.js';
import { segmentSql } from './dialect-scan.js';

/**
 * THE SQL SERVER BACKEND — the third implementation of the same seam.
 *
 * WHY THIS FILE EXISTS
 *   `driver.ts` fixes the surface every backend must provide: `execute({sql,args})`,
 *   `ping`, `close()`, `prepare()`, `transaction()`. libSQL and Oracle implement
 *   it; this does the same for Azure SQL. Nothing above this file changes — the
 *   routes, `sql.ts`, the statement router and the trace all speak the seam, so a
 *   new backend is one factory call in `client.ts` plus this file.
 *
 * ★ WHY IT MIRRORS `oracle.ts` RATHER THAN `createLibsqlDriver`. SQL Server is
 *   the *near* dialect, not the far one: it has no `LIMIT`, no `IFNULL`, no
 *   `AUTOINCREMENT`, and — like Oracle — it takes named or positional binds
 *   rather than libSQL's positional-only `?`. So the same three-part shape
 *   applies: rewrite the placeholder style, rewrite the handful of SQLite
 *   constructs that have no T-SQL spelling, then translate each bound value at
 *   the boundary where the error can name its position.
 *
 * ★ WHAT IS *NOT* REWRITTEN. `||` for string concatenation is deliberately left
 *   alone — see `toSqlServerDialect`. It is a real difference and it is handled
 *   at the one query that uses it, because a blanket rewrite of `||` would have
 *   to reason about `OR` and about bitwise operators and would be a guess.
 */

/** The pool, opened lazily. `null` until the first statement or `prepare()`. */
let pool: sql.ConnectionPool | null = null;
let poolPromise: Promise<sql.ConnectionPool> | null = null;

/** The SQL Server settings, or a throw naming what is missing. */
function sqlServerConfig(): NonNullable<typeof config.db.sqlserver> {
  const cfg = config.db.sqlserver;
  if (cfg === undefined) {
    throw new Error(
      'DB_MODE=sqlserver but no SQL Server settings were resolved. ' +
        'Set AZURE_SQL_SERVER, AZURE_SQL_DATABASE, AZURE_SQL_USER and AZURE_SQL_PASSWORD.',
    );
  }
  return cfg;
}

/**
 * Open the pool, once.
 *
 * ★ THE TIMEOUTS ARE NOT DEFAULTS. Azure SQL **Serverless** auto-suspends when
 *   idle, and the first connection after a suspend can take minutes to wake: the
 *   TCP handshake succeeds and the TDS login is then reset. `mssql`'s default
 *   `connectTimeout` is 15 s, which is shorter than a cold wake, so the first
 *   request of the day would fail with a connection error that names nothing
 *   about the suspend. 60 s for connect and 10 minutes for a request covers the
 *   wake; `pool.max` is 10 because a page can fan out several statements at once
 *   and a pool smaller than the widest fan-out queues the request that most
 *   needed to run (this is the `NJS-040` lesson from the Oracle pool, one engine
 *   over).
 */
function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise !== null) return poolPromise;

  const cfg = sqlServerConfig();
  const opening = new sql.ConnectionPool({
    server: cfg.server,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 60_000,
      requestTimeout: 600_000,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  })
    .connect()
    .then((p: sql.ConnectionPool) => {
      pool = p;
      return p;
    })
    .catch((err: unknown) => {
      // ★ A FAILED POOL MUST NOT BE CACHED. If the promise is left in place, every
      //   later attempt awaits the same rejected promise and the process can never
      //   recover from a transient wake failure — it would need a restart, which
      //   is exactly the outcome the readiness flag exists to avoid.
      poolPromise = null;
      throw err;
    });

  poolPromise = opening;
  return opening;
}

/**
 * Rewrite `?` placeholders to T-SQL's `@p0, @p1, …`.
 *
 * A character scanner, not a regex, for the same reason as `positionalToNumbered`
 * in `oracle.ts`: `?` is only a placeholder when it sits outside a string literal,
 * a quoted identifier and a comment. `'60%?done'` inside a `LIKE` would otherwise
 * be rewritten and shift every later bind by one, matching the wrong column with
 * no error at all.
 *
 * ★ `@p0` RATHER THAN `@0`. T-SQL identifiers may not begin with a digit, so
 *   `@0` is a syntax error; the `p` prefix makes the token a legal variable name.
 *   Zero-based because that is what `mssql`'s own `request.input('p0', …)` idiom
 *   uses, and because the arity check below counts the same tokens it emits.
 */
export function positionalToNamed(sqlText: string): string {
  let n = 0;
  return segmentSql(sqlText)
    .map((s) => (s.code ? s.text.replace(/\?/g, () => `@p${n++}`) : s.text))
    .join('');
}

// Anchored to the end of a code run, because `LIMIT` is the last thing in the
// statement in every use. `([^\s;]+)` rather than `\S+` so a trailing semicolon
// is not swallowed into the bound value.
const LIMIT_OFFSET_RE = /\bLIMIT\s+([^\s;]+)\s+OFFSET\s+([^\s;]+)\s*;?\s*$/;
const LIMIT_ONLY_RE = /\bLIMIT\s+([^\s;]+)\s*;?\s*$/;
const IFNULL_RE = /\bIFNULL\s*\(/g;

/**
 * ★★ IS THERE AN `ORDER BY` AT DEPTH 0 — i.e. belonging to THIS query block?
 *
 * This is the question `FETCH` actually asks, and a whole-text `/\bORDER\s+BY\b/`
 * answers a different one. Measured, on the live instance:
 *
 *   `SELECT * FROM ( … ORDER BY x ) OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY`
 *     → **Msg 10744**, because the ordering is inside the derived table and the
 *       outer query — the one carrying the `FETCH` — has none.
 *
 * ★ AND THAT IS THE EXACT SHAPE THE READ CAP PRODUCES. `wrapForRowCap` emits
 *   `SELECT * FROM (\n<author's statement>\n) LIMIT n`, so a statement that
 *   orders internally becomes a wrapper whose *own* block is unordered. A
 *   whole-text test sees the inner `ORDER BY`, concludes the statement is
 *   ordered, and emits the form that fails — which is what
 *   `/api/coa/segments` did.
 *
 * The scan tracks bracket depth and ignores non-code runs, so an `ORDER BY`
 * inside a subquery, a string literal or a comment does not count. The same
 * `segmentSql` scanner the placeholder rewrite uses, for the same reason.
 */
function hasTopLevelOrderBy(sqlText: string): boolean {
  let depth = 0;
  for (const s of segmentSql(sqlText)) {
    if (!s.code) continue;
    for (let i = 0; i < s.text.length; i += 1) {
      const ch = s.text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === 'O' || ch === 'o')) {
        // Anchored so `ORDER` must start a word, and followed by whitespace +
        // `BY` so an identifier like `ORDER_ID` or `REORDER` cannot match.
        if (/^order\b/i.test(s.text.slice(i)) && /^\s+by\b/i.test(s.text.slice(i + 5))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * ★★ SQLITE-FLAVOURED SQL IN, T-SQL OUT — THE SAME SEAM AS `toOracleDialect`.
 *
 * The routes are written in one dialect because libSQL was the only backend they
 * ever ran against. `LIMIT n OFFSET m` *means* "page through these rows" and
 * `IFNULL(x, y)` *means* "substitute for a null" — neither is a statement about
 * which engine is underneath. So the driver is where intent becomes syntax.
 *
 * ★★ THE PAGE REWRITE HAS TWO FORMS AND THE CHOICE IS FORCED BY AN EXISTING
 *    `ORDER BY`. Both were measured against the live instance:
 *
 *      `… ORDER BY x OFFSET 5 ROWS FETCH NEXT 3 ROWS ONLY`   → **ok**
 *      `… OFFSET 5 ROWS FETCH NEXT 3 ROWS ONLY`              → **Msg 10744**
 *      `… ORDER BY x ORDER BY (SELECT NULL) OFFSET 0 …`      → **Msg 10744**
 *      `SELECT TOP (3) * FROM (… ORDER BY x) AS capped`      → **Msg 1033**
 *
 *    So `FETCH` needs an `ORDER BY` and *exactly one*; and `TOP` inside a derived
 *    table is refused unless the inner query carries `TOP`/`OFFSET`/`FOR XML` of
 *    its own. The two rewrites are therefore split on whether the statement
 *    already orders:
 *
 *      - **already ordered** → `OFFSET m ROWS FETCH NEXT n ROWS ONLY`. The
 *        ordering is the caller's and is preserved exactly.
 *      - **not ordered** → `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT n
 *        ROWS ONLY`. A constant sort key imposes no order, which is the honest
 *        spelling of "the first n rows, in whatever order the engine produces
 *        them". Adding a *real* `ORDER BY` would change results to make the
 *        syntax legal, which is the wrong trade.
 *
 *    ★ THE FIRST VERSION OF THIS APPENDED THE UNORDERED FORM UNCONDITIONALLY, and
 *      that is what produced `Invalid usage of the option NEXT in the FETCH
 *      statement` on `/api/coa/segments`: the statement already ended in
 *      `ORDER BY … LIMIT 5`, so the rewrite emitted **two** `ORDER BY` clauses.
 *      The `LIMIT_ONLY_RE` anchor at end-of-statement cannot tell the two cases
 *      apart on its own — hence `ORDER_BY_RE`.
 *
 * ★ `IFNULL` → `ISNULL`. One-for-one, same arity, same meaning.
 *
 * ★ `||` IS NOT REWRITTEN, DELIBERATELY. T-SQL has no `||` — it uses `+` — but
 *   `+` is also numeric addition and there is no way to tell the two apart
 *   without type information the driver does not have. `'a' || 'b'` and `1 + 2`
 *   are the same three tokens, so a blanket rewrite would turn a concatenation
 *   into arithmetic **silently**: `SEGMENT1 + SEGMENT2` on two numeric segment
 *   values returns their sum, and the account key is then a plausible-looking
 *   wrong number rather than an error.
 *
 *   The operator is therefore chosen at the query, by `concatExpr` in `sql.ts`,
 *   which is what the three account-key sites use. The hand-written
 *   `data/sql/first-fundings-jun-jul.sql` is a standalone document that the app
 *   never executes — nothing imports it — so its `||` is a note for a human
 *   reader rather than a statement this driver will ever see.
 */
export function toSqlServerDialect(sqlText: string): string {
  // ★★ THE DATE-FUNCTION REWRITE RUNS OVER THE WHOLE STATEMENT, NOT PER SEGMENT —
  //    AND THAT IS NOT A STYLE CHOICE, IT IS THE ONLY WAY IT CAN WORK.
  //
  //    `segmentSql` splits a statement at string literals, so
  //    `TO_CHAR(MIN(START_DATE),'YYYY-MM-DD')` arrives as THREE segments:
  //
  //        code=true   "SELECT TO_CHAR(MIN(START_DATE),"
  //        code=false  "'YYYY-MM-DD'"          ← the format is a LITERAL
  //        code=true   ") AS FY_START FROM GL_PERIODS"
  //
  //    ★ SO NO SINGLE CODE SEGMENT EVER CONTAINS THE CALL. A per-segment rewrite
  //      can only see `TO_CHAR(MIN(START_DATE),` with an unbalanced paren and no
  //      format — measured, it returned the statement unchanged while the call site
  //      was demonstrably reached, which is what made the failure look like a bad
  //      regex rather than a bad seam.
  //
  //    ★ THE SCANNER ALREADY SKIPS LITERALS ITSELF, so running it on the raw text is
  //      safe: it tracks `'…'` while walking to the matching paren, so a comma or a
  //      paren inside a string cannot mislead it. That is what makes the whole-text
  //      pass correct rather than merely convenient.
  //
  //    ★ IT RUNS FIRST, BEFORE THE SEGMENT PASS, so the `CONVERT(...)` it emits is
  //      then seen by the segment rewrite like any other code — which is harmless,
  //      since `CONVERT` contains nothing this driver rewrites.
  const withDates = rewriteDateFormatCalls(sqlText);
  // ★★ AND THE `APPS.` SCHEMA PREFIX IS STRIPPED, FOR THE SAME REASON.
  //
  //    `APPS` is the Oracle EBS schema every ledger object lives in, so the routes
  //    qualify their table names with it — 48 references across `ap.ts`,
  //    `extract.ts` and `vendorSites.ts`. SQL Server has no `APPS` schema: the copied
  //    tables are in `dbo`, and SQL Server resolves an unqualified name to the
  //    connection's default schema.
  //
  //    ★ MEASURED: with `TO_CHAR` fixed, `/api/ap/invoices` moved on to
  //      `Invalid object name 'APPS.GL_PERIODS'` — a THIRD independent blocker behind
  //      the first two, each revealed only by fixing the one before it.
  //
  //    ★ STRIPPING IS SAFE BECAUSE THE NAME IS A CONSTANT. This is not a general
  //      schema rewrite: `APPS.` is the only schema prefix any route uses, and the
  //      unqualified name resolves to `dbo` — which is where every copy created its
  //      table. A route that ever needed a different schema would have to say so
  //      explicitly, and this rewrite would not touch it.
  const withSchema = withDates.replace(/\bAPPS\./gi, '');
  return segmentSql(withSchema)
    .map((s) => (s.code ? sqlServerCode(s.text) : s.text))
    .join('');
}

function sqlServerCode(code: string): string {
  let out = code.replace(IFNULL_RE, 'ISNULL(');

  // ★★ `TO_CHAR` / `TO_DATE` ARE ORACLE-ONLY, AND THE ROUTES ARE FULL OF THEM.
  //
  //    `routes/ap.ts` was written against the live Oracle ledger and formats every
  //    date with `TO_CHAR(x,'YYYY-MM-DD')` and parses every bound date with
  //    `TO_DATE(:since,'YYYY-MM-DD')`. T-SQL has neither, so under
  //    `DB_MODE=sqlserver` the driver passed them straight through and the server
  //    answered:
  //
  //        'TO_CHAR' is not a recognized built-in function name.
  //
  //    ★ THAT IS A 500 ON EVERY AP ENDPOINT — `/api/ap/invoices` and
  //      `/api/ap/checks` — and the page renders it as "the extract could not be
  //      read", which names the wrong cause entirely: the extract is not involved.
  //      Measured: 14 `TO_CHAR`/`TO_DATE` sites in `ap.ts` alone.
  //
  //    ★ SO THE SAME SEAM THAT HANDLES `IFNULL` AND `LIMIT` HANDLES THESE. The
  //      routes keep saying `TO_CHAR(x,'YYYY-MM-DD')` — which is what they mean,
  //      and what Oracle understands — and the driver spells it for the engine
  //      underneath. Fixing 14 call sites instead would leave the next route to
  //      rediscover the problem.
  //
  //    ★ ONLY THE `'YYYY-MM-DD'` FORMAT IS REWRITTEN, AND THAT IS DELIBERATE.
  //      `TO_CHAR` takes any Oracle format model (`'MM/DD/YYYY'`, `'DD-MON-RR'`,
  //      `'YYYY'`), and a blanket rewrite would silently produce the wrong string
  //      for every one of them. Style code **23** is T-SQL's exact equivalent of
  //      `'YYYY-MM-DD'`; a format this driver does not know is LEFT ALONE so the
  //      server reports it by name rather than the driver inventing an answer.
  //
  //    ★ AND `TO_DATE` BECOMES `CONVERT(date, …)`, NOT `CONVERT(datetime, …)`.
  //      The bound value is a plain `'YYYY-MM-DD'` string and the columns it is
  //      compared against are `DATE`s; converting to `datetime` would add a
  //      midnight time and make the comparison depend on implicit conversion.
  //
  //    ★★ THE REWRITE RUNS IN `toSqlServerDialect`, NOT HERE, AND THAT IS FORCED BY
  //       HOW THE STATEMENT IS SPLIT. `segmentSql` cuts at string literals, so the
  //       format argument `'YYYY-MM-DD'` is a SEPARATE non-code segment and no code
  //       segment ever contains the whole call. See the note there.

  // ★★ THE TRAILING `LIMIT` FIRST, THEN EVERY REMAINING ONE — AND THE ORDER MATTERS.
  //
  //    A statement can carry MORE THAN ONE `LIMIT`: the paging one at the end, and
  //    `LIMIT 1` inside correlated subqueries. Measured on
  //    `/api/views/subscriptions`, whose statement has three inner `LIMIT 1`s plus
  //    a trailing `LIMIT 500`:
  //
  //      the trailing one  → `OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY`   (correct)
  //      the inner three   → **left as literal `LIMIT 1`**               (the bug)
  //
  //    ★ AND SQL SERVER REPORTS IT AS A `FETCH` ERROR, WHICH NAMES THE WRONG CLAUSE.
  //      The message was `Invalid usage of the option NEXT in the FETCH statement`
  //      — pointing at the paging I had just written correctly, while the actual
  //      fault was an unrewritten `LIMIT` in a subquery. Two days of looking at the
  //      `FETCH` would not have found it; printing the rewrite did, immediately.
  //
  //    ★ SO THE TRAILING FORM IS HANDLED FIRST, while the statement still ends with
  //      it — because that is the only position where `OFFSET/FETCH` is legal and
  //      where the "is there an ORDER BY" question applies. Everything left over is
  //      inside a subquery or a derived table, where `TOP (n)` is the correct
  //      spelling and needs no `ORDER BY` at all.
  const paged = LIMIT_OFFSET_RE.exec(out);
  if (paged) {
    // A replacement *function*, not a string: a template would let `$` in the
    // captured text be read as a group reference.
    out = out.replace(LIMIT_OFFSET_RE, () => `OFFSET ${paged[2]} ROWS FETCH NEXT ${paged[1]} ROWS ONLY`);
  } else {
    out = out.replace(LIMIT_ONLY_RE, (_match, count: string) =>
      hasTopLevelOrderBy(out)
        ? `OFFSET 0 ROWS FETCH NEXT ${count} ROWS ONLY`
        : `ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT ${count} ROWS ONLY`,
    );
  }

  // ★★ ANY `LIMIT` STILL PRESENT IS INSIDE A SUBQUERY, AND `TOP (n)` IS ITS T-SQL
  //    SPELLING — BUT `TOP` GOES AFTER `SELECT`, NOT WHERE THE `LIMIT` WAS.
  //
  //    The first version of this replaced `LIMIT 1` in place, which produced
  //
  //        SELECT r.id FROM saved_view_run r
  //         WHERE … ORDER BY r.ran_at DESC, r.id DESC TOP (1)
  //
  //    — and `TOP` is a *select-list* clause. It must follow `SELECT` directly, so
  //    that is a syntax error, and SQL Server reported it as **`Invalid usage of
  //    the option NEXT in the FETCH statement`** — naming the paging clause at the
  //    far end of the statement rather than the misplaced `TOP` in the middle of it.
  //
  //    ★ SO THE REWRITE MOVES THE TOKEN. For `SELECT … ORDER BY … LIMIT n` the
  //      `LIMIT` is deleted and `TOP (n)` is inserted after the `SELECT` of the
  //      SAME query block. The `ORDER BY` stays where it is, which is what keeps the
  //      subquery's own ordering — and therefore *which* row it picks — unchanged.
  //      `TOP` needs no `ORDER BY` of its own, so this is legal in a correlated
  //      subquery where `OFFSET/FETCH` would not be.
  //
  //    Matched per query block: the `SELECT` is found by scanning backwards from the
  //    `LIMIT` to the nearest `SELECT` that is not already followed by a `TOP`. A
  //    statement with several nested `LIMIT`s is handled because each is rewritten
  //    against its own `SELECT`.
  out = rewriteNestedLimits(out);

  return out;
}

/**
 * Rewrite `TO_CHAR(x,'YYYY-MM-DD')` and `TO_DATE(x,'YYYY-MM-DD')` to T-SQL.
 *
 * ★ A DEPTH-TRACKING SCAN RATHER THAN A REGEX, FOR A MEASURED REASON. The first
 *   attempt used `/[^(),]+?/` for the first argument, which excludes parentheses —
 *   so it rewrote `TO_CHAR(x,…)` and silently missed
 *   `TO_CHAR(MIN(START_DATE),'YYYY-MM-DD')`, the form `routes/ap.ts` actually uses.
 *   The server then reported `'TO_CHAR' is not a recognized built-in function name`
 *   and the rewrite looked like it had not run at all.
 *
 * ★ ONLY THE `'YYYY-MM-DD'` FORMAT IS CONVERTED. `TO_CHAR` accepts any Oracle format
 *   model, and style code 23 is the exact equivalent of just this one. A format this
 *   function does not recognise is LEFT ALONE — the server then names the function,
 *   which is a better failure than the driver producing a plausible wrong string.
 *
 * ★ THE ARGUMENT IS RE-ENTERED, NOT COPIED. `MIN(START_DATE)` may itself contain a
 *   call this rewrite should handle, and recursing means one pass is enough.
 */
function rewriteDateFormatCalls(text: string): string {
  const NAME_RE = /\b(TO_CHAR|TO_DATE)\s*\(/gi;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = NAME_RE.exec(text)) !== null) {
    const name = m[1]!.toUpperCase();
    const openParen = m.index + m[0].length - 1;

    // Walk to the matching close paren, tracking depth and skipping literals.
    let depth = 0;
    let i = openParen;
    let inString = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "'") inString = false;
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i >= text.length) break; // unbalanced — leave the rest untouched

    const inner = text.slice(openParen + 1, i);

    // Split the arguments at depth 0, so a nested call's commas do not split it.
    const args: string[] = [];
    let d = 0;
    let start = 0;
    let str = false;
    for (let j = 0; j < inner.length; j += 1) {
      const ch = inner[j]!;
      if (str) {
        if (ch === "'") str = false;
        continue;
      }
      if (ch === "'") str = true;
      else if (ch === '(') d += 1;
      else if (ch === ')') d -= 1;
      else if (ch === ',' && d === 0) {
        args.push(inner.slice(start, j));
        start = j + 1;
      }
    }
    args.push(inner.slice(start));

    const format = args[1]?.trim().replace(/^'|'$/g, '');
    if (args.length !== 2 || format !== 'YYYY-MM-DD') {
      // Not a shape this rewrite knows. Emit it unchanged and keep scanning past it.
      out += text.slice(cursor, i + 1);
      cursor = i + 1;
      continue;
    }

    const expr = rewriteDateFormatCalls(args[0]!.trim());
    const converted =
      name === 'TO_CHAR' ? `CONVERT(varchar(10), ${expr}, 23)` : `CONVERT(date, ${expr}, 23)`;
    out += text.slice(cursor, m.index) + converted;
    cursor = i + 1;
  }

  return out + text.slice(cursor);
}

/**
 * Convert every remaining `LIMIT n` into a `TOP (n)` on its own `SELECT`.
 *
 * ★ A `LIMIT` CANNOT SIMPLY BE REPLACED IN PLACE. `LIMIT` is the last clause of a
 *   statement; `TOP` is the first clause of the select list. Moving the token is
 *   the whole job, and doing it by position is what makes this correct for a
 *   subquery whose `ORDER BY` must survive.
 *
 * The scan runs right-to-left so that rewriting an inner `LIMIT` cannot shift the
 * offsets of an outer one that has not been handled yet.
 */
function rewriteNestedLimits(sqlText: string): string {
  const LIMIT_RE = /\bLIMIT\s+(\d+)\b/gi;

  // ★★ REWRITE ONE `LIMIT` AT A TIME, RE-SCANNING AFTER EACH — AND THAT IS THE FIX.
  //
  //    The first version collected every match up front and applied them
  //    right-to-left, rebuilding the string as
  //    `head + ' TOP (n) ' + rest.slice(afterSelect)`. That arithmetic was wrong:
  //    `rest` was taken from the *statement* offset rather than from the `SELECT`,
  //    so everything between the `SELECT` and the end was re-emitted — duplicating
  //    the clause that followed and producing
  //
  //        … SELECT TOP (1) r.id FROM saved_view_run r … WHERE … WHERE …
  //
  //    which SQL Server reported as `Incorrect syntax near the keyword 'WHERE'`.
  //
  //    ★ RE-SCANNING IS SIMPLER AND CANNOT DRIFT. Each pass handles exactly one
  //      `LIMIT` by finding its own `SELECT` and splicing two precise ranges; the
  //      next pass sees a statement with one fewer `LIMIT`. It is O(n²) in the
  //      number of `LIMIT`s, which is a handful.
  let out = sqlText;
  for (let guard = 0; guard < 50; guard += 1) {
    LIMIT_RE.lastIndex = 0;
    const m = LIMIT_RE.exec(out);
    if (m === null) break;

    const at = m.index;
    const count = m[1]!;

    // The `SELECT` that owns this `LIMIT` is the nearest one before it.
    const before = out.slice(0, at);
    const selectIdx = before.lastIndexOf('SELECT');
    if (selectIdx === -1) {
      // No `SELECT` to attach a `TOP` to. Drop the `LIMIT` rather than leave
      // invalid T-SQL; unreachable for a statement that parsed as a query.
      out = out.slice(0, at) + out.slice(at + m[0].length);
      continue;
    }

    // ★ TWO PRECISE SPLICES, IN THIS ORDER, SO NEITHER SHIFTS THE OTHER:
    //   1. delete the `LIMIT n` (a later offset, done first);
    //   2. insert `TOP (n) ` after the `SELECT` (an earlier offset).
    //   The space after `TOP (n)` is required — `SELECT TOP (1)r.id` is a syntax
    //   error, and the source has no whitespace there because the `LIMIT` it
    //   replaces sat at the far end of the statement.
    const withoutLimit = out.slice(0, at) + out.slice(at + m[0].length);
    const afterSelect = selectIdx + 'SELECT'.length;
    out = `${withoutLimit.slice(0, afterSelect)} TOP (${count}) ${withoutLimit.slice(afterSelect)}`;
  }

  return out;
}

/**
 * Convert one bound value to something the `mssql` driver accepts.
 *
 * Deliberately explicit about the conversions it *refuses*, exactly as
 * `toBind` in `oracle.ts` is. A boolean is the interesting case: `bindable()`
 * in `sql.ts` turns a boolean into `0`/`1` for libSQL, and by the time it
 * reaches here it is indistinguishable from a genuine numeric zero. EBS flag
 * columns hold `'Y'`/`'N'`, so `ENABLED_FLAG = 0` matches nothing and returns an
 * empty result that looks like "no data" rather than "wrong predicate".
 */
function toBind(value: unknown, position: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    // ★ A JS `BigInt` IS NOT A `mssql` BIND TYPE. `mssql` accepts number, string,
    //   Date, Buffer, boolean — and passing a BigInt reaches the driver's own
    //   type switch, which has no case for it and throws a message naming
    //   `object`. `LINE_NUM` is a BIGINT that exceeds `Number.MAX_SAFE_INTEGER`
    //   on exactly two rows, so the range test is real: inside it, a number is
    //   lossless and cheaper; outside it, the digits travel as text and SQL
    //   Server converts them back to BIGINT on the way into the column.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof Date) return value;
  throw new Error(
    `SQL Server bind #${position} is a ${Array.isArray(value) ? 'array' : typeof value}, ` +
      'which cannot be sent as a bind value. Convert it to a scalar before it reaches the driver.',
  );
}

/**
 * ★★ `:name` → `@name`, SO THE NAMED-BIND CALLERS WORK UNCHANGED.
 *
 * Most of this app's SQL binds by name — `bindable()`, `likeClause()` and every
 * hand-written filter use `:key`, `:q0`, `:name`. Oracle understands `:name`
 * natively, which is why its driver passes a named map straight through. T-SQL's
 * equivalent is `@name`, and the two are the same idea with a different sigil.
 *
 * ★ THE FIRST ATTEMPT REFUSED NAMED BINDS, AND THAT WAS WRONG. The reasoning was
 *   that this driver emits `@p0, @p1…` for `?` and so "has no way to match a
 *   named map" — but that conflates two separate rewrites. A statement uses
 *   *either* `?` *or* `:name`, never both, and the two paths can be handled
 *   independently. Refusing the named path took out every list endpoint:
 *   measured, `/api/vendor-sites` died with "SQL Server binds must be a
 *   positional array" on `SELECT COUNT(*) … WHERE :q0` — a message about the
 *   driver's own limitation rather than about the caller's request.
 *
 * ★ A SCANNER, NOT A REGEX, FOR THE SAME REASON AS THE `?` REWRITE. `:name`
 *   inside a string literal or a comment is not a bind — and unlike `?`, a colon
 *   is *common* in ordinary SQL text: `WHERE note = 'see: appendix'` and
 *   `'12:30'` both contain one. Rewriting those would produce `@appendix` and
 *   `@30`, which T-SQL would then reject as an undeclared variable — a failure
 *   that at least names the token, but on a statement that was perfectly fine.
 *
 * ★ THE ARITY CHECK IS WHAT MAKES IT SAFE. Every `:name` the scanner finds must
 *   have a key in `args`, or the statement is refused. A `:name` the caller
 *   forgot to supply would otherwise become an undeclared `@name` variable and
 *   fail at the server with a message that does not say which caller was wrong.
 */
export function namedToAt(sqlText: string): { sql: string; names: string[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  const sql = segmentSql(sqlText)
    .map((s) => {
      if (!s.code) return s.text;
      return s.text.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        return `@${name}`;
      });
    })
    .join('');
  return { sql, names };
}

/**
 * Normalise `args` and the statement's placeholders into one bind list.
 *
 * Returns the rewritten SQL alongside the values, because the two rewrites
 * (`?` → `@p0` and `:name` → `@name`) produce the statement the caller's binds
 * must be matched against.
 */
function toSqlServerBinds(
  rawSql: string,
  args: Args | undefined,
): { sql: string; binds: { name: string; value: unknown }[] } {
  if (args === undefined || Array.isArray(args)) {
    // ★ THE DIALECT REWRITE RUNS AFTER THE PLACEHOLDER REWRITE, AND THE ORDER
    //   MATTERS. `toSqlServerDialect` appends `ORDER BY (SELECT NULL) OFFSET 0
    //   ROWS FETCH NEXT n ROWS ONLY` for a bare `LIMIT n`, so it has to see the
    //   final statement text. It is a no-op for placeholders, so running it first
    //   would also work — but doing it here keeps every emitted statement passing
    //   through exactly one path, which is what the arity check below counts.
    const sql = toSqlServerDialect(positionalToNamed(rawSql));
    const values = args ?? [];
    // ★★ COUNT THE PLACEHOLDERS IN THE *RAW* SQL, NOT IN THE REWRITTEN ONE.
    //
    //    The first version counted `/@p\d+/g` in the rewritten statement, which is
    //    a different question and a wrong answer. `toSqlServerDialect` can emit an
    //    `@p…`-shaped token of its own — the `ORDER BY (SELECT NULL) OFFSET 0 ROWS
    //    FETCH NEXT n ROWS ONLY` form it appends for a bare `LIMIT n` contains no
    //    `@p`, but a statement whose own text mentions one would inflate the count.
    //    Counting `?` in the raw text is the arity of the *caller's* statement,
    //    which is what this check is about, and it is stable under every rewrite.
    //
    //    ★ AND THE REWRITE MUST NOT BE SKIPPED WHEN THERE ARE NO PLACEHOLDERS.
    //      `positionalToNamed` is a no-op on a statement with no `?`, so running it
    //      unconditionally is free — and skipping it when `values.length === 0`
    //      would leave the `?` in place for a statement that has one and no args,
    //      which is exactly the shape that produced
    //      `Invalid usage of the option NEXT in the FETCH statement`.
    const placeholders = (rawSql.match(/\?/g) ?? []).length;
    if (placeholders !== values.length) {
      // The arity check that makes the `?`-rewrite safe. A mismatch means a stray
      // placeholder was consumed or one was never one.
      throw new Error(
        `SQL has ${placeholders} positional placeholder(s) but ${values.length} value(s) were supplied. ` +
          (placeholders < values.length
            ? 'A "?" inside a string literal or comment is the usual cause.'
            : 'A bind value is probably missing.'),
      );
    }
    return {
      sql,
      binds: values.map((v, idx) => ({ name: `p${idx}`, value: toBind(v, idx + 1) })),
    };
  }

  // Named binds. `?` and `:name` are alternatives, so a statement with a `?` here
  // is a caller bug worth naming rather than a rewrite worth guessing at.
  if (rawSql.includes('?')) {
    throw new Error(
      'SQL uses "?" placeholders but was called with named bind arguments. ' +
        'Pass an array for positional binds, or rewrite the statement to use ":name".',
    );
  }

  const { sql: named, names } = namedToAt(rawSql);
  const sql = toSqlServerDialect(named);
  const supplied = Object.keys(args);
  const missing = names.filter((n) => !(n in args));
  if (missing.length > 0) {
    throw new Error(
      `SQL names the bind(s) ${missing.map((n) => `":${n}"`).join(', ')} but no value was supplied for ` +
        `${missing.length === 1 ? 'it' : 'them'}. Supplied: ${supplied.length > 0 ? supplied.join(', ') : '(none)'}.`,
    );
  }
  // ★ AN UNUSED KEY IS NOT AN ERROR. `likeClause` builds one arg per column and a
  //   caller may bind a superset across a composed statement; refusing that would
  //   break working callers to catch nothing. A *missing* key is the direction
  //   that produces a wrong answer, and that is the one checked above.
  return {
    sql,
    binds: names.map((n) => ({ name: n, value: toBind(args[n], names.indexOf(n) + 1) })),
  };
}

/**
 * Column names off a result's metadata, or `undefined` if it cannot be read.
 *
 * The `undefined` branch matters as much as the names: a caller that gets no
 * list infers columns from the first row, and treating an unreadable metadata
 * array as "no columns" would render a successful query as an empty one.
 */
function recordsetColumns(rs: unknown): string[] | undefined {
  if (rs === null || typeof rs !== 'object') return undefined;
  const cols = (rs as { columns?: unknown }).columns;
  if (cols === null || typeof cols !== 'object') return undefined;
  const names = Object.keys(cols as Record<string, unknown>);
  return names.length > 0 ? names : undefined;
}

/**
 * ★ T-SQL IDENTIFIER CASE IS *PRESERVED*, SO THE ORACLE PROXY IS NOT NEEDED HERE.
 *
 *   `oracle.ts` wraps every row in a Proxy because Oracle folds unquoted
 *   identifiers to upper case, so `SELECT SEGMENT1 AS fund` comes back as `FUND`
 *   and `r.fund` reads `undefined`. SQL Server does not fold: a column keeps the
 *   case it was declared or aliased with, and `mssql` returns exactly that. So
 *   `r.fund` works, `r.FUND` would not, and — because every ledger alias in this
 *   repo is lower-case and every table column is upper-case, matching how they
 *   were written — the reads resolve the way they always did against libSQL.
 *
 *   This is written down because it is the *absence* of a fix, and an absent fix
 *   looks like an oversight. It is a measurement: the alias case in the queries
 *   and the case SQL Server reports agree, so no translation is required.
 */
export function createSqlServerDriver(): SqlDriver {
  return {
    dialect: 'sqlserver',
    // T-SQL needs no FROM clause for a constant select — like SQLite, unlike Oracle.
    ping: 'SELECT 1 AS ok',

    async execute({ sql: rawSql, args }) {
      const { sql: translated, binds } = toSqlServerBinds(rawSql, args);
      const p = await getPool();

      const request = p.request();
      for (const b of binds) request.input(b.name, b.value);

      const res = await request.query(translated);
      const rs = res.recordset;

      return {
        rows: (Array.isArray(rs) ? rs : []) as unknown as Row[],
        // ★ `rowsAffected` IS AN ARRAY FOR A BATCH AND A NUMBER FOR ONE STATEMENT.
        //   `mssql` returns `number[]` from `query()` — one entry per statement in
        //   the batch. Taking the last is the count for the statement the caller
        //   wrote; summing would report a multi-statement batch's total against a
        //   single statement's result. A SELECT reports `0` here, which is what
        //   the libSQL driver reports too.
        rowsAffected: Array.isArray(res.rowsAffected)
          ? (res.rowsAffected[res.rowsAffected.length - 1] ?? 0)
          : 0,
        // ★ THE IDENTITY IS NOT KNOWN HERE, AND `null` IS THE HONEST ANSWER.
        //   libSQL reports `lastInsertRowid` for free; T-SQL needs a
        //   `SELECT SCOPE_IDENTITY()` in the same batch, which the caller would
        //   have to ask for. Returning a number invented from `@@IDENTITY` would
        //   be wrong across triggers, and no caller in this repo reads this field
        //   against a ledger table — the app store's inserts name their ids.
        lastInsertRowid: null,
        columns: recordsetColumns(rs),
      };
    },

    async transaction(): Promise<never> {
      // ★ MATCHING `oracle.ts`, AND FOR THE SAME REASON: `withTransaction` has no
      //   callers. The app store's writes are single statements, each atomic on
      //   its own, so there is no multi-statement unit that needs one. Throwing
      //   rather than returning a half-implemented handle means a future caller
      //   finds out at the call site instead of at the first `commit()`.
      throw new Error(
        'Transactions are not implemented for SQL Server. Every write in this app is a ' +
          'single statement, so `withTransaction` has no callers — implement this if that changes.',
      );
    },

    async close() {
      const p = pool;
      pool = null;
      poolPromise = null;
      if (p !== null) await p.close();
    },

    async prepare() {
      // Opening the pool here means a misconfiguration surfaces at startup rather
      // than on the first request — the same intent as `oracle.ts`.
      await getPool();
    },
  };
}

/** Exposed for `dbStatus()` — never includes the password. */
export function sqlServerPoolSize(): number {
  return pool?.size ?? 0;
}
