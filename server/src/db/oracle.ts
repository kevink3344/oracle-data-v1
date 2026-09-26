import oracledb from 'oracledb';
import type { Connection, Pool } from 'oracledb';
import { config } from '../config/env.js';
import type { Args, Binds, SqlDriver } from './driver.js';
import type { Row } from '@libsql/client';

/**
 * The Oracle (EBS) backend.
 *
 * ── THE FOUR THINGS THAT DIFFER FROM libSQL ────────────────────────────────
 *
 * 1. **Positional bind syntax.** Oracle uses `:1, :2, …`; libSQL uses `?`. The
 *    SQL in this repo is libSQL-first, so the driver rewrites `?` to `:n` —
 *    including a guard that the placeholder count matches the argument count,
 *    because the rewrite's one failure mode is a `?` that was never a
 *    placeholder (inside a string literal or a comment) and the query then
 *    silently binds the wrong column.
 *
 * 2. **`SELECT` needs a `FROM`.** `SELECT 1` is ORA-00923 on anything before
 *    23c, so `ping` carries its own `FROM DUAL`.
 *
 * 3. **Column-name case.** Oracle returns UNALIASED columns upper-cased and
 *    *quoted* aliases exactly as written. An unquoted `AS segment_num` comes
 *    back as `SEGMENT_NUM`. `execute` therefore hands back a case-insensitive
 *    view of each row — see `caseInsensitiveRow`, which also explains why the
 *    "quote the aliases instead" answer was measured and rejected.
 *
 * 4. **`lastInsertRowid` does not exist.** Oracle has no such concept; identity
 *    values are read back with `RETURNING … INTO`. The driver always reports
 *    `null` rather than inventing a number.
 *
 * 5. **Three SQLite constructs are refused outright, and `execute` translates
 *    them.** `LIMIT` and `LIMIT … OFFSET` are ORA-00933, and `IFNULL` is
 *    ORA-00904. See `toOracleDialect`, which also records the 19c measurement
 *    that makes `OFFSET … FETCH NEXT` the right replacement.
 *
 * ── WHY NLS IS PINNED PER SESSION ──────────────────────────────────────────
 * A session whose `NLS_NUMERIC_CHARACTERS` uses a comma returns the number 1234.56
 * as the *string* "1234,56", and `Number("1234,56")` is `NaN` — which
 * `toNumber()` in `sql.ts` maps to **0**. A locale setting would therefore show
 * up as a screen of plausible-looking zeros rather than an error. The same
 * reasoning applies to date formats, so both are pinned on every new session and
 * a failure to pin them is fatal for that connection: an unpinned session is not
 * a session whose numbers can be trusted.
 */

const OracleDb = oracledb;

let clientInitialised = false;
let pool: Pool | null = null;
let poolPromise: Promise<Pool> | null = null;

function oracleConfig(): NonNullable<typeof config.db.oracle> {
  const cfg = config.db.oracle;
  if (!cfg) {
    // Unreachable via `resolveDb()`, which refuses to build oracle mode without
    // these, but stated rather than asserted so the failure names the problem.
    throw new Error('Oracle mode selected but no Oracle connection settings were resolved.');
  }
  return cfg;
}

/**
 * ★★ AN EXPLICIT OVERRIDE, SO A SCRIPT CAN READ ORACLE WHILE `DB_MODE` IS NOT
 *    `oracle`.
 *
 * `copy-oracle-to-sqlserver.ts` reads Oracle and writes SQL Server, and it reads
 * Oracle through `rows()` from `db/sql.js` — which goes to whichever store
 * `DB_MODE` names. That is correct for the app and **wrong for that script**: the
 * moment `.env` said `DB_MODE=sqlserver`, the copy's *source* became SQL Server,
 * and every table it had not yet created answered
 * `Invalid object name 'PO_LINE_LOCATIONS_ALL'` — a SQL Server error, from a
 * script whose whole job is to read Oracle.
 *
 * ★ THE SYMPTOM IS WORTH RECOGNISING: a "SOURCE FAILED" whose message is a
 *   *destination* dialect. When a script's error names the engine it is supposed
 *   to be writing to, the connection it is reading through is the bug.
 *
 * The override is set for the duration of one call and cleared in a `finally`, so
 * a script can read Oracle without the process-wide `config.db` being rewritten —
 * which would leave the app's own driver pointing at the wrong store if the script
 * ran in-process.
 */
export async function oracleRowsDirect<T = Record<string, unknown>>(
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  const saved = config.db.oracle;
  if (saved === undefined) {
    // The settings come from `AZURE_SQL_*`'s Oracle counterparts, which
    // `resolveDb` only reads in oracle mode. Read them here so the script does
    // not need `DB_MODE=oracle` in `.env` to do its job.
    config.db.oracle = oracleConfigFromEnv();
  }
  try {
    const conn = await (await getPool()).getConnection();
    // ★★ A CONNECTION WHOSE STATEMENT FAILED MUST NOT GO BACK TO THE POOL.
    //
    //    Measured: run a statement that fails (ORA-00942), then run a perfectly
    //    good one on the connection the pool hands out next — the second
    //    statement KILLS THE PROCESS. No exception, no stderr, no exit code the
    //    caller can see: `say()` before the fetch runs, the fetch never returns,
    //    and nothing after it ever runs. The ordering is the whole experiment:
    //
    //        BAD → GOOD            BAD reports; GOOD dies silently
    //        GOOD → BAD → GOOD     all three report; exit 0
    //
    //    ★ THE SYMPTOM NAMES NOTHING. This is what made a 162,639-row copy
    //      "vanish": the script's own log ended at `=== AP_INVOICE_LINES_ALL ===`
    //      with neither `source:` nor `SOURCE FAILED:`, because the surrounding
    //      try/catch never got a chance to run. The SQL was correct, the row
    //      count was reachable in 50 s, and the identical statement succeeded in
    //      a fresh process — the only difference was a failed statement earlier
    //      in the same pool.
    //
    //    ★ `conn.close()` IS THE BUG, NOT THE FIX. node-oracledb's `close()`
    //      returns the session to the pool for reuse; it does not reset it. So
    //      one bad statement poisons a slot that a later, unrelated read then
    //      draws. `close({ drop: true })` discards the session instead, which is
    //      the only safe thing to do with a connection whose protocol state is
    //      unknown. (`destroy()` is not a node-oracledb 7 API — the documented
    //      form is the `drop` option on `close`, which the pool honours by
    //      dropping the session rather than releasing it back.)
    //
    //    ★ AND THE FAILURE MESSAGE IS STILL THE CALLER'S. Dropping the
    //      connection changes nothing about what the caller sees: the original
    //      error propagates exactly as before. Only the *next* statement's fate
    //      changes, and it changes from "process dies" to "works".
    let failed = false;
    try {
      const translated = toOracleDialect(positionalToNumbered(sql));
      const binds = toOracleBinds(translated, args as never);
      const res = await conn.execute(translated, binds as never);
      return ((res.rows ?? []) as unknown as Row[]).map(caseInsensitiveRow) as unknown as T[];
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      // ★ `close({ drop: true })` ON THE FAILURE PATH ONLY. A successful
      //   statement leaves a usable session, so releasing it keeps the pool
      //   warm; a failed one is dropped rather than handed to the next caller.
      await releaseConnection(conn, failed);
    }
  } finally {
    config.db.oracle = saved;
  }
}

/**
 * Release a pooled connection, DROPPING it if its last statement failed.
 *
 * ★ THE `drop` OPTION IS REAL BUT UNTYPED HERE. `oracledb` ships no `.d.ts` and
 *   there is no `@types/oracledb` in this tree, so `Connection.close` is seen
 *   with no parameters even though the implementation reads `options.drop`
 *   (`node_modules/oracledb/lib/connection.js`, `close(a1)`) and forwards it to
 *   `pool._release(impl, options)`. The cast states that once, here, instead of
 *   scattering `as never` across every call site.
 *
 * ★ WHY DROPPING MATTERS. `close()` with no options returns the session to the
 *   pool for REUSE, and a session whose statement failed is not safe to reuse:
 *   measured, the next statement on that connection kills the Node process with
 *   no exception, no stderr and no exit code (see the long note in
 *   `oracleRowsDirect`). `drop: true` discards the session instead, so a failure
 *   costs one reconnect rather than the next request's life.
 */
async function releaseConnection(conn: Connection, failed: boolean): Promise<void> {
  if (failed) {
    await (conn.close as (opts?: { drop?: boolean }) => Promise<void>)({ drop: true });
    return;
  }
  await conn.close();
}

/** The Oracle settings straight from the environment, for a non-oracle `DB_MODE`. */
function oracleConfigFromEnv(): NonNullable<typeof config.db.oracle> {
  const str = (k: string): string | undefined => {
    const v = process.env[k];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const user = str('ORACLE_USER');
  const password = str('ORACLE_PASSWORD');
  const connectString = str('ORACLE_CONNECT_STRING');
  if (user === undefined || password === undefined || connectString === undefined) {
    const missing = [
      user === undefined ? 'ORACLE_USER' : null,
      password === undefined ? 'ORACLE_PASSWORD' : null,
      connectString === undefined ? 'ORACLE_CONNECT_STRING' : null,
    ].filter((k): k is string => k !== null);
    throw new Error(
      `Reading Oracle with DB_MODE != oracle needs ${missing.join(', ')} in the environment. ` +
        'They are the same settings DB_MODE=oracle reads; only the mode differs.',
    );
  }
  // ★ THE FIELD NAMES ARE COPIED FROM `oracleConfig()` IN `config/env.ts`, and a
  //   mismatch would be silent: `pinSession` reads `schema`/`thick`/`thickLibDir`
  //   and a misspelling would leave CURRENT_SCHEMA unset, which makes every
  //   unqualified name fail with ORA-00942 — an error that names neither the
  //   schema nor the setting.
  return {
    user,
    password,
    connectString,
    schema: str('ORACLE_SCHEMA'),
    privilege: str('ORACLE_PRIVILEGE'),
    connectTimeout: Number(str('ORACLE_CONNECT_TIMEOUT') ?? 15) || 15,
    thick: str('ORACLE_THICK') === '1',
    thickLibDir: str('ORACLE_THICK_LIB_DIR'),
    tnsAdmin: str('ORACLE_TNS_ADMIN'),
    walletDir: str('ORACLE_WALLET_DIR'),
    walletPassword: str('ORACLE_WALLET_PASSWORD'),
  };
}

/**
 * Load the thick client, once.
 *
 * `initOracleClient()` throws if called twice in a process, so the flag is the
 * guard. Thin mode (the default) needs no call at all, which is why the whole
 * function is a no-op unless `ORACLE_THICK=1`.
 */
function ensureClient(): void {
  if (clientInitialised) return;
  const cfg = oracleConfig();

  // Must be set before init so the client picks up a non-default tnsnames.ora.
  if (cfg.tnsAdmin !== undefined) process.env.TNS_ADMIN = cfg.tnsAdmin;

  if (cfg.thick) {
    OracleDb.initOracleClient({
      ...(cfg.thickLibDir === undefined ? {} : { libDir: cfg.thickLibDir }),
      ...(cfg.tnsAdmin === undefined ? {} : { configDir: cfg.tnsAdmin }),
    });
  }
  clientInitialised = true;
}

/**
 * Pin the session's number and date formats.
 *
 * Kept as single statements run through `execute` rather than one `ALTER SESSION`
 * per setting, because a failure has to be identifiable. Any failure here aborts
 * the connection: see the header for why an unpinned session is worse than none.
 */
async function pinSession(conn: Connection): Promise<void> {
  const settings: string[] = [];

  // ── Schema resolution. This is not optional on EBS. ─────────────────────
  // The pool logs in as a grant-holding account (e.g. POWERAPPS), but every
  // table the routes name is reachable only through a synonym owned by the
  // application schema (APPS): `APPS.PO_HEADERS_ALL` -> `PO.PO_HEADERS_ALL#`,
  // `APPS.GL_BALANCES` -> `GL.GL_BALANCES#`. Without CURRENT_SCHEMA set, an
  // unqualified name resolves in the *login* schema and every single query
  // fails with ORA-00942, which Oracle also returns for "table absent" and for
  // "no privilege" — so the error text gives no hint that the schema is the
  // problem. Measured: with CURRENT_SCHEMA = APPS all 19 route tables resolve.
  const schema = oracleConfig().schema;
  if (schema !== undefined && schema.trim() !== '') {
    // Interpolated, not bound: DDL cannot take a bind variable. The value comes
    // from an env var rather than user input, but it is still validated as a
    // bare identifier so a typo cannot become a second statement.
    const ident = schema.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_$#]{0,29}$/.test(ident)) {
      throw new Error(
        `ORACLE_SCHEMA="${schema}" is not a valid Oracle schema identifier. ` +
          'Use letters, digits, _, $ and #, starting with a letter.',
      );
    }
    settings.push(`ALTER SESSION SET CURRENT_SCHEMA = ${ident}`);
  }

  settings.push(
    // Date-only, deliberately. A DATE column is rendered as `YYYY-MM-DD`, which
    // is (a) the same form the libSQL stores hold, so one SQL string works in
    // every mode, and (b) the form `date('now')` produces in SQLite, so text
    // comparisons between them stay correct. See the DATE note on the pool:
    // the value this replaces was a JS Date whose day was wrong ~0.3% of the
    // time, and wrong silently.
    `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD'`,
    `ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF6'`,
    `ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM'`,
    // Decimal point is a period. See the header — a decimal comma reads as 0.
    `ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`,
    // Deterministic ORDER BY that does not vary with the account's locale.
    `ALTER SESSION SET NLS_SORT = BINARY`,
  );

  for (const sql of settings) {
    await conn.execute(sql);
  }
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    ensureClient();
    const cfg = oracleConfig();

    // `outFormat` and `fetchTypeHandler` are process-wide, not per-connection,
    // so they are set once here rather than per query. Doing it in `execute`
    // would be a race the first time two requests overlap.
    OracleDb.outFormat = OracleDb.OUT_FORMAT_OBJECT;

    // ── DATE columns must be stringified by the DRIVER. ─────────────────────
    // Left alone, a DATE arrives as a JS Date and the app reads the wrong day:
    // the driver encodes the stored wall-clock time in the CLIENT's zone, so any
    // value whose time is >= 20:00 America/New_York lands on the next UTC day.
    // Measured over 3,000 rows: `toISOString().slice(0,10)` agreed with TO_CHAR
    // on 2,987 — the 13 exceptions were all evening timestamps. Nothing throws;
    // the dates are just quietly one day late, and only for some rows.
    // `fetchAsString = [oracledb.DATE]` does NOT fix this: that constant is
    // DB_TYPE_TIMESTAMP (2012), and `fetchAsString` rejects DB_TYPE_DATE (2011)
    // outright, so it is accepted and does nothing. A handler is the mechanism
    // that actually fires, and it fires at the right layer — a TO_CHAR in the
    // SQL would work too but would then be Oracle-only syntax in SQL shared
    // with Turso and local mode.
    OracleDb.fetchTypeHandler = (meta) =>
      meta.dbType === OracleDb.DB_TYPE_DATE ? { type: OracleDb.STRING } : undefined;

    // `fetchAsString` is still set for TIMESTAMP, which the handler above does
    // not touch: outside `fetchAsString` coverage a TIMESTAMP arrives as a JS
    // Date and has the same zone problem.
    OracleDb.fetchAsString = [OracleDb.DB_TYPE_TIMESTAMP];

    const created = await OracleDb.createPool({
      user: cfg.user,
      password: cfg.password,
      connectString: cfg.connectString,
      ...(cfg.privilege === undefined ? {} : { privilege: privilegeOf(cfg.privilege) }),
      // Every grant on this account is SELECT, so nothing here should ever hold
      // an open write transaction. A small pool keeps the ceiling honest.
      //
      // ★ BUT NOT SMALLER THAN THE BUSIEST PAGE'S FAN-OUT. `poolMax: 4` was set when
      //   the ceiling was reasoned about per *statement* — `GET /api/funding/budgets`
      //   was consolidated from five statements to three precisely to fit four
      //   connections (see the docblock in `routes/funding.ts`). That reasoning stops
      //   one layer too low: `/funding/budgets` is a single page that fires FIVE
      //   requests together (`Promise.all` over budgets, positions, budget-types,
      //   budget-versions, budget-assignments), so the fifth could never be granted a
      //   connection on any visit and only survived by queueing behind the others.
      //   Two of those five scan for 6-7 s, so the wait was ~7 s against a 15 s
      //   `queueTimeout` — fine until the machine is busy, a second tab is open, or a
      //   reload abandons a request that then finishes anyway. Measured symptom:
      //   `NJS-040: connection request timeout`, HTTP 500 on all five endpoints at
      //   once, and the page rendering "The budget views could not be read" — i.e. the
      //   page the pool was tuned for was the one the pool could not serve.
      //
      //   Eight leaves the five-way fan-out room for a retry or a second tab. Paired
      //   with a `queueTimeout` longer than the slowest legitimate scan: a request that
      //   does have to wait should come back slower, not fail, because a 500 here is
      //   indistinguishable to the reader from the extract being missing.
      poolMin: 0,
      poolMax: 8,
      poolIncrement: 1,
      poolTimeout: 60,
      queueTimeout: 45_000,
      connectTimeout: cfg.connectTimeout,
      ...(cfg.walletDir === undefined
        ? {}
        : {
            walletLocation: cfg.walletDir,
            ...(cfg.walletPassword === undefined ? {} : { walletPassword: cfg.walletPassword }),
          }),
      // ── CALLBACK-STYLE, NOT PROMISE-STYLE. This is load-bearing. ──────────
      // oracledb invokes this as the third argument of a `new Promise` and
      // NEVER awaits its return value (lib/pool.js:548). An `async (conn) => …`
      // therefore returns an orphaned promise, `done()` is never called, and
      // the request dies at `queueTimeout` with "NJS-040: connection request
      // timeout" — an error that names the timeout and not the cause. A no-op
      // async callback is enough to trigger it. So: stay synchronous, do the
      // async work in an IIFE, and `done()` exactly once — reporting the error,
      // or the only symptom is that NJS-040 again.
      sessionCallback: (conn: Connection, _requestedTag: string, done: (err?: Error) => void): void => {
        void (async () => {
          try {
            await pinSession(conn);
            done();
          } catch (e) {
            done(e as Error);
          }
        })();
      },
    });

    pool = created;
    return created;
  })();

  try {
    return await poolPromise;
  } catch (e) {
    // Don't cache a rejected promise: a transient connect failure must be
    // retryable, and `probeUntilReady` depends on being able to try again.
    poolPromise = null;
    throw e;
  }
}

/**
 * ★ THE SCANNER NOW LIVES IN `dialect-scan.ts`, BECAUSE A SECOND DIALECT NEEDS IT.
 *
 * Both rewrites below (`?` to `:1`, and SQLite syntax to Oracle syntax) need to
 * know where the code is, and neither may touch a string literal, a quoted
 * identifier or a comment. The SQL Server driver needs the identical answer for
 * the identical reason, so the scan was extracted rather than copied — one
 * scanner, three dialects, no second place for the escaping rules to drift.
 */
import { segmentSql } from './dialect-scan.js';

/**
 * Rewrite `?` placeholders to Oracle's `:1, :2, …`.
 *
 * A character scanner rather than a regex, because `?` is only a placeholder
 * when it is outside a string literal, a quoted identifier, or a comment — and a
 * regex cannot tell those apart. `'60%?done'` inside a `LIKE` would otherwise be
 * rewritten and shift every subsequent bind by one, matching the wrong column
 * with no error at all.
 *
 * Numbering runs across the whole statement, in order, so it is unaffected by
 * how the text is divided into segments.
 */
export function positionalToNumbered(sql: string): string {
  let n = 0;
  return segmentSql(sql)
    .map((s) => (s.code ? s.text.replace(/\?/g, () => `:${(n += 1)}`) : s.text))
    .join('');
}

// Anchored to the end of a code run, because `LIMIT` is the last thing in the
// statement in every use. `([^\s;]+)` rather than `\S+` so a trailing semicolon
// is not swallowed into the bound value.
const LIMIT_OFFSET_RE = /\bLIMIT\s+([^\s;]+)\s+OFFSET\s+([^\s;]+)\s*;?\s*$/;
const LIMIT_ONLY_RE = /\bLIMIT\s+([^\s;]+)\s*;?\s*$/;
const IFNULL_RE = /\bIFNULL\s*\(/g;

/**
 * ★★ SQLITE-FLAVOURED SQL IN, ORACLE OUT — THE SECOND HALF OF THE DIALECT SEAM.
 *
 * Switching `DB_MODE` to `oracle` proved `/api/extract/current` and revealed that
 * everything *else* reading the ledger was still written in SQLite. Measured
 * against the live instance: `ORDER BY … LIMIT 1` and `LIMIT :limit OFFSET
 * :offset` both return **ORA-00933: SQL command not properly ended**, and
 * `IFNULL` returns **ORA-00904: invalid identifier**. That is every list
 * endpoint, plus eight aggregate queries that guard a null with `IFNULL`.
 *
 * ★ WHY THIS BELONGS HERE RATHER THAN IN THE ROUTES. The same argument as
 *   `caseInsensitiveRow`: these constructs have never been a choice the routes
 *   make. `LIMIT n OFFSET m` *means* "page through these rows", and `IFNULL(x, y)`
 *   *means* "substitute for a null" — neither is a statement about which database
 *   is underneath. The routes express intent in one dialect because that was the
 *   only backend they ever ran against; the driver is the boundary where intent
 *   becomes syntax. Rewriting here also means the app store is untouched: routing
 *   already sends every app-store statement to libSQL, so a rewrite in this
 *   driver can only ever apply to a ledger statement.
 *
 * ★ `OFFSET … ROWS FETCH NEXT … ROWS ONLY` IS CHOSEN ON A MEASUREMENT, NOT ON
 *   TASTE. `wrapForRowCap` deliberately avoided 12c syntax, reasoning that
 *   `ROWNUM` "works from 11g onwards without caring which release the EBS
 *   instance sits on". Probed: this instance is **19c Enterprise
 *   (19.0.0.0.0)**, and `OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`
 *   accepts binds and returns the right rows. That matters because the 11g
 *   nested-`ROWNUM` alternative has to project an extra column (`ROWNUM AS rn`)
 *   into the row set to apply the offset — and every row here is returned to a
 *   client as JSON, so that column would appear in the payload of every list
 *   response. `FETCH` adds nothing to the select list.
 *
 *   The release number is now load-bearing in one place, so it is written down:
 *   if this deployment ever moves to an 11g instance, this is the function that
 *   breaks, and the replacement is the nested-`ROWNUM` form above.
 */
export function toOracleDialect(sql: string): string {
  // ★ The `FROM DUAL` goes in FIRST, against the source text, and the rest of
  //   the rewrite then runs over the result. That order matters: `LIMIT` is
  //   rewritten to a trailing `FETCH FIRST n ROWS ONLY`, so appending the DUAL
  //   afterwards would produce `SELECT 1 AS n FETCH FIRST 1 ROWS ONLY FROM
  //   DUAL` — which is not valid Oracle. Inserting before the rewrite yields
  //   `SELECT 1 AS n FROM DUAL FETCH FIRST 1 ROWS ONLY`, which is.
  const at = dualInsertAt(sql);
  let source = sql;
  if (at !== null) {
    const head = sql.slice(0, at);
    // The head normally already ends in whitespace when a clause follows it
    // (`… AS n ` before `ORDER BY`), so only add a separator when it does not —
    // otherwise the emitted text carries a double space. Cosmetically irrelevant
    // to Oracle, but it makes the probe's expected strings exact rather than
    // approximately right, which is the difference between an assertion and a
    // guess.
    source = `${head}${/\s$/.test(head) || head === '' ? '' : ' '}FROM DUAL ${sql.slice(at)}`.trimEnd();
  }

  return segmentSql(source)
    .map((s) => (s.code ? oracleCode(s.text) : s.text))
    .join('');
}

/**
 * Where in `sql` a `FROM DUAL` must be inserted, or `null` when none is needed.
 *
 * ★★ A `SELECT` WITH NO `FROM` IS VALID SQLITE AND INVALID ORACLE.
 *
 * The summary endpoints are written as a row of scalar subqueries:
 *
 *   SELECT (SELECT COUNT(*) FROM "PO_HEADERS_ALL") AS orders,
 *          (SELECT COUNT(*) FROM "PO_LINES_ALL")   AS lines
 *
 * There is no outer `FROM` because SQLite — like SQL Server — has no `DUAL` and
 * needs none; the statement is a one-row result by construction. Oracle requires
 * a `FROM`, so it fails at the one place there is nothing to read: **ORA-00923:
 * FROM keyword not found where expected**. The reported offset is one character
 * PAST the end of the statement, which reads like a truncated string rather than
 * a missing clause.
 *
 * ★ MEASURED, NOT INFERRED. Three endpoints failed this way against the live
 *   instance — `/api/procurement/summary`, `/api/projects/summary`,
 *   `/api/funding/summary` — each with an offset equal to its own length plus
 *   one. The codebase already knew the shape: `ping` above carries its own
 *   `FROM DUAL`. One statement remembering is a coincidence; every statement
 *   needing to remember is a seam in the wrong place.
 *
 * ★ WHY THE TEST IS A DEPTH-0 SCAN rather than a `/\bFROM\b/` on the whole text.
 *   Every one of these statements contains the word `FROM` — inside its
 *   subqueries. A whole-text test would find it, conclude the statement was
 *   fine, and leave it to fail: exactly the false negative that let this reach
 *   production. Counting only what sits outside every bracket — and outside
 *   string literals and quoted identifiers, which `segmentSql` has already
 *   separated — distinguishes "the outer query reads a table" from "a subquery
 *   does". The probe's discriminating case is a literal that merely *spells*
 *   the word: `SELECT 'from here' AS label`, which a regex gets wrong and this
 *   gets right.
 *
 * ★ THE INSERTION POINT IS BEFORE A TRAILING `ORDER BY` OR `LIMIT`, not merely
 *   at the end. `SELECT a AS n ORDER BY n` must become
 *   `SELECT a AS n FROM DUAL ORDER BY n`; putting the clause after the `ORDER BY`
 *   would be a syntax error. Only the LAST such keyword at depth 0 is used, and
 *   for a FROM-less select that keyword can only be the outer one — a subquery's
 *   `ORDER BY` sits inside brackets and is not at depth 0.
 */
function dualInsertAt(sql: string): number | null {
  const CLAUSE_RE = /^(?:ORDER\s+BY|LIMIT)\b/i;
  let offset = 0;
  let depth = 0;
  let outside = '';
  let clauseAt: number | null = null;

  for (const s of segmentSql(sql)) {
    if (!s.code) {
      outside += ' ';
      offset += s.text.length;
      continue;
    }
    for (let i = 0; i < s.text.length; i += 1) {
      const ch = s.text[i];
      if (ch === '(') {
        depth += 1;
        continue;
      }
      if (ch === ')') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth !== 0) continue;
      outside += ch;
      if (ch === ' ' || i === 0) {
        const clause = CLAUSE_RE.exec(s.text.slice(i === 0 ? 0 : i + 1));
        if (clause) clauseAt = offset + i + (i === 0 ? 0 : 1);
      }
    }
    offset += s.text.length;
  }

  if (!/\bselect\b/i.test(outside) || /\bfrom\b/i.test(outside)) return null;
  return clauseAt ?? sql.length;
}

function oracleCode(code: string): string {
  let out = code.replace(IFNULL_RE, 'NVL(');

  const paged = LIMIT_OFFSET_RE.exec(out);
  if (paged) {
    // A replacement *function*, not a string: a template would let `$` in the
    // captured text be read as a group reference.
    return out.replace(
      LIMIT_OFFSET_RE,
      () => `OFFSET ${paged[2]} ROWS FETCH NEXT ${paged[1]} ROWS ONLY`,
    );
  }

  return out.replace(LIMIT_ONLY_RE, (_match, count: string) => `FETCH FIRST ${count} ROWS ONLY`);
}

/**
 * Convert one bound value to something node-oracledb accepts.
 *
 * Deliberately explicit about the conversions it *refuses*. A boolean is the
 * interesting case: `bindable()` in `sql.ts` turns a boolean into `0`/`1` for
 * libSQL, and by the time it reaches here it is indistinguishable from a genuine
 * numeric zero. EBS flag columns hold `'Y'`/`'N'`, so `ENABLED_FLAG = 0` matches
 * nothing and returns an empty result that looks like "no data" rather than
 * "wrong predicate". That translation has to happen in the SQL, and this comment
 * is the pointer for whoever meets an empty result and cannot see why.
 */
function toBind(value: unknown, position: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    // Oracle NUMBER holds 38 digits but JS cannot. Stay lossless by sending the
    // digits as text when the value is outside the exactly-representable range.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof Date) return value;
  throw new Error(
    `Oracle bind #${position} is a ${Array.isArray(value) ? 'array' : typeof value}, ` +
      'which cannot be sent as a bind value. Convert it to a scalar before it reaches the driver.',
  );
}

/** Normalise `args` into the positional array Oracle expects, checking the arity. */
function toOracleBinds(sql: string, args: Args | undefined): unknown[] | Binds {
  if (args === undefined) return [];

  if (!Array.isArray(args)) {
    // Named binds pass through: Oracle understands `:name` natively. But the SQL
    // must then have been written with `:name`, not `?`.
    if (sql.includes('?')) {
      throw new Error(
        'SQL uses "?" placeholders but was called with named bind arguments. ' +
          'Oracle needs `:1, :2, …` for positional binds — pass an array instead.',
      );
    }
    return args as Binds;
  }

  const placeholders = (sql.match(/:\d+/g) ?? []).length;
  if (placeholders !== args.length) {
    // The arity check that makes the `?`-rewrite safe. A mismatch means a stray
    // placeholder was consumed or one was never one.
    throw new Error(
      `SQL has ${placeholders} positional placeholder(s) but ${args.length} value(s) were supplied. ` +
        (placeholders < args.length
          ? 'A "?" inside a string literal or comment is the usual cause.'
          : 'A bind value is probably missing.'),
    );
  }

  return args.map((v, idx) => toBind(v, idx + 1));
}

/**
 * Column names off a result's metadata, or `undefined` if it cannot be read.
 *
 * The `undefined` branch matters as much as the names: a caller that gets no
 * list infers columns from the first row, and treating an unreadable metadata
 * array as "no columns" would render a successful query as an empty one.
 */
function oracleColumnNames(metaData: unknown): string[] | undefined {
  if (!Array.isArray(metaData)) return undefined;
  const names = metaData
    .map((m) => (m && typeof m === 'object' && 'name' in m ? String((m as { name: unknown }).name) : null))
    .filter((n): n is string => n !== null && n.length > 0);
  return names.length === metaData.length ? names : undefined;
}

/**
 * ★★ A CASE-INSENSITIVE VIEW OVER A RESULT ROW — AND WHY THIS IS THE DRIVER'S JOB.
 *
 * The header note above says the fix for Oracle's upper-casing "belongs in the
 * SQL — quote every alias whose case the JS depends on", and that was the plan
 * until the change was measured. There are **330-odd property reads** across 22
 * files and they resolve in BOTH directions: `r.segment_name` (lowercase alias,
 * from `AS segment_name`), and `order.VENDOR_ID` (uppercase, because the column
 * itself is `VENDOR_ID` and SQLite hands it back in the case it was declared).
 * Quoting every alias would have to touch every ledger query in the repo, and a
 * single missed one is a silent `undefined` — which is exactly what happened when
 * `DB_MODE` was switched: `SELECT SEGMENT1 AS fund, COUNT(*) AS combinations` came
 * back as `FUND`/`COMBINATIONS`, and the Dashboard failed with
 * *"the database returned null for combinations"*.
 *
 * The real insight is that **this difference has never been a feature the routes
 * depend on**. SQLite treats identifiers case-insensitively, so a query's alias
 * case has never changed which property the JS finds — `r.fund`, `r.FUND` and
 * `r.FuNd` are the same read. Oracle breaks that property, not the routes. So the
 * seam restores it, in one place, instead of every caller learning a dialect rule.
 *
 * ── WHAT IS AND IS NOT CHANGED ───────────────────────────────────────────────
 * `ownKeys`, enumeration and `JSON.stringify` are left **exactly as Oracle sent
 * them**. Only a *read of a key that is not present* falls back to a
 * case-insensitive match, and only `in` follows. So:
 *   - `Object.keys(row)` — unchanged, still `['ORDER_DATE', …]`.
 *   - `JSON.stringify(row)` — unchanged; the 13 MB extract payload keeps the
 *     uppercase key set the frozen file contract is written in.
 *   - `r.segment_name` — now resolves, was `undefined`.
 *   - A row *attribute* that is absent entirely still reads `undefined`, so a
 *     genuine typo is still a bug rather than being quietly satisfied.
 */
function caseInsensitiveRow(row: Row): Row {
  const keys = Object.keys(row);
  // Lower-cased key → the real key. Built once per row so a lookup is a hash hit
  // rather than a scan; `has` is separate because two Oracle columns can differ
  // only in case (`"id"` and `"ID"` are distinct quoted identifiers).
  const byLower = new Map<string, string>();
  for (const key of keys) byLower.set(key.toLowerCase(), key);

  return new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !Object.hasOwn(target, prop)) {
        const real = byLower.get(prop.toLowerCase());
        if (real !== undefined) return Reflect.get(target, real, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && !Object.hasOwn(target, prop)) {
        return byLower.has(prop.toLowerCase());
      }
      return Reflect.has(target, prop);
    },
  });
}

/** The Oracle backend, presented through the same seam as libSQL. */
export function createOracleDriver(): SqlDriver {
  return {
    dialect: 'oracle',
    // Oracle predates the version that allows a FROM-less SELECT.
    ping: 'SELECT 1 AS ok FROM DUAL',

    async execute({ sql, args }) {
      const translated = toOracleDialect(positionalToNumbered(sql));
      const binds = toOracleBinds(translated, args);
      const conn = await (await getPool()).getConnection();
      let failed = false;
      try {
        const res = await conn.execute(translated, binds as never);
        // See `caseInsensitiveRow`: Oracle returns unquoted identifiers upper-cased,
        // and no caller should have to know that.
        const raw = (res.rows ?? []) as unknown as Row[];
        return {
          rows: raw.map(caseInsensitiveRow),
          rowsAffected: res.rowsAffected ?? 0,
          // See the header: Oracle has no last-insert rowid.
          lastInsertRowid: null,
          // Present so a zero-row result still reports its columns. Read
          // defensively: `metaData` is a driver-provided array and a change to
          // its shape must degrade to "columns unknown", not throw inside a
          // query that otherwise succeeded.
          columns: oracleColumnNames(res.metaData),
        };
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        // ★★ A FAILED STATEMENT'S CONNECTION IS DESTROYED, NOT RETURNED.
        //
        //    The note that used to sit here said "a thrown query must not leak a
        //    connection, or a burst of failures exhausts poolMax and the app
        //    stalls" — true, and it is why this is a `finally`. But `close()`
        //    returns the session to the pool for REUSE, and a session whose
        //    statement failed is not safe to reuse: measured, the next statement
        //    on that connection kills the Node process with no exception and no
        //    stderr (see the long note in `oracleRowsDirect`, and the
        //    BAD→GOOD / GOOD→BAD→GOOD ordering that isolates it).
        //
        //    So the pool-size concern and the correctness concern point the same
        //    way here: `close({ drop: true })` still does not leak — it drops the
        //    slot — but it also cannot hand a poisoned session to the next
        //    request. A burst of failures now costs a reconnect each instead of
        //    silently killing the server on the request after the failure.
        await releaseConnection(conn, failed);
      }
    },

    async transaction(): Promise<never> {
      throw new Error(
        'Transactions are not implemented for Oracle: this account holds SELECT only, ' +
          'so there is no write transaction to open. `withTransaction` has no callers.',
      );
    },

    async close() {
      const p = pool;
      pool = null;
      poolPromise = null;
      if (p) await p.close(0);
    },

    async prepare() {
      // Everything Oracle needs per session is pinned by `sessionCallback` on the
      // pool, which runs for each new connection rather than once for the client.
      // Opening the pool here means a misconfiguration surfaces at startup
      // instead of on the first request.
      await getPool();
    },
  };
}

/**
 * `ORACLE_PRIVILEGE=SYSDBA` → the driver's constant.
 *
 * Anything else is refused rather than defaulted: silently connecting as a
 * normal user when SYSDBA was asked for is a privilege *downgrade* that reads as
 * a permission error later, somewhere unrelated to the setting.
 */
function privilegeOf(name: string): number {
  const key = name.trim().toUpperCase();
  if (key === 'SYSDBA') return OracleDb.SYSDBA;
  if (key === 'SYSOPER') return OracleDb.SYSOPER;
  throw new Error(`ORACLE_PRIVILEGE="${name}" is not recognised. Use SYSDBA or SYSOPER, or leave it blank.`);
}

/**
 * Exposed for the health endpoint so the client version is visible, not guessed.
 *
 * `getClientVersion` is NOT part of the module's public surface on every
 * oracledb build — on 7.0.1 the call is simply absent (`getClientVersion is not
 * a function`), so this reports `unknown` rather than throwing into the health
 * handler. The version is a diagnostic, never a decision input.
 */
export function oracleClientVersion(): string {
  try {
    return typeof OracleDb.getClientVersion === 'function' ? OracleDb.getClientVersion() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Exposed for `dbStatus()` — never includes the password. */
export function oracleConnectedCount(): number {
  return pool?.connectionsOpen ?? 0;
}
