import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config/env.js';
import type { Args, Row, SqlDriver } from './driver.js';
import { segmentSql } from './dialect-scan.js';

/**
 * THE MYSQL BACKEND — the fourth implementation of the same seam.
 *
 * WHY THIS FILE EXISTS
 *   `driver.ts` fixes the surface every backend must provide: `execute({sql,args})`,
 *   `ping`, `close()`, `prepare()`, `transaction()`. libSQL, Oracle and SQL Server
 *   implement it; this does the same for MySQL. Nothing above this file changes —
 *   the routes, `sql.ts`, the statement router and the trace all speak the seam, so
 *   a new backend is one factory call in `client.ts` plus this file.
 *
 * ★★ THIS DRIVER IS MODELLED ON THE SQLITE ARM, NOT ON `sqlserver.ts` — AND THE
 *    REASON IS MEASURED. MySQL is the *near* dialect for this codebase: probed
 *    live against 8.0.46, it accepts all three constructs SQL Server had to
 *    rewrite —
 *
 *      `?` placeholders   native   (T-SQL needed `@p0, @p1…`)
 *      `LIMIT n`          native   (T-SQL needed `OFFSET/FETCH` or `TOP`)
 *      `IFNULL(x, y)`     native   (T-SQL needed `ISNULL`)
 *
 *    So the placeholder rewrite, the paging rewrite and the null-substitution
 *    rewrite are all absent here, and with them the `LIMIT`→`TOP` machinery that
 *    `sqlserver.ts` documents as having cost two rounds of debugging. What is left
 *    is the named-bind translation, one session setting, and value conversion.
 *
 * ★★ THE ONE GENUINE DIFFERENCE FROM SQLITE IS `||`, AND IT IS A SILENT-CORRUPTION
 *    BUG RATHER THAN A SYNTAX ERROR. Measured on 8.0.46 with the stock `sql_mode`:
 *
 *        SELECT 'AB' || 'CD'                      → 0        (logical OR!)
 *        SELECT '04' || '.' || '6570'             → 1        (logical OR!)
 *
 *    No error, no warning — an integer where an account key was expected. Every
 *    key built with `concatOp()` would be `1` instead of `04.6570`, and the damage
 *    would be invisible until something compared two of them. `PIPES_AS_CONCAT` in
 *    the session `sql_mode` restores the SQLite meaning:
 *
 *        SELECT 'AB' || 'CD'                      → 'ABCD'
 *        SELECT '04' || '.' || '6570'             → '04.6570'
 *
 *    That is set in `prepare()`, which is why `prepare()` here is load-bearing
 *    rather than best-effort. **A connection that skipped it would answer every
 *    account-key query wrongly and look healthy.**
 *
 * ★ `ONLY_FULL_GROUP_BY` IS ON BY DEFAULT IN MYSQL 8 and is STRICTER than SQL
 *    Server or SQLite. It rejects a select list naming a column that is neither
 *    grouped nor aggregated. The stock `sql_mode` is left otherwise intact — this
 *    driver adds `PIPES_AS_CONCAT` and removes nothing, because silently loosening
 *    a server's mode is how a query that "works locally" fails in production.
 */

/** The pool, opened lazily. `null` until the first statement or `prepare()`. */
let pool: Pool | null = null;
let poolPromise: Promise<Pool> | null = null;

/** The MySQL settings, or a throw naming what is missing. */
function mysqlSettings(): NonNullable<typeof config.db.mysql> {
  const cfg = config.db.mysql;
  if (cfg === undefined) {
    throw new Error(
      'DB_MODE=mysql but no MySQL settings were resolved. ' +
        'Set MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD.',
    );
  }
  return cfg;
}

/**
 * Open the pool, once.
 *
 * ★ `decimalNumbers: true` AND `dateStrings: true` ARE BOTH DELIBERATE.
 *
 *   `decimalNumbers` — MySQL returns `DECIMAL` as a STRING by default, to protect
 *   precision. Every money column in this app is DECIMAL, and a string arriving
 *   where a number is expected would make `sum + row.AMOUNT` a concatenation
 *   rather than an addition — the same class of silent wrongness as `||` above.
 *   The values here are well inside the safe range (measured: ≤1e9, ≤10 significant
 *   digits), so a JS number is lossless.
 *
 *   `dateStrings` — MySQL's driver converts DATE/DATETIME to a JS `Date` in the
 *   SERVER's timezone, which is the off-by-one-day bug `oracle.ts` documents at
 *   length (a stored `2001-05-03` reading back as the 4th for any time ≥ 20:00).
 *   Returning the string the server holds sidesteps the timezone entirely, and it
 *   is what the app's `isoDay`/`monthLong` helpers already expect.
 */
function getPool(): Promise<Pool> {
  if (poolPromise !== null) return poolPromise;

  const cfg = mysqlSettings();
  // ★ `createPool` IS SYNCHRONOUS — unlike `mssql`'s `.connect()`, which returns a
  //   promise. It returns a pool immediately and connects lazily, so there is no
  //   `await` here to fail. The failure therefore surfaces on the FIRST QUERY, not
  //   at pool construction, which is why `probeDb()` exists and why the readiness
  //   flag is a flag rather than a boot-time throw.
  const opening = Promise.resolve().then(() => {
    const p = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      waitForConnections: true,
      // A page can fan out several statements at once; a pool smaller than the
      // widest fan-out queues the request that most needed to run. Same reasoning
      // as the SQL Server pool's `max: 10`, and the `NJS-040` lesson before it.
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true,
      dateStrings: true,
      // ★ NAMED PLACEHOLDERS ARE NOT USED — see `namedToPositional`. `mysql2`'s own
      //   `namedPlaceholders` would collide with the `:name` translation this driver
      //   does itself, and two mechanisms for one job is how a bind goes missing.
      namedPlaceholders: false,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
    pool = p;
    return p;
  });

  poolPromise = opening;
  return opening;
}

/**
 * Convert a bind value to something `mysql2` accepts, or throw naming the position.
 *
 * Deliberately explicit about what it refuses, exactly as `toBind` in `oracle.ts`
 * and `sqlserver.ts` are. MySQL accepts number, string, Date, Buffer and null; a
 * boolean and a BigInt both need converting, and both would otherwise fail with a
 * message about the driver rather than about the caller.
 */
function toBind(value: unknown, position: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  // `bindable()` turns a boolean into 0/1 for libSQL, but a boolean can still
  // arrive from a hand-written caller. MySQL has no boolean type, so 1/0 is the
  // only correct spelling.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    // Inside the safe range a number is lossless and cheaper; outside it the digits
    // travel as text and MySQL converts them on the way into the column. The same
    // split `sqlserver.ts` makes, for the same reason (`LINE_NUM` is a BIGINT that
    // exceeds `Number.MAX_SAFE_INTEGER` on two rows).
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof Date) return value;
  throw new Error(
    `MySQL bind #${position} is a ${Array.isArray(value) ? 'array' : typeof value}, ` +
      'which cannot be sent as a bind value. Convert it to a scalar before it reaches the driver.',
  );
}

/**
 * ★★ `:name` → `?`, WITH THE VALUES REORDERED TO MATCH.
 *
 * Most of this app's SQL binds by name — `bindable()`, `likeClause()` and every
 * hand-written filter use `:key`, `:q0`, `:name`. MySQL's driver takes positional
 * `?` only (its own `namedPlaceholders` option is off, deliberately), so the named
 * form has to be translated here.
 *
 * ★ A SCANNER, NOT A REGEX. `:name` inside a string literal or a comment is not a
 *   bind, and a colon is *common* in ordinary SQL text — `WHERE note = 'see:
 *   appendix'` and `'12:30'` both contain one. Rewriting those would produce a
 *   stray `?` and shift every later value by one, which is the worst possible
 *   failure: a statement that runs and answers about the wrong rows. The scanner
 *   is the same `segmentSql` the other two drivers use, so all three agree about
 *   what counts as code.
 *
 * ★ THE NAME IS RESOLVED AT ITS POSITION, SO REPEATS ARE FINE. `:fund` used twice
 *   becomes two `?`s and the value is emitted twice — MySQL's positional binds
 *   cannot name a value once and reuse it. That is why this returns a VALUES ARRAY
 *   rather than a name list.
 *
 * ★ AN UNUSED KEY IS NOT AN ERROR. `likeClause` builds one arg per column and a
 *   caller may bind a superset across a composed statement; refusing that would
 *   break working callers to catch nothing. A *missing* key is the direction that
 *   produces a wrong answer, and that is the one refused below.
 */
export function namedToPositional(
  sqlText: string,
  args: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  let out = '';
  const missing: string[] = [];

  for (const seg of segmentSql(sqlText)) {
    if (!seg.code) {
      out += seg.text;
      continue;
    }
    // Walk the code segment, replacing `:name` where `name` is a bare identifier.
    let i = 0;
    while (i < seg.text.length) {
      const c = seg.text[i];
      if (c === ':' && /[A-Za-z_]/.test(seg.text[i + 1] ?? '')) {
        let j = i + 1;
        while (j < seg.text.length && /[A-Za-z0-9_]/.test(seg.text[j]!)) j += 1;
        const name = seg.text.slice(i + 1, j);
        if (!(name in args)) {
          missing.push(name);
        } else {
          values.push(toBind(args[name], values.length + 1));
        }
        out += '?';
        i = j;
        continue;
      }
      out += c;
      i += 1;
    }
  }

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    const supplied = Object.keys(args);
    throw new Error(
      `SQL names the bind(s) ${unique.map((n) => `":${n}"`).join(', ')} but no value was supplied for ` +
        `${unique.length === 1 ? 'it' : 'them'}. Supplied: ${supplied.length > 0 ? supplied.join(', ') : '(none)'}.`,
    );
  }

  return { sql: out, values };
}

/**
 * ★★ THE SESSION SETTING THAT MAKES `||` MEAN CONCATENATION.
 *
 * Without it MySQL reads `||` as logical OR and every account key silently becomes
 * `1` — see the file header for the measurement. This is appended to whatever
 * `sql_mode` the server already has, and nothing is removed: a driver that quietly
 * loosened `ONLY_FULL_GROUP_BY` would make a query pass here and fail in
 * production, which is worse than failing here.
 *
 * ★ IDEMPOTENT BY CONSTRUCTION. `prepare()` may run more than once (a reconnect,
 *   an explicit call), and appending the flag twice is harmless — but it is
 *   checked first anyway so the session variable stays readable in a probe.
 */
async function applySessionMode(conn: PoolConnection | Pool): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT @@session.sql_mode AS m');
  const current = String(rows[0]?.m ?? '');
  if (!/PIPES_AS_CONCAT/i.test(current)) {
    const next = current === '' ? 'PIPES_AS_CONCAT' : `${current},PIPES_AS_CONCAT`;
    await conn.query('SET SESSION sql_mode = ?', [next]);
  }
}

/**
 * Connections whose `sql_mode` has already been set, keyed by `threadId`.
 *
 * ★ A CONNECTION ID IS REUSED BY MYSQL AFTER A CONNECTION CLOSES, so this is a
 *   cache of *work already done* rather than of identity: a stale entry means one
 *   skipped `SELECT @@sql_mode` on a connection that already has the setting, and
 *   a missing one means the setting is applied again — which is idempotent. Neither
 *   direction can produce a wrong session, which is what makes the cache safe.
 */
const initialised = new Set<number>();

/** In-flight initialisations, so two statements on one connection cannot race. */
const pendingInit = new Map<number, Promise<void>>();

/**
 * ★ THE SETTING IS VERIFIED, NOT ASSUMED — AND THAT IS THE POINT OF THIS FUNCTION.
 *
 * The first version of this driver set `PIPES_AS_CONCAT` on the pool and trusted
 * that every connection would inherit it. Measured through the app's own seam, it
 * did not: `'04' || '.' || '6570'` came back as the integer `1`. A wrong account
 * key with no error is the worst failure this driver can produce, so the mode is
 * now checked on the connection that is about to run the statement.
 *
 * A connection that cannot be initialised is NOT silently used — the error
 * propagates, because running a query under the wrong `sql_mode` is worse than
 * failing to run it.
 */
async function ensureMode(conn: PoolConnection): Promise<void> {
  const id = conn.threadId ?? -1;
  if (initialised.has(id)) return;

  const running = pendingInit.get(id);
  if (running !== undefined) {
    await running;
    return;
  }

  const work = applySessionMode(conn)
    .then(() => {
      initialised.add(id);
    })
    .finally(() => {
      pendingInit.delete(id);
    });

  pendingInit.set(id, work);
  await work;
}

/**
 * ★★ THE MIRROR'S INDEXES ARE PART OF THE SCHEMA, AND TWO OF THEM ARE NOT OBVIOUS.
 *
 *    `DB_MODE=mysql` reads a MySQL copy of the Oracle tables (`oracle-sync`) that this
 *    repository does not own and cannot migrate — the ETL that fills it lives outside
 *    these sources, so no source file can enforce its indexes and nothing in the boot
 *    path can notice when one is dropped. The nearest thing to a declaration is
 *    `_perf-index.mjs` at the root of this package — it lists every index the ledger
 *    statements want and reports which are missing, and it is run by hand, not by the
 *    app. That is the whole reason this note exists: the live extract is the app's most
 *    expensive statement, its cost is decided entirely by indexes that no *schema* file
 *    mentions, and a missing one is invisible — the query still returns the right rows,
 *    it just takes a minute.
 *
 *    Measured on this tenant (23,224 rows in scope, `oracle-sync`):
 *
 *      no index                 51.0 s   plan starts `po_line_locations_all` ALL, 1,146,800 rows
 *      + idx_pll_header_line     7.0 s   plan starts `po_headers_all` ALL
 *      + idx_po_dist_ccid        6.6 s   plan starts `gl_code_combinations` range
 *
 *    and end to end through `GET /api/extract/current?refresh=1`: 48 s before, 10.5 s
 *    after. The indexes are
 *
 *      po_line_locations_all  (PO_HEADER_ID, PO_LINE_ID)
 *      po_distributions_all   (CODE_COMBINATION_ID)
 *
 *    and they exist because `buildLiveSql` joins `PO_LINE_LOCATIONS_ALL` on
 *    `(PO_HEADER_ID, PO_LINE_ID)` and reaches `PO_DISTRIBUTIONS_ALL` by
 *    `CODE_COMBINATION_ID`, while the table as replicated carried a primary key on
 *    `LINE_LOCATION_ID` alone and an index on `(PO_LINE_ID, PO_HEADER_ID)` — the same
 *    two columns in the opposite order, which the join's `ON` clause cannot use as a
 *    prefix. MySQL answered by leading the join with a full scan of the largest table
 *    in the statement and nested every other table underneath it, one row at a time.
 *
 *    ★ THE SECOND INDEX IS NOT REDUNDANT AND THE FIRST IS NOT OPTIONAL. With only the
 *      first, the plan still opens on a full scan of `PO_HEADERS_ALL`; with only the
 *      second, `pll` is scanned. Together, the optimizer finally starts from the
 *      selective side — `IX_GCC_SCOPE (SEGMENT1, SEGMENT3)`, which is the fund and the
 *      programs, and which the replicated `GL_CODE_COMBINATIONS` already had — and the
 *      rest of the join is `eq_ref` lookups on primary keys.
 *
 *    ★ VERIFY WITH `EXPLAIN`, NOT WITH A CLOCK. The good plan is the one that lists
 *      `gl_code_combinations` first with `type=range`; if `po_line_locations_all` or
 *      `po_headers_all` appears as `type=ALL`, an index is gone and the extract is
 *      back to being a minute.
 */

/**
 * The MySQL backend.
 *
 * ★ `ping` IS `SELECT 1` WITH NO `FROM`, WHICH MYSQL ACCEPTS — unlike Oracle, which
 *   needs `FROM DUAL` on a version predating 23c. The property exists on the
 *   interface for exactly this kind of difference.
 */
export function createMySqlDriver(): SqlDriver {
  return {
    dialect: 'mysql',
    ping: 'SELECT 1 AS ok',

    async execute(req) {
      const p = await getPool();
      const { sql, values } = toMysqlStatement(
        stripAppsSchema(rewriteDateFunctions(req.sql)),
        req.args,
      );

      // ★★ ONE CONNECTION, CHECKED, USED — NOT `pool.query`.
      //
      //    `pool.query` picks a connection internally, so there is no way to ensure
      //    the one it picks has had `PIPES_AS_CONCAT` applied. Borrowing a
      //    connection, initialising it, and running the statement on THAT connection
      //    is the only arrangement where the setting and the query are guaranteed to
      //    be on the same session.
      //
      //    `ensureMode` is a no-op after the first statement on a given connection,
      //    so the cost is one `SELECT @@sql_mode` per connection, not per query.
      const conn = await p.getConnection();
      try {
        await ensureMode(conn);

        // `query` rather than `execute`: `execute` uses prepared statements, which
        // MySQL caches per connection and which refuse some statements outright
        // (notably DDL). `query` handles both, and the app's SQL is already escaped
        // by the bind layer rather than by string interpolation.
        const [result, fields] = await conn.query(sql, values);

        if (Array.isArray(result)) {
          return {
            rows: result as unknown as Row[],
            rowsAffected: result.length,
            lastInsertRowid: null,
            columns: Array.isArray(fields) ? fields.map((f) => f.name) : undefined,
          };
        }

        const header = result as ResultSetHeader;
        return {
          rows: [],
          rowsAffected: header.affectedRows ?? 0,
          // `insertId` is MySQL's equivalent of `lastInsertRowid`. It is 0 when the
          // statement inserted nothing, which is *not* the same as "no id" — so it is
          // reported as null in that case rather than as a misleading 0.
          lastInsertRowid: header.insertId ? Number(header.insertId) : null,
          columns: Array.isArray(fields) ? fields.map((f) => f.name) : undefined,
        };
      } finally {
        conn.release();
      }
    },

    async transaction(): Promise<never> {
      // ★ MATCHING `oracle.ts` AND `sqlserver.ts`, AND FOR THE SAME REASON:
      //   `withTransaction` has no callers. The app store's writes are single
      //   statements, each atomic on its own, so there is no multi-statement unit
      //   that needs one. Throwing rather than returning a half-implemented handle
      //   means a future caller finds out at the call site instead of at the first
      //   `commit()`.
      throw new Error(
        'Transactions are not implemented for MySQL. Every write in this app is a ' +
          'single statement, so `withTransaction` has no callers — implement this if that changes.',
      );
    },

    async close() {
      const p = pool;
      pool = null;
      poolPromise = null;
      if (p !== null) await p.end();
    },

    async prepare() {
      // ★★ THIS IS NOT BEST-EFFORT, UNLIKE THE OTHER TWO DRIVERS' `prepare()` — IT
      //    IS THE SETTING THAT MAKES `||` CONCATENATE, AND GETTING IT WRONG IS
      //    SILENT.
      //
      //    `SET SESSION sql_mode` applies to ONE connection, and a pool hands out
      //    whichever connection is free — so setting it once, or on the pool object,
      //    leaves every other pooled connection on the server default, where
      //    `'04' || '.' || '6570'` is the integer `1`.
      //
      //    ★ MEASURED, AND IT IS WHY THIS IS WRITTEN THE WAY IT IS. The first version
      //      set the mode on the pool and listened for a `connection` event; the probe
      //      through the app's own seam then read `'04' || '.' || '6570' = 1` — WRONG —
      //      because the connection that served the query had never been initialised.
      //      A pool that is already open does not replay the event, and
      //      `applySessionMode(pool)` runs on a different connection than a later
      //      `query` would take.
      //
      //    So `execute` now borrows a connection, calls `ensureMode` on THAT
      //    connection, and runs the statement on it — the setting and the query are
      //    guaranteed to share a session. This function only opens the pool and
      //    warms one connection, so a misconfiguration surfaces at startup rather
      //    than on the first request.
      await getPool();
    },
  };
}

/**
 * Rewrite `TO_CHAR(x,'YYYY-MM-DD')` and `TO_DATE(x,'YYYY-MM-DD')` to MySQL.
 *
 * ★★ THE ROUTES ARE FULL OF ORACLE DATE FUNCTIONS, AND MYSQL HAS NEITHER.
 *    `scopeClause()` in `routes/extract.ts` emits
 *    `h.APPROVED_DATE >= TO_DATE(:since, 'YYYY-MM-DD')`, and `ap.ts` alone has 14
 *    more `TO_CHAR`/`TO_DATE` sites. MySQL has no `TO_DATE` at all and answers
 *    `FUNCTION oracle-sync.TO_DATE does not exist` (error 1305) — which names a
 *    *function*, so it reads like a missing extension rather than a dialect gap.
 *
 * ★ THIS IS THE SAME JOB `sqlserver.ts` DOES, AND IT BELONGS IN THE DRIVER FOR THE
 *   SAME REASON. `sqlserver.ts` rewrites these to `CONVERT(varchar(10), x, 23)` and
 *   `CONVERT(date, x, 23)`; MySQL's equivalents are `DATE_FORMAT(x, '%Y-%m-%d')`
 *   and `STR_TO_DATE(x, '%Y-%m-%d')`. Putting it here rather than at each call site
 *   means the routes stay dialect-free, which is the whole point of the seam.
 *
 * ★ `%Y-%m-%d` IS CHOSEN SO THE OUTPUT IS BYTE-IDENTICAL TO THE OTHER TWO ARMS.
 *   The frontend's `isoDay()` is a `slice(0, 10)`, and `ap.ts` compares these
 *   strings as dates. MySQL's `%Y` is the four-digit year and `%m`/`%d` are
 *   zero-padded, so `DATE_FORMAT` produces the same `YYYY-MM-DD` the T-SQL style
 *   code 23 and Oracle's `YYYY-MM-DD` model both produce.
 *
 * ★ A DEPTH-TRACKING SCAN, NOT A REGEX, FOR THE REASON `sqlserver.ts` RECORDS.
 *   The first T-SQL attempt used `/[^(),]+?/` for the first argument, which
 *   excludes parentheses and therefore silently missed
 *   `TO_CHAR(MIN(START_DATE),'YYYY-MM-DD')` — the form `ap.ts` actually uses. The
 *   server then reported `'TO_CHAR' is not a recognized built-in function name`
 *   and the rewrite looked like it had not run. The same trap applies here.
 *
 * ★ ONLY THE `'YYYY-MM-DD'` FORMAT IS CONVERTED, AND AN UNRECOGNISED FORMAT IS LEFT
 *   ALONE. `TO_CHAR` accepts any Oracle format model; guessing at one this function
 *   does not know would produce a plausible wrong string, whereas leaving it means
 *   MySQL names the function — a failure a reader can act on.
 *
 * ★ THE ARGUMENT IS RE-ENTERED, NOT COPIED, so a nested call is handled in one pass.
 */
function rewriteDateFunctions(text: string): string {
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

    const expr = rewriteDateFunctions(args[0]!.trim());
    const converted =
      name === 'TO_CHAR'
        ? `DATE_FORMAT(${expr}, '%Y-%m-%d')`
        : `STR_TO_DATE(${expr}, '%Y-%m-%d')`;
    out += text.slice(cursor, m.index) + converted;
    cursor = i + 1;
  }

  return out + text.slice(cursor);
}

/**
 * Turn `(sql, args)` into `(sql, values)` for `mysql2`.
 *
 * Two shapes reach here, exactly as in the other drivers:
 *
 *   - an ARRAY, meaning the SQL already uses `?` placeholders positionally;
 *   - an OBJECT, meaning the SQL uses `:name` and the values must be reordered.
 *
 * ★ THE ARITY CHECK IS WHAT MAKES THE POSITIONAL PATH SAFE, and it counts the same
 *   `?`s the server will — the ones in *code*. A flat `match(/\?/g)` over the raw
 *   text would include a `?` inside a string literal or a comment, so a statement
 *   that merely mentions one would be refused:
 *
 *       SQL has 2 positional placeholder(s) but 1 value(s) were supplied.
 *
 *   A View Builder statement carrying a comment is the normal case, not a corner —
 *   the same finding `sqlserver.ts` records.
 */
/**
 * ★★ THE `APPS.` SCHEMA PREFIX IS STRIPPED, EXACTLY AS THE SQL SERVER DRIVER STRIPS IT.
 *
 * `APPS` is the Oracle EBS schema every ledger object lives in, so the routes qualify
 * their table names with it — `ap.ts`, `extract.ts` and `vendorSites.ts` between them.
 * MySQL has no such schema, and it does not fall back to a default schema for an
 * unknown qualifier: it reads `APPS.GL_PERIODS` as *database* `apps`, table
 * `gl_periods`, and answers
 *
 *     Unknown database 'apps'   (ER_BAD_DB_ERROR, 1049)
 *
 * Measured: `/api/ap/fiscal-years` and `/api/ap/invoices` both failed that way while
 * every unqualified query in the same process worked. The copied tables live in the
 * connection's own database, which is precisely what an unqualified name resolves to —
 * so the prefix has to go, and this is the one seam that can remove it for every route
 * at once.
 *
 * Stripping is safe because the name is a constant: `APPS.` is the only schema prefix
 * any route uses, and a route that ever needed a different schema would have to name it,
 * which this does not touch. `sqlserver.ts` reached the identical conclusion for the
 * identical reason.
 */
function stripAppsSchema(sql: string): string {
  return sql.replace(/\bAPPS\./gi, '');
}

function toMysqlStatement(sql: string, args: Args | undefined): { sql: string; values: unknown[] } {
  if (Array.isArray(args)) {
    const placeholders = segmentSql(sql).reduce(
      (n, s) => n + (s.code ? (s.text.match(/\?/g) ?? []).length : 0),
      0,
    );
    if (placeholders !== args.length) {
      throw new Error(
        `SQL has ${placeholders} positional placeholder(s) but ${args.length} value(s) were supplied. ` +
          (placeholders < args.length
            ? 'A "?" inside a string literal or comment is the usual cause.'
            : 'A bind value is probably missing.'),
      );
    }
    return { sql, values: args.map((v, i) => toBind(v, i + 1)) };
  }

  if (args === undefined) {
    // No args at all: the statement must not contain a placeholder.
    const placeholders = segmentSql(sql).reduce(
      (n, s) => n + (s.code ? (s.text.match(/\?/g) ?? []).length : 0),
      0,
    );
    if (placeholders > 0) {
      throw new Error(`SQL has ${placeholders} positional placeholder(s) but no values were supplied.`);
    }
    return { sql, values: [] };
  }

  // Named binds. `?` and `:name` are alternatives, so a statement with a `?` here
  // is a caller bug worth naming rather than a rewrite worth guessing at.
  if (sql.includes('?')) {
    throw new Error(
      'SQL uses "?" placeholders but was called with named bind arguments. ' +
        'Pass an array for positional binds, or rewrite the statement to use ":name".',
    );
  }

  return namedToPositional(sql, args as Record<string, unknown>);
}
