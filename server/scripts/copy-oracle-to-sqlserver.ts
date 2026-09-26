/**
 * Oracle → Azure SQL copy. The decided scope.
 *
 * ★ SCOPE, AS AGREED:
 *     GL_PERIODS             whole (379)                          -- done, verified
 *     GL_CODE_COMBINATIONS   fund 04 UNION the accounts the PO side references
 *     GL_BALANCES            fund 04, FY2022-2027, ALL THREE FLAGS
 *     PO_VENDORS             whole
 *     PO_HEADERS_ALL         whole — via WCSEXP_PO_HEADERS (the base table is
 *                            not readable by this account; see the note there)
 *     PO_LINES_ALL           whole
 *     PO_DISTRIBUTIONS_ALL   whole
 *
 * ★ WHY THE DIMENSION IS A UNION AND NOT JUST FUND 04. Measured: 953,990 of
 *   1,159,998 PO distributions (82%) reference accounts OUTSIDE fund 04. A
 *   fund-04-only dimension would leave those rows with no matching account, and
 *   the join would return null with no error. The union is derived from the
 *   referencing data, so no copied fact row can fail to resolve.
 *
 * ★ ALL THREE ACTUAL_FLAG VALUES, BECAUSE THE APP READS ALL THREE. Measured for
 *   FY2022 fund 04: E=87,925 (encumbrances), B=74,746 (budgets), A=65,043
 *   (actuals). A copy scoped to 'B' alone would break two screens silently.
 *
 * ★ EACH TABLE IS INDEPENDENT AND RESUMABLE. Output is appended to disk after
 *   every step, because probes in this session have been killed mid-run; a copy
 *   that dies must still say which tables completed.
 *
 * Usage:  npx tsx scripts/copy-oracle-to-sqlserver.ts
 *         npx tsx scripts/copy-oracle-to-sqlserver.ts --only TABLE
 *         npx tsx scripts/copy-oracle-to-sqlserver.ts --skip TABLE[,TABLE]
 *
 * ★ A PLAIN RUN COPIES ALL SIX TABLES, and every table is DROPped and recreated,
 *   so re-running is idempotent and always produces the schema this file declares.
 *   That is the safe default: a table copied before a schema change is present,
 *   populated and WRONG, and its row count still matches -- so nothing this script
 *   checks would catch it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ★★ THE SOURCE IS PINNED TO ORACLE, NOT TAKEN FROM `DB_MODE`.
//
//   This used to import `rows` from `../src/db/sql.js`, which goes to whichever
//   store `DB_MODE` names. That is right for the app and wrong here: the moment
//   `.env` said `DB_MODE=sqlserver`, this script's *source* became SQL Server and
//   every table it had not yet created failed with
//   `Invalid object name 'PO_LINE_LOCATIONS_ALL'` — a SQL Server error, from a
//   script whose entire job is to read Oracle.
//
//   ★ THE TELL IS THE DIALECT OF THE ERROR. When a script's failure names the
//     engine it is supposed to be *writing* to, the connection it is reading
//     through is the bug — not the table.
import { oracleRowsDirect as oracleRows } from '../src/db/oracle.js';
import { closeDb } from '../src/db/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '..', '..', '.env');
const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const OUT = path.resolve(HERE, '..', '..', 'copy-sqlserver.out.txt');
writeFileSync(OUT, '');
const say = (s) => {
  console.log(s);
  appendFileSync(OUT, s + '\n');
};

/**
 * Which tables to copy.
 *
 * ★ `--only T` COPIES JUST ONE; `--skip T[,T]` COPIES ALL BUT THOSE. Both exist
 *   because they answer different questions: `--only` is for iterating on one
 *   table while debugging it, `--skip` is for resuming a long run where some
 *   tables are already correct.
 *
 * ★★ AND `--skip` IS A TRAP WORTH NAMING, BECAUSE IT LOOKS SAFER THAN IT IS.
 *   "This table already copied" is NOT the same as "this table is correct". A
 *   table copied before a SCHEMA change is present and populated and wrong, and
 *   skipping it preserves the wrong schema silently -- the row counts still
 *   match, so every check this script performs passes.
 *
 *   That is the exact state this run was in: GL_CODE_COMBINATIONS, GL_BALANCES
 *   and PO_VENDORS had all copied and verified their counts, and all three had
 *   the pre-BIGINT id columns. So the default is to copy EVERYTHING, and
 *   `--skip` prints what it skipped and why that is a decision the caller made.
 */
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const skipIdx = process.argv.indexOf('--skip');
const SKIP = new Set(
  skipIdx >= 0 && process.argv[skipIdx + 1]
    ? process.argv[skipIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : [],
);

/** Whether a table should be copied in this run, and the reason if not. */
const shouldCopy = (name) => {
  if (ONLY) return ONLY === name;
  return !SKIP.has(name);
};

const mssql = (await import('mssql')).default;
const pool = await mssql.connect({
  server: env.AZURE_SQL_SERVER,
  database: env.AZURE_SQL_DATABASE,
  user: env.AZURE_SQL_USER,
  password: env.AZURE_SQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60_000, requestTimeout: 600_000 },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
});

const BATCH = 5_000;

/**
 * ★★ THE WINDOW SIZE FOR A KEY-RANGE FETCH, AND WHY 100,000 RATHER THAN 5,000.
 *
 * `BATCH` is the *insert* unit and stays at 5,000 — that is what the BCP path
 * handles comfortably. `WINDOW` is the *fetch* unit, and it is deliberately much
 * larger because the cost being managed is different: every window is a separate
 * round trip to Oracle, and a 1.15M-row table at 5,000 rows/window would be 231
 * round trips. At 100,000 it is 12, which keeps the per-statement overhead
 * negligible while still bounding memory to ~100k row objects (~30 MB) instead of
 * 1.15M (~350 MB).
 *
 * ★ MEASURED: the whole-table fetch took 377.9 s. Twelve windows of ~31 s each
 *   keep the same total work but make the unit of loss 31 s rather than 378 s.
 */
const WINDOW = 100_000;

/** Collected outcomes, printed as one table at the end. */
const results = [];

/**
/**
 * Coerce a value from the Oracle driver to match its declared BCP type.
 *
 * ★ NULLS PASS THROUGH UNCHANGED. A null is valid for every nullable column, and
 *   coercing it would turn "no value" into 0 or "" -- a different fact.
 *
 * ★★ `mssql.BigInt` NEEDS A REAL JS BigInt, AND THAT IS THE WHOLE TRICK.
 *   The PO id columns exceed INT range -- measured: PO_LINES_ALL failed at
 *   250,000 rows with "Value must be between -2147483648 and 2147483647".
 *   So those columns must be BIGINT, and the driver's BCP writer requires a JS
 *   **BigInt** for that type, not a number. `BigInt(v)` is the conversion, and
 *   it must happen HERE rather than at the call site so every path gets it.
 */
const coerce = (v, type) => {
  if (v === null || v === undefined) return null;
  switch (type) {
    case mssql.Int:
      return typeof v === 'number' ? Math.trunc(v) : Number.parseInt(String(v), 10);
    case mssql.BigInt:
      return typeof v === 'bigint' ? v : BigInt(String(v).split('.')[0]);
    case mssql.Float:
      return typeof v === 'number' ? v : Number.parseFloat(String(v));
    case mssql.Date:
      // The driver returns 'YYYY-MM-DD' strings for DATE columns; mssql accepts
      // a Date or an ISO string, so pass the string through unchanged.
      return v instanceof Date ? v : String(v);
    // ★★ `DateTime2` NEEDED ITS OWN CASE, AND ITS ABSENCE KILLED THE PROCESS
    //    SILENTLY — no error, no exit code, nothing written to the log.
    //
    //    Without a case, a `DATETIME2` value fell to `default`, which does
    //    `String(v)` — turning a JS `Date` into `"Mon Jan 01 1951…"`, which the
    //    bulk loader cannot bind. Measured on `FND_FLEX_VALUES`: the run reached
    //    the table, printed its header, and **died**, leaving a 62-line log ending
    //    mid-table and no node process behind.
    //
    //    ★ THE SILENCE IS THE PART WORTH REMEMBERING. A bad bind normally throws a
    //      `RequestError` the script's `catch` would report; here the failure came
    //      from the BCP writer *after* the copy loop had begun, so it escaped the
    //      per-table try and took the process with it. The tell was that the log
    //      ended without a summary — a copy that stops mid-table is a crash, not a
    //      skipped table.
    //
    //    ★ `DateTime2` IS THE TYPE THE NEWER TABLES USE, which is why this only
    //      surfaced now: the six original tables carried no date columns at all,
    //      so the missing case had never been reachable. `GL_JE_HEADERS` and
    //      `GL_BUDGET_VERSIONS` use it too.
    case mssql.DateTime2:
    case mssql.DateTime:
      return v instanceof Date ? v : new Date(String(v));
    default:
      return typeof v === 'string' ? v : String(v);
  }
};

/**
 * The columns that are NOT NULL in the DDL, per table.
 *
 * ★★ THIS IS THE FIX FOR "Invalid column type from bcp client for colid 1".
 *
 *   The error survived every change of TYPE, because the type was never the
 *   problem. The bulk column definitions declared `{ nullable: true }` for EVERY
 *   column, while the DDL declares the primary keys `NOT NULL`. BCP validates the
 *   bulk definition against the EXISTING table, so a column that is NOT NULL in
 *   the table and nullable in the bulk load is a mismatch -- and the driver
 *   reports it as "invalid column type", naming the column index rather than the
 *   nullability disagreement.
 *
 *   ★ colid 1 is always the primary key, which is why the error named column 1
 *     and never a different one: the first NOT NULL column in every table is the
 *     first column in every table.
 *
 *   The v12 docs are explicit: "IMPORTANT: Always indicate whether the column is
 *   nullable or not!" -- and indicating the WRONG nullability is worse than
 *   omitting it.
 */
const NOT_NULL = {
  GL_CODE_COMBINATIONS: ['CODE_COMBINATION_ID'],
  GL_BALANCES: [],
  PO_VENDORS: ['VENDOR_ID'],
  PO_HEADERS_ALL: ['PO_HEADER_ID'],
  PO_LINES_ALL: ['PO_LINE_ID'],
  PO_DISTRIBUTIONS_ALL: ['PO_DISTRIBUTION_ID'],
  // ★ EVERY TABLE ADDED LATER MUST APPEAR HERE, OR IT FAILS WITH `colid 1`.
  //
  //   The error names the column *index*, never the cause, so a missing entry
  //   reads as "the first column's TYPE is wrong" — which is why this map was
  //   chased through four different type changes before the real cause (a NOT NULL
  //   column declared nullable in the bulk definition) was found. Adding a table
  //   without adding it here reproduces that whole detour.
  //
  //   ★ THE LIST IS THE TABLE'S PRIMARY KEY, and for a composite key that is
  //     every column of it — `mssql`'s bulk loader validates the definition against
  //     the table, so declaring only the first half of a composite key nullable is
  //     the same mismatch.
  PO_LINE_LOCATIONS_ALL: ['LINE_LOCATION_ID'],
  PO_VENDOR_SITES_ALL: ['VENDOR_SITE_ID'],
  GL_LEDGERS: ['LEDGER_ID'],
  GL_LOOKUPS: ['LOOKUP_TYPE', 'LOOKUP_CODE'],
  GL_BUDGET_TYPES: ['BUDGET_TYPE'],
  GL_BUDGET_VERSIONS: ['BUDGET_VERSION_ID'],
  GL_BUDGET_ENTITIES: ['BUDGET_ENTITY_ID'],
  GL_BUDGET_ASSIGNMENTS: ['RANGE_ID', 'LEDGER_ID', 'CODE_COMBINATION_ID'],
  GL_JE_HEADERS: ['JE_HEADER_ID'],
  // ★ THE COMPOSITE KEY IS BOTH COLUMNS, AND IT WAS VERIFIED UNIQUE RATHER THAN
  //   ASSUMED: measured for the copied scope, 294,855 rows and 294,855 distinct
  //   `(JE_HEADER_ID, JE_LINE_NUM)` pairs. A single-column key here would let the
  //   loader write a duplicate line number over another header's line.
  GL_JE_LINES: ['JE_HEADER_ID', 'JE_LINE_NUM'],
  // ★ THE AP OBJECTS, ALL FIVE ADDED IN THE SAME CHANGE THAT CREATES THEM. A table
  //   without an entry here fails with `colid 1`, which names a column INDEX and
  //   never the cause — the detour this map's own comment records.
  WCSEXP_AP_INVOICES: ['INVOICE_ID'],
  WCSEXP_AP_CHECKS: ['CHECK_ID'],
  WCSEXP_AP_INVOICE_PAYMENTS: ['INVOICE_PAYMENT_ID'],
  AP_INVOICE_DISTRIBUTIONS_ALL: ['INVOICE_DISTRIBUTION_ID'],
  WCSEXP_PO_VENDOR_SITES: ['VENDOR_SITE_ID'],
  WCSEXP_PO_VENDORS: ['VENDOR_ID'],
  AP_INVOICE_LINES_ALL: ['INVOICE_ID', 'LINE_NUMBER'],
  FND_CURRENCIES: ['CURRENCY_CODE'],
  FND_ID_FLEX_STRUCTURES: ['ID_FLEX_NUM', 'ID_FLEX_CODE', 'ID_FLEX_STRUCTURE_CODE', 'APPLICATION_ID'],
  FND_ID_FLEX_SEGMENTS: ['ID_FLEX_NUM', 'ID_FLEX_CODE', 'SEGMENT_NUM', 'APPLICATION_COLUMN_NAME'],
  FND_FLEX_VALUES: ['FLEX_VALUE_ID'],
  FND_FLEX_VALUES_TL: ['FLEX_VALUE_ID', 'LANGUAGE'],
  PO_AGENTS: ['AGENT_ID'],
  PO_LINE_TYPES: ['LINE_TYPE_ID'],
  PO_LOOKUP_CODES: ['LOOKUP_TYPE', 'LOOKUP_CODE'],
  PA_TASKS: ['TASK_ID'],
  PA_BUDGET_VERSIONS: ['BUDGET_VERSION_ID'],
  PA_BUDGET_LINES: ['BUDGET_LINE_ID'],
  WCSEXP_PO_HEADERS: ['PO_HEADER_ID'],
};

/**
 * ★★ TABLE NAMES ARE UNQUALIFIED ON PURPOSE — DO NOT "FIX" THEM WITH `APPS.`.
 *
 *   `PO_HEADERS_ALL` failed once with `ORA-00942`, and the obvious repair was to
 *   schema-qualify it, because the repo's own extract scripts write
 *   `APPS.PO_HEADERS_ALL` and they work. **Qualifying it made it fail again, and
 *   the reason is worth keeping.**
 *
 *   The app's Oracle driver pins `ALTER SESSION SET CURRENT_SCHEMA = APPS` on
 *   every connection (see `db/oracle.ts` `pinSession`). So:
 *
 *     unqualified `PO_HEADERS_ALL`  → resolved in APPS → the APPS synonym
 *                                     → `PO.PO_HEADERS_ALL#`          ✓ works
 *     `APPS.PO_HEADERS_ALL`         → resolved as a synonym OWNED by APPS, whose
 *                                     underlying object the login has no direct
 *                                     grant on                        ✗ ORA-00942
 *
 *   ★ AND ORA-00942 IS THE WORST POSSIBLE ERROR FOR THIS, because Oracle returns
 *     the same message for "the table does not exist", "you have no privilege on
 *     it", and "the schema is wrong". The message cannot distinguish the three,
 *     so the qualification looked like a missing table rather than a wrong name.
 *
 *   ★ THE EXTRACT SCRIPTS CONNECT DIFFERENTLY, WHICH IS WHY THEY QUALIFY. They use
 *     `oracledb` directly and do not pin a current schema, so for them the
 *     qualified name is the one that resolves. Two scripts, two correct answers,
 *     because the connections differ — the name is not a property of the table.
 */

/** The bulk column options for one column of one table. */
const colOptions = (tableName, column) =>
  (NOT_NULL[tableName] ?? []).includes(column)
    ? { nullable: false, primary: true }
    : { nullable: true };

/**
 * Copy a large table in key windows, inserting each window as it arrives.
 *
 * See the long note in `copyTable` for why this exists. The short version: a
 * 1.15M-row fetch takes ~378 s and is all-or-nothing, so a dropped connection at
 * second 350 costs every row already read. Windows make the unit of loss one
 * window and bound memory to one window's worth of rows.
 *
 * ★ THE KEY RANGE IS DISCOVERED FROM THE SOURCE, NOT ASSUMED. `MIN(key)` and
 *   `MAX(key)` are read first, so the windows cover exactly the keys that exist.
 *   Assuming `1 .. MAX` would waste windows on a sparse key space and, worse,
 *   would silently miss any row below a hard-coded floor.
 *
 * ★ THE TABLE IS DROPPED AND RECREATED HERE, ONCE, BEFORE THE FIRST WINDOW —
 *   not per window. That is what makes the copy idempotent: re-running replaces
 *   the table rather than appending to it.
 */
const copyTableWindowed = async ({ name, select, createSql, types, allowEmpty, windowBy, t0 }) => {
  // ── The key range, from the source. ───────────────────────────────────────
  let lo;
  let hi;
  let total;
  try {
    const bounds = await oracleRows(
      `SELECT MIN(${windowBy}) AS LO, MAX(${windowBy}) AS HI, COUNT(*) AS N FROM (${select})`,
    );
    const b = bounds[0] ?? {};
    lo = Number(b.LO);
    hi = Number(b.HI);
    total = Number(b.N);
  } catch (e) {
    say(`   SOURCE FAILED: ${e.message.split('\n')[0]}`);
    return { name, status: 'failed', source: -1, dest: -1, ok: false };
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi) || total === 0) {
    if (allowEmpty !== true) {
      say(`   ★ ZERO ROWS — refusing to create an empty table (pass \`allowEmpty: true\` if this is real)`);
      return { name, status: 'failed', source: 0, dest: 0, ok: false };
    }
    say('   ZERO ROWS — creating the table anyway (allowEmpty: true; the source is genuinely empty)');
    await pool.request().query(`DROP TABLE IF EXISTS dbo.${name}`);
    await pool.request().query(createSql);
    say(`   created dbo.${name} (0 rows)`);
    return { name, status: 'copied', source: 0, dest: 0, ok: true };
  }

  const cols = Object.keys(types);
  const missing = cols.filter((c) => !types[c]);
  if (missing.length) {
    say(`   ★ NO TYPE DECLARED FOR: ${missing.join(', ')} — refusing to guess`);
    return { name, status: 'failed', source: total, dest: -1, ok: false };
  }

  await pool.request().query(`DROP TABLE IF EXISTS dbo.${name}`);
  await pool.request().query(createSql);
  say(`   created dbo.${name}`);
  say(
    `   key range ${windowBy} ${lo} .. ${hi}  (${total} row(s) in the source), ` +
      `in windows of ${WINDOW.toLocaleString()}`,
  );

  const tCopy = Date.now();
  let inserted = 0;
  let windows = 0;
  let failedWindow = null;

  for (let from = lo; from <= hi; from += WINDOW) {
    const to = from + WINDOW - 1;
    windows += 1;
    let slice;
    try {
      // ★ THE PREDICATE IS ON THE KEY, SO EACH WINDOW IS AN INDEX RANGE SCAN.
      //   A window that happens to hold no rows (a gap in the key space) is
      //   normal and inserts nothing — it is not an error.
      slice = await oracleRows(
        `SELECT * FROM (${select}) WHERE ${windowBy} BETWEEN ${from} AND ${to}`,
      );
    } catch (e) {
      // ★ A FETCH FAILURE IS REPORTED WITH THE WINDOW THAT FAILED, so the next
      //   run can be aimed at it. The rows already inserted stay inserted.
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      say(`   ★ FETCH FAILED in window ${from}..${to}: ${msg}`);
      failedWindow = `${from}..${to}`;
      break;
    }
    if (slice.length === 0) continue;

    try {
      const table = new mssql.Table(`dbo.${name}`);
      table.create = false;
      for (const c of cols) table.columns.add(c, types[c], colOptions(name, c));
      for (const r of slice) table.rows.add(...cols.map((c) => coerce(r[c], types[c])));
      const res = await pool.request().bulk(table);
      inserted += res.rowsAffected;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      say(`   ★ INSERT FAILED in window ${from}..${to} after ${inserted} row(s): ${msg}`);
      failedWindow = `${from}..${to}`;
      break;
    }
    if (windows % 5 === 0) {
      say(`      ...${inserted} row(s) after ${windows} window(s) (${((Date.now() - tCopy) / 1000).toFixed(0)}s)`);
    }
  }

  const copyMs = Date.now() - tCopy;
  const back = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${name}`)).recordset[0].n;
  const ok = Number(back) === total && failedWindow === null;
  say(
    `   copied: ${inserted}  read back: ${back}  source: ${total}  ` +
      `${ok ? 'MATCH' : `★ MISMATCH${failedWindow === null ? '' : ` (stopped at window ${failedWindow})`}`}  ` +
      `(${copyMs} ms, ${Math.round((inserted / copyMs) * 1000)} rows/sec)`,
  );
  if (!ok) {
    // ★ A PARTIAL COPY MUST NOT READ AS A SUCCESS. The table holds only the
    //   windows that landed, so the status says `failed` and the summary and
    //   exit code carry it — the same discipline the un-windowed path uses.
    return { name, status: 'failed', source: total, dest: Number(back), ok: false };
  }
  return { name, status: 'copied', source: total, dest: Number(back), ok: true };
};

/**
 * Copy one table.
 *
 * ★ THE COMPARISON IS THE POINT. A row count on the destination only proves
 *   INSERTs were attempted. This reads the count back and compares it to the
 *   source, and reports a mismatch rather than declaring success.
 *
 * ★★ TYPES COME FROM `types`, NOT FROM THE FIRST ROW. Inferring a BCP column type
 *   from `source[0]` fails in two ways that both surface as the same unhelpful
 *   error: a null in the first row infers `NVarChar` for a numeric column, and an
 *   integer infers `BigInt` which the driver's BCP path rejects for a JS number.
 *   The caller states the type per column; the inference is gone.
 */
const copyTable = async ({ name, select, createSql, orderBy, types, allowEmpty, windowBy }) => {
  if (!shouldCopy(name)) {
    say(`\n=== ${name} ===\n   SKIPPED (--skip) — its existing table is left exactly as it is`);
    return { name, status: 'skipped', source: -1, dest: -1, ok: true };
  }
  say(`\n=== ${name} ===`);
  const t0 = Date.now();

  // ── ★★ WINDOWED FETCH: THE WHOLE TABLE IS NEVER HELD IN MEMORY. ───────────
  //
  //    Measured on `PO_LINE_LOCATIONS_ALL`: 1,151,983 rows × 9 columns fetched
  //    in ONE statement takes **377.9 s** and holds every row at once. Two
  //    separate runs died part-way through that window — one with the log
  //    truncated at `...125000` (the process gone, no exception), one with
  //    `NJS-003: invalid or closed connection` at the *source* stage. Both cost
  //    the whole table, because the fetch is all-or-nothing: a drop at second
  //    350 of 378 throws away every row already read.
  //
  //    ★ THE FIX IS TO MAKE THE UNIT OF LOSS A WINDOW, NOT A TABLE. The caller
  //      names a monotonically increasing key (`windowBy`), and the table is
  //      read and inserted in `WINDOW`-sized key ranges. A drop then costs one
  //      window (~30 s) instead of six minutes, and the rows already landed stay
  //      landed — the insert is committed per window.
  //
  //    ★ AND IT BOUNDS MEMORY. The un-windowed fetch held ~1.15M row objects;
  //      this holds at most `WINDOW` of them. That is the difference between
  //      "the process needs 1.5 GB" and "the process needs 60 MB", which is the
  //      kind of thing that decides whether a copy survives on a small machine.
  //
  //    ★ THE ROW SET IS IDENTICAL, NOT A SUBSET. The windows are keyed on the
  //      table's own primary key and their union is the whole key range, so
  //      `SUM(window rows) == COUNT(*)`. The count is read back at the end and
  //      compared to the same source count the un-windowed path would have used.
  if (windowBy !== undefined) {
    return copyTableWindowed({ name, select, createSql, types, allowEmpty, windowBy, t0 });
  }

  let source;
  try {
    source = await oracleRows(`${select}${orderBy ? ` ORDER BY ${orderBy}` : ''}`);
  } catch (e) {
    say(`   SOURCE FAILED: ${e.message.split('\n')[0]}`);
    return { name, status: 'failed', source: -1, dest: -1, ok: false };
  }
  say(`   source: ${source.length} row(s) (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (source.length === 0) {
    // ★★ THE GUARD IS KEPT, AND THE EXCEPTION IS DECLARED PER TABLE.
    //
    //    An empty source is *usually* a broken query — a wrong column list, a
    //    missing `WHERE` clause, a table that is not the one intended — so
    //    refusing to create the table is the right default and has caught real
    //    mistakes in this migration.
    //
    //    ★ BUT A GENUINELY EMPTY TABLE STILL HAS TO EXIST. `PA_TASKS`,
    //      `PA_BUDGET_VERSIONS` and `PA_BUDGET_LINES` hold **0 rows** in Oracle
    //      (measured), and the app names them — so a missing table is a 500 while
    //      an empty one is an empty answer. Those are different facts to a reader,
    //      which is exactly the argument `PA_PROJECTS_ALL` already records.
    //
    //    ★ SO THE CALLER OPTS IN, BY NAME. `allowEmpty: true` on the descriptor is
    //      a statement that someone checked and the emptiness is real. Weakening
    //      the guard to a warning would make every future typo silent; this keeps
    //      the default strict and makes the exception auditable.
    if (allowEmpty !== true) {
      say('   ★ ZERO ROWS — refusing to create an empty table (pass `allowEmpty: true` if this is real)');
      return { name, status: 'failed', source: 0, dest: 0, ok: false };
    }
    say('   ZERO ROWS — creating the table anyway (allowEmpty: true; the source is genuinely empty)');
  }

  // ★ AN EMPTY SOURCE HAS NO FIRST ROW TO READ THE COLUMN LIST FROM, so the
  //   declared `types` keys are used instead. That is the same list the bulk
  //   loader is built from, so the two cannot disagree — and it is the only
  //   source of column names available when there are no rows.
  const cols = source.length > 0 ? Object.keys(source[0]) : Object.keys(types);
  say(`   columns: ${cols.join(', ')}`);

  // ★ EVERY COLUMN MUST HAVE A DECLARED TYPE. A missing entry is a bug in the
  //   caller, not something to paper over with a guess.
  const missing = cols.filter((c) => !types[c]);
  if (missing.length) {
    say(`   ★ NO TYPE DECLARED FOR: ${missing.join(', ')} — refusing to guess`);
    return { name, status: 'failed', source: source.length, dest: -1, ok: false };
  }

  await pool.request().query(`DROP TABLE IF EXISTS dbo.${name}`);
  await pool.request().query(createSql);
  say(`   created dbo.${name}`);

  const tCopy = Date.now();
  let inserted = 0;
  // ★★ THE BATCH LOOP NEEDS ITS OWN try/catch, AND THIS IS WHY.
  //
  //    The fetch above is guarded and reports `SOURCE FAILED: …`. The INSERT was
  //    not, and an unguarded throw here does not surface as a failed table — it
  //    ends the process. Measured on this very table: the log reached
  //    `created dbo.AP_INVOICE_LINES_ALL` and then stopped, with no summary, no
  //    exit line and no error text, because the rejection escaped the top-level
  //    await and took node with it.
  //
  //    ★ THE SAME SHAPE IS ALREADY RECORDED IN `coerce` for the missing
  //      `DateTime2` case: "a bad bind ... escaped the per-table try and took the
  //      process with it." That note was about the bind VALUE; this is about the
  //      bind call itself. Both are cured by the same thing — the loop reports
  //      which batch failed and how many rows had landed, so a partial copy is a
  //      stated fact rather than a truncated log.
  //
  //    ★ AND A PARTIAL COPY MUST NOT READ AS A SUCCESS. The table is dropped and
  //      recreated before this loop, so a failure leaves it holding only the
  //      batches that landed. Returning `status: 'failed'` with the count makes
  //      that visible in the summary and in the exit code.
  try {
    for (let i = 0; i < source.length; i += BATCH) {
      const slice = source.slice(i, i + BATCH);
      const table = new mssql.Table(`dbo.${name}`);
      table.create = false;
      for (const c of cols) table.columns.add(c, types[c], colOptions(name, c));
      for (const r of slice) table.rows.add(...cols.map((c) => coerce(r[c], types[c])));
      const res = await pool.request().bulk(table);
      inserted += res.rowsAffected;
      if (inserted % 25_000 === 0) say(`      ...${inserted}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    say(`   ★ INSERT FAILED after ${inserted} of ${source.length} row(s): ${msg}`);
    return { name, status: 'failed', source: source.length, dest: inserted, ok: false };
  }
  const copyMs = Date.now() - tCopy;

  const back = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${name}`)).recordset[0].n;
  const ok = Number(back) === source.length;
  say(
    `   copied: ${inserted}  read back: ${back}  source: ${source.length}  ` +
      `${ok ? 'MATCH' : '★ MISMATCH'}  (${copyMs} ms, ${Math.round((inserted / copyMs) * 1000)} rows/sec)`,
  );
  return { name, status: 'copied', source: source.length, dest: Number(back), ok };
};

// ---------------------------------------------------------------------------
// The dimension predicate, in one place so both the copy and the proof use it.
//
// ★★ THE OBVIOUS FORM IS UNUSABLE HERE, AND THE REASON IS A MEASUREMENT.
//   `SEGMENT1 = '04' OR CODE_COMBINATION_ID IN (SELECT ... FROM
//   PO_DISTRIBUTIONS_ALL)` reads correctly and was killed four times: the OR
//   forces a full scan of the 1.3M-row table rather than using the primary key
//   index on either side of the disjunction.
//
//   ★ SO THE TWO HALVES ARE FETCHED SEPARATELY AND UNIONED IN THE CLIENT. Each
//   half uses an index -- `SEGMENT1 = '04'` on the segment, and the IN-list on
//   the primary key -- and the union is a Set operation over ~40k ids, which is
//   nothing. The scope is IDENTICAL; only the plan changes.
// ---------------------------------------------------------------------------
const DIMENSION_COLUMNS = `CODE_COMBINATION_ID, CHART_OF_ACCOUNTS_ID, ACCOUNT_TYPE,
  ENABLED_FLAG, SUMMARY_FLAG, SEGMENT1, SEGMENT2, SEGMENT3, SEGMENT4, SEGMENT5,
  SEGMENT6, SEGMENT7, DESCRIPTION`;

const fetchDimension = async () => {
  say('\n=== GL_CODE_COMBINATIONS (option B: fund 04 ∪ PO-referenced accounts) ===');

  // Half 1 — fund 04. Indexed on SEGMENT1.
  const t1 = Date.now();
  const fund04 = await oracleRows(
    `SELECT ${DIMENSION_COLUMNS} FROM GL_CODE_COMBINATIONS WHERE SEGMENT1 = '04'`,
  );
  say(`   half 1 — fund 04: ${fund04.length} row(s) (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Half 2 — every account the PO side references, fetched BY ID from the
  // distinct list. This is what avoids the full scan.
  const t2 = Date.now();
  const ids = await oracleRows(
    `SELECT DISTINCT CODE_COMBINATION_ID AS ccid FROM PO_DISTRIBUTIONS_ALL`,
  );
  say(`   the PO side references ${ids.length} distinct account(s) (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  const have = new Set(fund04.map((r) => Number(r.CODE_COMBINATION_ID)));
  const need = ids.map((r) => Number(r.ccid)).filter((id) => !have.has(id));
  say(`   of those, ${need.length} are OUTSIDE fund 04 and must be added`);

  // Fetch the missing ones in chunks, so no single IN-list is enormous.
  const extra = [];
  const CHUNK = 500;
  const t3 = Date.now();
  for (let i = 0; i < need.length; i += CHUNK) {
    const slice = need.slice(i, i + CHUNK);
    const part = await oracleRows(
      `SELECT ${DIMENSION_COLUMNS} FROM GL_CODE_COMBINATIONS
        WHERE CODE_COMBINATION_ID IN (${slice.join(',')})`,
    );
    extra.push(...part);
  }
  say(`   half 2 — fetched ${extra.length} additional account(s) (${((Date.now() - t3) / 1000).toFixed(1)}s)`);

  const all = [...fund04, ...extra];
  say(`   ★ OPTION B TOTAL: ${all.length} row(s)  (whole table is 1,300,594)`);
  return all;
};

const dimensionRows = shouldCopy('GL_CODE_COMBINATIONS') ? await fetchDimension() : null;

if (dimensionRows) {
  const t0 = Date.now();
  await pool.request().query(`DROP TABLE IF EXISTS dbo.GL_CODE_COMBINATIONS`);
  await pool.request().query(`CREATE TABLE dbo.GL_CODE_COMBINATIONS (
      CODE_COMBINATION_ID BIGINT NOT NULL PRIMARY KEY,
      CHART_OF_ACCOUNTS_ID BIGINT NULL, ACCOUNT_TYPE NVARCHAR(10) NULL,
      ENABLED_FLAG NVARCHAR(2) NULL, SUMMARY_FLAG NVARCHAR(2) NULL,
      SEGMENT1 NVARCHAR(10) NULL, SEGMENT2 NVARCHAR(10) NULL, SEGMENT3 NVARCHAR(10) NULL,
      SEGMENT4 NVARCHAR(10) NULL, SEGMENT5 NVARCHAR(10) NULL, SEGMENT6 NVARCHAR(10) NULL,
      SEGMENT7 NVARCHAR(10) NULL, DESCRIPTION NVARCHAR(400) NULL)`);
  say(`   created dbo.GL_CODE_COMBINATIONS`);

  const cols = Object.keys(dimensionRows[0]);
  // ★ EXPLICIT TYPES — see coerce()'s note on why BIGINT needs a JS BigInt.
  const dimTypes = {
    // ★ BigInt, not Int. The option-B set includes accounts the PO side
    //   references, and the PO id columns are measured to exceed INT range -- so
    //   the same ids appearing here can too. See coerce()'s note.
    CODE_COMBINATION_ID: mssql.BigInt,
    CHART_OF_ACCOUNTS_ID: mssql.BigInt,
    ACCOUNT_TYPE: mssql.NVarChar(10),
    ENABLED_FLAG: mssql.NVarChar(2),
    SUMMARY_FLAG: mssql.NVarChar(2),
    SEGMENT1: mssql.NVarChar(10),
    SEGMENT2: mssql.NVarChar(10),
    SEGMENT3: mssql.NVarChar(10),
    SEGMENT4: mssql.NVarChar(10),
    SEGMENT5: mssql.NVarChar(10),
    SEGMENT6: mssql.NVarChar(10),
    SEGMENT7: mssql.NVarChar(10),
    DESCRIPTION: mssql.NVarChar(400),
  };
  const missingDim = cols.filter((c) => !dimTypes[c]);
  if (missingDim.length) {
    say(`   ★ NO TYPE DECLARED FOR: ${missingDim.join(', ')} — refusing to guess`);
  }

  const tCopy = Date.now();
  let inserted = 0;
  for (let i = 0; i < dimensionRows.length; i += BATCH) {
    const slice = dimensionRows.slice(i, i + BATCH);
    const table = new mssql.Table('dbo.GL_CODE_COMBINATIONS');
    table.create = false;
    for (const c of cols) table.columns.add(c, dimTypes[c], colOptions('GL_CODE_COMBINATIONS', c));
    for (const r of slice) table.rows.add(...cols.map((c) => coerce(r[c], dimTypes[c])));
    const res = await pool.request().bulk(table);
    inserted += res.rowsAffected;
  }
  const back = (await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.GL_CODE_COMBINATIONS`)).recordset[0].n;
  const ok = Number(back) === dimensionRows.length;
  say(
    `   copied: ${inserted}  read back: ${back}  source: ${dimensionRows.length}  ` +
      `${ok ? 'MATCH' : '★ MISMATCH'}  (${Date.now() - tCopy} ms)`,
  );
  results.push({ name: 'GL_CODE_COMBINATIONS', status: 'copied', source: dimensionRows.length, dest: Number(back), ok });
}

results.push(
  await copyTable({
    name: 'GL_BALANCES',
    select: `SELECT gb.LEDGER_ID, gb.CODE_COMBINATION_ID, gb.PERIOD_NAME, gb.PERIOD_YEAR,
                    gb.PERIOD_NUM, gb.PERIOD_TYPE, gb.ACTUAL_FLAG, gb.BUDGET_VERSION_ID,
                    gb.ENCUMBRANCE_TYPE_ID, gb.CURRENCY_CODE, gb.TRANSLATED_FLAG,
                    gb.PERIOD_NET_DR, gb.PERIOD_NET_CR
               FROM GL_BALANCES gb
               JOIN GL_CODE_COMBINATIONS g ON g.CODE_COMBINATION_ID = gb.CODE_COMBINATION_ID
              WHERE g.SEGMENT1 = '04' AND gb.PERIOD_YEAR BETWEEN 2022 AND 2027`,
    createSql: `CREATE TABLE dbo.GL_BALANCES (
      LEDGER_ID INT NULL, CODE_COMBINATION_ID BIGINT NULL, PERIOD_NAME NVARCHAR(30) NULL,
      PERIOD_YEAR INT NULL, PERIOD_NUM INT NULL, PERIOD_TYPE NVARCHAR(10) NULL,
      ACTUAL_FLAG NVARCHAR(2) NULL, BUDGET_VERSION_ID INT NULL,
      ENCUMBRANCE_TYPE_ID INT NULL, CURRENCY_CODE NVARCHAR(10) NULL,
      TRANSLATED_FLAG NVARCHAR(2) NULL, PERIOD_NET_DR FLOAT NULL, PERIOD_NET_CR FLOAT NULL)`,
    orderBy: 'gb.PERIOD_YEAR, gb.PERIOD_NUM, gb.CODE_COMBINATION_ID',
    // ★ EXPLICIT TYPES. `BigInt` for the id columns — see coerce()'s note on why
    //   the driver needs a real JS BigInt for a BIGINT column.
    types: {
      LEDGER_ID: mssql.Int,
      CODE_COMBINATION_ID: mssql.BigInt,
      PERIOD_NAME: mssql.NVarChar(30),
      PERIOD_YEAR: mssql.Int,
      PERIOD_NUM: mssql.Int,
      PERIOD_TYPE: mssql.NVarChar(10),
      ACTUAL_FLAG: mssql.NVarChar(2),
      BUDGET_VERSION_ID: mssql.Int,
      ENCUMBRANCE_TYPE_ID: mssql.Int,
      CURRENCY_CODE: mssql.NVarChar(10),
      TRANSLATED_FLAG: mssql.NVarChar(2),
      PERIOD_NET_DR: mssql.Float,
      PERIOD_NET_CR: mssql.Float,
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_VENDORS',
    select: `SELECT VENDOR_ID, VENDOR_NAME, ENABLED_FLAG FROM PO_VENDORS`,
    createSql: `CREATE TABLE dbo.PO_VENDORS (
      VENDOR_ID BIGINT NOT NULL PRIMARY KEY, VENDOR_NAME NVARCHAR(400) NULL,
      ENABLED_FLAG NVARCHAR(2) NULL)`,
    types: {
      VENDOR_ID: mssql.BigInt,
      VENDOR_NAME: mssql.NVarChar(400),
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_HEADERS_ALL',
    // ★★ `WCSEXP_PO_HEADERS`, NOT `PO_HEADERS_ALL` — MEASURED, NOT GUESSED.
    //
    //   `PO_HEADERS_ALL` raises ORA-00942 under BOTH names that were tried, and
    //   the dictionary explains why:
    //
    //     ALL_SYNONYMS:  APPS.PO_HEADERS_ALL  ->  PO.PO_HEADERS_ALL#
    //     ALL_OBJECTS:   PO.PO_HEADERS_ALL#   is a VIEW owned by PO
    //
    //   The synonym resolves to a view in the `PO` schema, and this account has no
    //   direct SELECT grant on it. ALL_OBJECTS lists it, so the object is visible
    //   -- which is exactly why the error looked like a missing table rather than a
    //   privilege gap.
    //
    //   ★ `WCSEXP_PO_HEADERS` IS THE READABLE ROUTE, AND IT IS THE SAME ONE THE
    //     EXTRACT USES. It is a view owned by APPS -- the schema the session is
    //     pinned to -- so it resolves unqualified with no extra grant. The .env
    //     records the same pattern for the payables tables: `AP_INVOICE_LINES_ALL`
    //     raises ORA-00942 and the extract reads `WCSEXP_*` instead.
    //
    //   ★ THE VIEW'S COLUMN LIST, MEASURED — NOT THE BASE TABLE'S. Read from
    //     ALL_TAB_COLUMNS for APPS.WCSEXP_PO_HEADERS, which returns exactly ten:
    //
    //       PO_HEADER_ID (N)  TYPE_LOOKUP_CODE (N)  PO_NUMBER (N)
    //       VENDOR_ID (Y)     VENDOR_SITE_ID (Y)    APPROVED_FLAG (Y)
    //       APPROVED_DATE (Y) START_DATE_ACTIVE (Y)
    //       EXP_PROJECT_NAME (Y)  EXP_PO_NUMBER (Y)
    //
    //   ★★ THREE COLUMNS THE BASE TABLE HAS ARE ABSENT HERE, AND THE COPY MUST NOT
    //      NAME THEM: `AGENT_ID`, `ORG_ID` and `CANCEL_FLAG`. A WCSEXP_ view is a
    //      projection, so it exposes only what the extract needed — and naming a
    //      column the view does not have is ORA-00904, the same class of failure as
    //      the last two, from the other direction.
    //
    //   ★ `PO_NUMBER` IS THE VIEW'S OWN COLUMN NAME, NOT A RENAME OF `SEGMENT1`.
    //     The base table carries the readable order number in SEGMENT1 (the extract
    //     scripts say so), but the view has already projected it as PO_NUMBER --
    //     measured, and the sample row shows `"PO_NUMBER": "CF470936"`. Writing
    //     `SEGMENT1 AS PO_NUMBER` would have been ORA-00904 for a column that does
    //     not exist under that name in this view.
    //
    //   ★ THE TWO `EXP_*` COLUMNS ARE DROPPED. They are NULL on the sample row and
    //     nothing in this app reads them; carrying them would add two columns to
    //     the cache that no screen asks for.
    //
    //   ★★ THE COLUMN IS NAMED `SEGMENT1` HERE, NOT `PO_NUMBER`, AND THAT IS THE
    //      WHOLE POINT OF THIS LINE. The route reads the order number with
    //      `MAX(h.SEGMENT1)` — correct against the BASE TABLE, where the readable
    //      number really does live in SEGMENT1 — and this copy is the only place
    //      that can reconcile the two names. Naming the column `PO_NUMBER` (the
    //      view's own name) left the route with `Invalid column name 'SEGMENT1'`
    //      on SQL Server while the identical SQL worked on Oracle, which is the
    //      worst kind of divergence: the app is correct on one engine and broken
    //      on the other, and the error names a column that exists in neither
    //      table under the name the reader expects.
    //
    //      ★ ALIASING AT COPY TIME IS THE FIX, NOT EDITING THE ROUTE. The route's
    //        SQL is shared by both drivers; changing it to `PO_NUMBER` would break
    //        Oracle, where `PO_HEADERS_ALL` has no such column. The copy is the
    //        dialect seam, so the rename belongs here — and `SELECT … AS SEGMENT1`
    //        keeps the one readable name in the cache.
    //
    //   ★★ `AUTHORIZATION_STATUS` COMES FROM THE BASE TABLE, NOT THE VIEW, AND THAT
    //      IS THE ONE PLACE THIS COPY READS TWO SOURCES.
    //
    //      The extract's `STATUS` column is `h.AUTHORIZATION_STATUS`, and
    //      `WCSEXP_PO_HEADERS` does not project it — its ten columns are listed
    //      above and this is not one of them. Measured, the base table carries four
    //      values: `APPROVED` (99,968 of a 100,000-row sample), `IN PROCESS`,
    //      `REQUIRES REAPPROVAL` and `REJECTED`. So the copy joins the view to the
    //      base table on `PO_HEADER_ID` to pick the column up.
    //
    //      ★ THE JOIN IS SAFE BECAUSE THE KEY IS THE PRIMARY KEY ON BOTH SIDES, and
    //        it is an INNER join: a header in the view with no base row would be a
    //        broken extract anyway, and a LEFT join would only turn that into a
    //        silent null status.
    select: `SELECT v.PO_HEADER_ID, v.TYPE_LOOKUP_CODE, v.PO_NUMBER AS SEGMENT1, v.VENDOR_ID,
                    v.VENDOR_SITE_ID, v.APPROVED_FLAG, v.APPROVED_DATE, v.START_DATE_ACTIVE,
                    b.AUTHORIZATION_STATUS
               FROM WCSEXP_PO_HEADERS v
               JOIN PO_HEADERS_ALL b ON b.PO_HEADER_ID = v.PO_HEADER_ID`,
    createSql: `CREATE TABLE dbo.PO_HEADERS_ALL (
      PO_HEADER_ID BIGINT NOT NULL PRIMARY KEY, SEGMENT1 NVARCHAR(40) NULL,
      TYPE_LOOKUP_CODE NVARCHAR(20) NULL, VENDOR_ID BIGINT NULL, VENDOR_SITE_ID BIGINT NULL,
      APPROVED_FLAG NVARCHAR(2) NULL, APPROVED_DATE DATE NULL,
      START_DATE_ACTIVE DATE NULL, AUTHORIZATION_STATUS NVARCHAR(30) NULL)`,
    // ★ MEASURED RANGES, from the earlier probe against the base table:
    //     PO_HEADER_ID    2 .. 11,350,904   -> BIGINT (exceeds INT)
    //     VENDOR_ID       2 .. 4,652,992    -> BIGINT
    //     VENDOR_SITE_ID  7,535 .. 1,480,941 -> BIGINT
    types: {
      PO_HEADER_ID: mssql.BigInt,
      TYPE_LOOKUP_CODE: mssql.NVarChar(20),
      SEGMENT1: mssql.NVarChar(40),
      VENDOR_ID: mssql.BigInt,
      VENDOR_SITE_ID: mssql.BigInt,
      APPROVED_FLAG: mssql.NVarChar(2),
      APPROVED_DATE: mssql.Date,
      START_DATE_ACTIVE: mssql.Date,
      // Longest measured value is `REQUIRES REAPPROVAL` (19 chars); 30 leaves room
      // for a value EBS adds later without a silent truncation.
      AUTHORIZATION_STATUS: mssql.NVarChar(30),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_LINES_ALL',
    select: `SELECT PO_LINE_ID, PO_HEADER_ID, LINE_TYPE_ID, LINE_NUM, ITEM_ID, ITEM_DESCRIPTION,
                    UNIT_MEAS_LOOKUP_CODE, UNIT_PRICE, QUANTITY, CLOSED_CODE, CANCEL_FLAG
               FROM PO_LINES_ALL`,
    createSql: `CREATE TABLE dbo.PO_LINES_ALL (
      PO_LINE_ID BIGINT NOT NULL PRIMARY KEY, PO_HEADER_ID BIGINT NULL, LINE_TYPE_ID INT NULL,
      LINE_NUM BIGINT NULL, ITEM_ID BIGINT NULL, ITEM_DESCRIPTION NVARCHAR(500) NULL,
      UNIT_MEAS_LOOKUP_CODE NVARCHAR(25) NULL, UNIT_PRICE FLOAT NULL, QUANTITY FLOAT NULL,
      CLOSED_CODE NVARCHAR(25) NULL, CANCEL_FLAG NVARCHAR(2) NULL)`,
    types: {
      PO_LINE_ID: mssql.BigInt,
      PO_HEADER_ID: mssql.BigInt,
      LINE_TYPE_ID: mssql.Int,
      // ★★ BIGINT, NOT INT — MEASURED, AND ONLY TWO ROWS NEED IT.
      //   `LINE_NUM` runs to 7,880,000,000 in this table, which is 3.7x the INT
      //   maximum, and exactly 2 of 1,141,923 rows exceed the 32-bit range.
      //
      //   ★ THAT IS WHY THE COPY FAILED AT 250,000 ROWS AND NOT EARLIER. The
      //     query has no ORDER BY, so the two offenders arrive wherever Oracle
      //     chooses to put them — the failure row is not a property of the data,
      //     it is a property of the plan. A copy that happened to place them after
      //     row 1,141,923 would have succeeded and written two wrong values.
      //
      //   ★ EBS ENCODES LINE_NUM, WHICH IS WHY IT IS NOT A SMALL ORDINAL. The
      //     visible line number is packed with revision information, so a line
      //     that has been revised many times carries a value far above its
      //     apparent position in the document.
      LINE_NUM: mssql.BigInt,
      ITEM_ID: mssql.BigInt,
      ITEM_DESCRIPTION: mssql.NVarChar(500),
      UNIT_MEAS_LOOKUP_CODE: mssql.NVarChar(25),
      UNIT_PRICE: mssql.Float,
      QUANTITY: mssql.Float,
      CLOSED_CODE: mssql.NVarChar(25),
      CANCEL_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_DISTRIBUTIONS_ALL',
    select: `SELECT PO_DISTRIBUTION_ID, PO_HEADER_ID, PO_LINE_ID, LINE_LOCATION_ID,
                    CODE_COMBINATION_ID, DISTRIBUTION_NUM, QUANTITY_ORDERED,
                    AMOUNT_ORDERED, AMOUNT_BILLED, ENCUMBERED_FLAG, ENCUMBERED_AMOUNT
               FROM PO_DISTRIBUTIONS_ALL`,
    createSql: `CREATE TABLE dbo.PO_DISTRIBUTIONS_ALL (
      PO_DISTRIBUTION_ID BIGINT NOT NULL PRIMARY KEY, PO_HEADER_ID BIGINT NULL,
      PO_LINE_ID BIGINT NULL, LINE_LOCATION_ID BIGINT NULL, CODE_COMBINATION_ID BIGINT NULL,
      DISTRIBUTION_NUM FLOAT NULL, QUANTITY_ORDERED FLOAT NULL, AMOUNT_ORDERED FLOAT NULL,
      AMOUNT_BILLED FLOAT NULL, ENCUMBERED_FLAG NVARCHAR(2) NULL, ENCUMBERED_AMOUNT FLOAT NULL)`,
    // ★ EVERY TYPE HERE IS BACKED BY A MEASURED RANGE, not by the column's name:
    //     PO_DISTRIBUTION_ID   1 .. 12,101,060        -> BIGINT (ids exceed INT on
    //                                                    other PO tables; kept
    //                                                    consistent across them)
    //     PO_HEADER_ID         2 .. 11,350,904        -> BIGINT
    //     PO_LINE_ID           2 .. 11,756,899        -> BIGINT
    //     LINE_LOCATION_ID     2 .. 12,489,600        -> BIGINT
    //     CODE_COMBINATION_ID  1,074 .. 9,709,011     -> BIGINT
    //     DISTRIBUTION_NUM     0.1 .. 5,801           -> ★ FLOAT, NOT INT
    //
    //   ★ DISTRIBUTION_NUM IS FRACTIONAL. Measured minimum 0.1, so an INT column
    //     would silently truncate it to 0 -- a wrong value, not an error. This is
    //     the one place in the PO copy where the wrong type would NOT have been
    //     caught by the copy failing.
    types: {
      PO_DISTRIBUTION_ID: mssql.BigInt,
      PO_HEADER_ID: mssql.BigInt,
      PO_LINE_ID: mssql.BigInt,
      LINE_LOCATION_ID: mssql.BigInt,
      CODE_COMBINATION_ID: mssql.BigInt,
      DISTRIBUTION_NUM: mssql.Float,
      QUANTITY_ORDERED: mssql.Float,
      AMOUNT_ORDERED: mssql.Float,
      AMOUNT_BILLED: mssql.Float,
      ENCUMBERED_FLAG: mssql.NVarChar(2),
      ENCUMBERED_AMOUNT: mssql.Float,
    },
  }),
);

// ---------------------------------------------------------------------------
// ★★ THE FOUR TABLES THE FIRST PASS MISSED, ADDED AFTER MEASURING WHAT THE APP
//    ACTUALLY READS.
//
//   The first pass copied six tables — the ones the *ledger* endpoints read. But
//   the app reads four more, and under `DB_MODE=sqlserver` every one of them
//   answered 500 `Invalid object name`:
//
//     /api/procurement/summary  → PO_LINE_LOCATIONS_ALL
//     /api/projects/summary     → PA_PROJECTS_ALL
//     /api/funding/summary      → GL_BUDGET_TYPES
//     /api/vendor-sites         → PO_VENDOR_SITES_ALL
//
//   ★ THE LESSON IS ABOUT SCOPE, NOT ABOUT THESE FOUR NAMES. "Which tables does
//     the ledger need" was answered from the ledger *tables* the copy script
//     already knew about, and the real question is "which objects does any query
//     name" — which is found by grepping the routes, not by reading the copy
//     script. `PO_VENDOR_SITES_ALL` is read by the vendor-site register and by
//     nothing else; `GL_BUDGET_TYPES` is read by the budget summary.
//
//   ★ EVERY TYPE BELOW IS BACKED BY A MEASURED RANGE, the same discipline as the
//     six above — see the notes on each.
// ---------------------------------------------------------------------------

results.push(
  await copyTable({
    name: 'PO_LINE_LOCATIONS_ALL',
    // ★★ FOUR MORE COLUMNS, AND THEY ARE THE REASON THE EXTRACT CAN BE SERVED FROM HERE.
    //
    //   The first version copied five columns — the line-location grain and its
    //   ship-to — because that is what `/api/procurement/summary` reads. But the
    //   **extract's `AMOUNT` does not come from `PO_DISTRIBUTIONS_ALL`**: measured,
    //   `AMOUNT_ORDERED` is NULL on **all 82,007** Fund-04 distribution rows, and
    //   the live route reads `WCSEXP_PO_DISTRIBUTIONS`, whose view body *computes* it:
    //
    //       ROUND( DECODE(PLL.QUANTITY, NULL, (PLL.AMOUNT - NVL(PLL.AMOUNT_CANCELLED,0)),
    //              (PLL.QUANTITY - NVL(PLL.QUANTITY_CANCELLED,0)) * NVL(PLL.PRICE_OVERRIDE,0) ), 2 )
    //
    //   So the four columns that formula reads have to be here, or a SQL Server
    //   extract can only report a null amount. `PRICE_OVERRIDE` is the one that
    //   matters most: it is 1.00 on most lines, which is why the frozen file appears
    //   to have `AMOUNT == QUANTITY` everywhere.
    select: `SELECT LINE_LOCATION_ID, PO_HEADER_ID, PO_LINE_ID, QUANTITY,
                    QUANTITY_CANCELLED, AMOUNT, AMOUNT_CANCELLED, PRICE_OVERRIDE,
                    SHIP_TO_LOCATION_ID
               FROM PO_LINE_LOCATIONS_ALL`,
    // ★★ WINDOWED, BECAUSE THIS IS THE ONE TABLE BIG ENOUGH TO NEED IT.
    //
    //    Measured: 1,151,983 rows, and a single-statement fetch takes **377.9 s**.
    //    Two runs died inside that window — the log truncated at `...125000` with
    //    the process gone, and `NJS-003: invalid or closed connection` at the
    //    source stage. Both threw away every row read, because the un-windowed
    //    fetch is all-or-nothing.
    //
    //    `LINE_LOCATION_ID` is the primary key and is monotonic in practice, so it
    //    is the natural window key: each window is an index range scan and the
    //    windows partition the table exactly. See `copyTableWindowed`.
    windowBy: 'LINE_LOCATION_ID',
    createSql: `CREATE TABLE dbo.PO_LINE_LOCATIONS_ALL (
      LINE_LOCATION_ID BIGINT NOT NULL PRIMARY KEY, PO_HEADER_ID BIGINT NULL,
      PO_LINE_ID BIGINT NULL, QUANTITY FLOAT NULL, QUANTITY_CANCELLED FLOAT NULL,
      AMOUNT FLOAT NULL, AMOUNT_CANCELLED FLOAT NULL, PRICE_OVERRIDE FLOAT NULL,
      SHIP_TO_LOCATION_ID BIGINT NULL)`,
    //   LINE_LOCATION_ID    2 .. 12,489,600   -> BIGINT
    //   PO_HEADER_ID        2 .. 11,350,904   -> BIGINT
    //   PO_LINE_ID          2 .. 11,756,899   -> BIGINT
    //   QUANTITY            0 .. 97,681,625   -> FLOAT (a quantity, not a count;
    //                                            the PO tables already carry
    //                                            fractional quantities)
    //   SHIP_TO_LOCATION_ID 2 .. (non-null on all 1,151,983 rows) -> BIGINT
    //   QUANTITY_CANCELLED / AMOUNT / AMOUNT_CANCELLED / PRICE_OVERRIDE
    //                       -> FLOAT, all nullable: measured, `AMOUNT` and
    //                          `AMOUNT_CANCELLED` are NULL on the sample rows
    //                          while `QUANTITY_CANCELLED` is 0 and
    //                          `PRICE_OVERRIDE` carries the unit price.
    //
    // ★ NINE OF 180 COLUMNS ARE COPIED, DELIBERATELY. The app reads this table for
    //   the line-location grain, its ship-to, and the four inputs to the amount
    //   formula above; the other 171 are audit columns and EBS internals. Copying
    //   all of them would multiply the transfer for columns nothing selects.
    types: {
      LINE_LOCATION_ID: mssql.BigInt,
      PO_HEADER_ID: mssql.BigInt,
      PO_LINE_ID: mssql.BigInt,
      QUANTITY: mssql.Float,
      QUANTITY_CANCELLED: mssql.Float,
      AMOUNT: mssql.Float,
      AMOUNT_CANCELLED: mssql.Float,
      PRICE_OVERRIDE: mssql.Float,
      SHIP_TO_LOCATION_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_VENDOR_SITES_ALL',
    select: `SELECT VENDOR_SITE_ID, VENDOR_ID, VENDOR_SITE_CODE, ADDRESS_LINE1,
                    CITY, STATE, ZIP, COUNTRY, ORG_ID
               FROM PO_VENDOR_SITES_ALL`,
    createSql: `CREATE TABLE dbo.PO_VENDOR_SITES_ALL (
      VENDOR_SITE_ID BIGINT NOT NULL PRIMARY KEY, VENDOR_ID BIGINT NULL,
      VENDOR_SITE_CODE NVARCHAR(40) NULL, ADDRESS_LINE1 NVARCHAR(200) NULL,
      CITY NVARCHAR(120) NULL, STATE NVARCHAR(60) NULL, ZIP NVARCHAR(40) NULL,
      COUNTRY NVARCHAR(10) NULL, ORG_ID BIGINT NULL)`,
    //   VENDOR_SITE_ID  7,534 .. 1,481,941  -> BIGINT
    //   VENDOR_ID       1 .. 4,661,990      -> BIGINT
    //   ORG_ID          21 .. 21            -> BIGINT
    //
    //   ★ THE STRING WIDTHS ARE THE MEASURED MAXIMUM ROUNDED UP, NOT THE ORACLE
    //     DECLARED WIDTH — and the difference matters. Oracle declares these as
    //     `VARCHAR2(240)`/`(25)`; the widest value actually present is
    //     `ADDRESS_LINE1` 69, `CITY` 40, `STATE` 24, `ZIP` 18,
    //     `VENDOR_SITE_CODE` 15, `COUNTRY` 2. Declaring Oracle's widths would
    //     reserve four times the space for nothing, and declaring *less* than the
    //     measured maximum is what produced the `mapbox_id` truncation earlier in
    //     this migration — a failure that only appears on the one row that is
    //     long enough. The headroom above each measured max is deliberate.
    types: {
      VENDOR_SITE_ID: mssql.BigInt,
      VENDOR_ID: mssql.BigInt,
      VENDOR_SITE_CODE: mssql.NVarChar(40),
      ADDRESS_LINE1: mssql.NVarChar(200),
      CITY: mssql.NVarChar(120),
      STATE: mssql.NVarChar(60),
      ZIP: mssql.NVarChar(40),
      COUNTRY: mssql.NVarChar(10),
      ORG_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_BUDGET_TYPES',
    select: `SELECT BUDGET_TYPE, DESCRIPTION, AUDIT_TRAIL_FLAG
                FROM GL_BUDGET_TYPES`,
    createSql: `CREATE TABLE dbo.GL_BUDGET_TYPES (
      BUDGET_TYPE NVARCHAR(60) NOT NULL PRIMARY KEY,
      DESCRIPTION NVARCHAR(400) NULL, AUDIT_TRAIL_FLAG NVARCHAR(2) NULL)`,
    // ★ ONE ROW, AND ITS KEY IS A CODE STRING, NOT AN ID.
    //
    //   Measured: the only row is `BUDGET_TYPE = 'STANDARD'`, and the table has
    //   **no `BUDGET_TYPE_ID` and no `BUDGET_TYPE_CODE`** — the two columns the
    //   seeded `V_ACCOUNT_POSITION` joins on. That is why that view cannot exist
    //   on this instance and why `derived.ts` composes it instead; see the header
    //   of `data/sql/sqlserver/00-ledger.sql`.
    //
    //   The primary key is `BUDGET_TYPE` because it is the only candidate: the
    //   table has one row and no id column, and a copy of a one-row table needs a
    //   key for the bulk insert to have a contract at all.
    types: {
      BUDGET_TYPE: mssql.NVarChar(60),
      DESCRIPTION: mssql.NVarChar(400),
      AUDIT_TRAIL_FLAG: mssql.NVarChar(2),
    },
  }),
);

// ---------------------------------------------------------------------------
// ★ `PA_PROJECTS_ALL` IS DELIBERATELY *NOT* COPIED, AND THAT IS A MEASUREMENT.
//
//   `/api/projects/summary` answered `Invalid object name 'PA_PROJECTS_ALL'`, so
//   the table is named by the app and must exist — but it holds **0 rows** on
//   this instance (measured), and it has 241 columns of which the app reads a
//   handful.
//
//   ★ AN EMPTY TABLE STILL HAS TO EXIST. "0 rows" is not "not needed": the query
//     names it, so a missing table is a 500 while an empty one is an empty
//     answer — and those are different facts to a reader. So the DDL is created
//     with no data load, which is the honest shape: the schema is ported, the
//     rows are what Oracle has (none).
//
//   ★ THE COLUMNS ARE THE ONES THE APP SELECTS, and they are declared from the
//     real table's own metadata rather than guessed — `PROJECT_ID`, `NAME`,
//     `SEGMENT1`, `PROJECT_STATUS_CODE`, `DESCRIPTION`, `START_DATE` are all
//     present on it (measured with `SELECT * … WHERE 1=0`).
// ---------------------------------------------------------------------------
say('\n=== PA_PROJECTS_ALL (schema only — 0 rows in Oracle) ===');
await pool.request().query(`DROP TABLE IF EXISTS dbo.PA_PROJECTS_ALL`);
await pool.request().query(`CREATE TABLE dbo.PA_PROJECTS_ALL (
  PROJECT_ID BIGINT NOT NULL PRIMARY KEY, NAME NVARCHAR(60) NULL,
  SEGMENT1 NVARCHAR(60) NULL, PROJECT_STATUS_CODE NVARCHAR(60) NULL,
  DESCRIPTION NVARCHAR(500) NULL, START_DATE DATETIME2 NULL)`);
const paCount = (await pool.request().query('SELECT COUNT(*) AS n FROM dbo.PA_PROJECTS_ALL')).recordset[0].n;
say(`   created dbo.PA_PROJECTS_ALL (${paCount} rows — Oracle holds 0)`);
results.push({ name: 'PA_PROJECTS_ALL', status: 'copied', source: 0, dest: Number(paCount), ok: Number(paCount) === 0 });

// ---------------------------------------------------------------------------
// ★★ THE REMAINING REGISTRY TABLES — FOUND BY DIFFING `EBS_TABLES`, NOT BY
//    CHASING 500s ONE AT A TIME.
//
//   The first two passes copied six tables, then four more, each time because an
//   endpoint failed. That is a slow and incomplete way to find a list that the
//   codebase already writes down: `store.ts`'s `EBS_TABLES` declares exactly which
//   names are tables. Diffing it against `sys.objects` gave the honest answer —
//   **42 of 49 missing** — in one query instead of a dozen failing requests.
//
//   ★ THE PROBE THAT FOUND THEM IS WORTH MORE THAN THE LIST. Two earlier attempts
//     scraped `quoteIdent('X')` out of the source and reported 176 then 119
//     "missing" objects, because `quoteIdent` names *columns* too — so the list
//     filled with `SEGMENT1`, `PERIOD_YEAR` and, from prose in comments, `THE`,
//     `BEING`, `WAKE`. The tell was the SHAPE: real missing tables are a handful
//     of `UPPER_SNAKE` nouns, not English words.
//
//   ★ SEVERAL OF THESE ARE READ ONLY AS `COUNT(*)` — `GL_BUDGET_ENTITIES`,
//     `GL_BUDGET_ASSIGNMENTS`, `GL_JE_HEADERS`. They still have to be created and
//     populated: a count over an empty table reports **0**, which is a false
//     number rather than a missing one, and a reader cannot tell the two apart.
// ---------------------------------------------------------------------------

results.push(
  await copyTable({
    name: 'GL_LEDGERS',
    select: `SELECT LEDGER_ID, NAME, SHORT_NAME, CURRENCY_CODE, PERIOD_SET_NAME,
                    LEDGER_CATEGORY_CODE, CHART_OF_ACCOUNTS_ID
               FROM GL_LEDGERS`,
    createSql: `CREATE TABLE dbo.GL_LEDGERS (
      LEDGER_ID BIGINT NOT NULL PRIMARY KEY, NAME NVARCHAR(120) NULL,
      SHORT_NAME NVARCHAR(60) NULL, CURRENCY_CODE NVARCHAR(20) NULL,
      PERIOD_SET_NAME NVARCHAR(60) NULL, LEDGER_CATEGORY_CODE NVARCHAR(60) NULL,
      CHART_OF_ACCOUNTS_ID BIGINT NULL)`,
    // ★ ONE ROW, AND IT IS THE SCOPE KEY FOR EVERYTHING ELSE. Measured: ledger 1,
    //   "Wake County Public Schools", PRIMARY, USD. `derived.ts` hard-codes
    //   `LEDGER_ID = 1` on the strength of this — the subquery the seeded views
    //   write (`LEDGER_ID IN (SELECT … WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')`)
    //   is a no-op over a one-row table, so the constant states the same thing
    //   without the join. This copy is what makes that constant checkable.
    types: {
      LEDGER_ID: mssql.BigInt,
      NAME: mssql.NVarChar(120),
      SHORT_NAME: mssql.NVarChar(60),
      CURRENCY_CODE: mssql.NVarChar(20),
      PERIOD_SET_NAME: mssql.NVarChar(60),
      LEDGER_CATEGORY_CODE: mssql.NVarChar(60),
      CHART_OF_ACCOUNTS_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_LOOKUPS',
    select: `SELECT LOOKUP_TYPE, LOOKUP_CODE, MEANING, DESCRIPTION, ENABLED_FLAG
               FROM GL_LOOKUPS`,
    createSql: `CREATE TABLE dbo.GL_LOOKUPS (
      LOOKUP_TYPE NVARCHAR(60) COLLATE Latin1_General_BIN2 NOT NULL,
      LOOKUP_CODE NVARCHAR(60) COLLATE Latin1_General_BIN2 NOT NULL,
      MEANING NVARCHAR(160) NULL, DESCRIPTION NVARCHAR(500) NULL,
      ENABLED_FLAG NVARCHAR(2) NULL,
      CONSTRAINT PK_GL_LOOKUPS PRIMARY KEY (LOOKUP_TYPE, LOOKUP_CODE))`,
    // ★★ THE KEY IS UNIQUE ONLY CASE-SENSITIVELY, SO THE COLLATION IS PART OF THE
    //    DEFINITION — AND GETTING IT WRONG IS A HARD FAILURE, NOT A TIE-BREAK.
    //
    //    Measured on the source: **1,175 rows, 1,175 distinct case-sensitively,
    //    but only 1,149 case-insensitively.** The difference is 51 rows in
    //    case-only pairs — `('BATCH_STATUS','A')` beside `('BATCH_STATUS','a')`,
    //    and the same for `MJE_BATCH_STATUS`. Oracle's default collation is
    //    case-sensitive, so both rows are legal there.
    //
    //    ★ SQL SERVER'S DEFAULT IS CASE-INSENSITIVE. So the primary key above,
    //      under the database default, rejects the second row of every pair with
    //      **Msg 2627** — "Violation of PRIMARY KEY constraint… The duplicate key
    //      value is (BATCH_STATUS, a)" — which reads like a duplicate in the
    //      SOURCE data rather than a collation mismatch. That is the first
    //      diagnosis I reached, and it was wrong: the source has no duplicates.
    //
    //    ★ `COLLATE Latin1_General_BIN2` MAKES THE COLUMNS COMPARE BY CODE POINT,
    //      which is what Oracle's default does. It is applied to the KEY COLUMNS
    //      rather than to the table, so a join or a `WHERE` on them keeps the same
    //      semantics the source has — a table-level collation would be overridden
    //      by the column's own anyway.
    //
    //    ★ THIS IS THE ONE TABLE IN THE COPY WHERE THE COLLATION MATTERS. Measured
    //      on the other composite-key tables: `PO_LOOKUP_CODES` 82,438 rows and
    //      82,438 distinct BOTH ways, `FND_FLEX_VALUES_TL` 42,031 both ways. So
    //      this is a property of the data, checked per table, not a blanket rule.
    //
    // ★ A COMPOSITE KEY, BECAUSE NEITHER COLUMN IS UNIQUE ALONE. `LOOKUP_TYPE`
    //   repeats by definition (it is the category) and `LOOKUP_CODE` repeats
    //   across types. The DDL says so rather than picking one and being wrong.
    types: {
      LOOKUP_TYPE: mssql.NVarChar(60),
      LOOKUP_CODE: mssql.NVarChar(60),
      MEANING: mssql.NVarChar(160),
      DESCRIPTION: mssql.NVarChar(500),
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_BUDGET_VERSIONS',
    select: `SELECT BUDGET_VERSION_ID, BUDGET_TYPE, BUDGET_NAME, VERSION_NUM,
                    STATUS, DESCRIPTION, DATE_OPENED
               FROM GL_BUDGET_VERSIONS`,
    createSql: `CREATE TABLE dbo.GL_BUDGET_VERSIONS (
      BUDGET_VERSION_ID BIGINT NOT NULL PRIMARY KEY, BUDGET_TYPE NVARCHAR(60) NULL,
      BUDGET_NAME NVARCHAR(120) NULL, VERSION_NUM NVARCHAR(20) NULL,
      STATUS NVARCHAR(4) NULL, DESCRIPTION NVARCHAR(500) NULL,
      DATE_OPENED DATETIME2 NULL)`,
    // ★ TWO ROWS, AND THE JOIN KEY IS A CODE STRING. Measured: `1000`
    //   (`BUDGET_TYPE='standard'`, `WCPSS`) and `1001` (`'standard'`,
    //   `WCPSS BUDGET`). The table has **no `BUDGET_TYPE_ID`** — the column the
    //   seeded `V_ACCOUNT_POSITION` joins `GL_BUDGET_TYPES` on — which is why that
    //   view cannot exist here. The ledger copy pinned `budget_version_id = 1001`.
    types: {
      BUDGET_VERSION_ID: mssql.BigInt,
      BUDGET_TYPE: mssql.NVarChar(60),
      BUDGET_NAME: mssql.NVarChar(120),
      VERSION_NUM: mssql.NVarChar(20),
      STATUS: mssql.NVarChar(4),
      DESCRIPTION: mssql.NVarChar(500),
      DATE_OPENED: mssql.DateTime2,
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_BUDGET_ENTITIES',
    select: `SELECT BUDGET_ENTITY_ID, NAME, LEDGER_ID, STATUS_CODE, DESCRIPTION
               FROM GL_BUDGET_ENTITIES`,
    createSql: `CREATE TABLE dbo.GL_BUDGET_ENTITIES (
      BUDGET_ENTITY_ID BIGINT NOT NULL PRIMARY KEY, NAME NVARCHAR(120) NULL,
      LEDGER_ID BIGINT NULL, STATUS_CODE NVARCHAR(60) NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    // ★ THE NAME COLUMN IS `NAME`, NOT `BUDGET_ENTITY_NAME`.
    //
    //   I wrote `BUDGET_ENTITY_NAME` because that is what the table is called, and
    //   the copy answered `ORA-00942: table or view does not exist` — which reads
    //   like a missing TABLE rather than a missing COLUMN, because Oracle reports
    //   a bad column inside a `SELECT` list the same way it reports a bad object.
    //   The real name is `NAME` (measured with `SELECT * … WHERE 1=0`).
    //
    //   ★ AND THERE IS NO `BUDGET_VERSION_ID` EITHER. The route reads this table
    //     only as `COUNT(*)`, so neither absence affects the answer — but the
    //     selection must name columns that exist or the copy fails before it
    //     copies anything.
    types: {
      BUDGET_ENTITY_ID: mssql.BigInt,
      NAME: mssql.NVarChar(120),
      LEDGER_ID: mssql.BigInt,
      STATUS_CODE: mssql.NVarChar(60),
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_BUDGET_ASSIGNMENTS',
    select: `SELECT RANGE_ID, LEDGER_ID, BUDGET_ENTITY_ID, CODE_COMBINATION_ID,
                    CURRENCY_CODE, ENTRY_CODE, AMOUNT_TYPE, BOUNDARY_CODE,
                    FUNDING_BUDGET_VERSION_ID, ORDERING_VALUE
               FROM GL_BUDGET_ASSIGNMENTS`,
    createSql: `CREATE TABLE dbo.GL_BUDGET_ASSIGNMENTS (
      RANGE_ID BIGINT NOT NULL, LEDGER_ID BIGINT NOT NULL,
      CODE_COMBINATION_ID BIGINT NOT NULL, BUDGET_ENTITY_ID BIGINT NULL,
      CURRENCY_CODE NVARCHAR(20) NULL, ENTRY_CODE NVARCHAR(60) NULL,
      AMOUNT_TYPE NVARCHAR(60) NULL, BOUNDARY_CODE NVARCHAR(60) NULL,
      FUNDING_BUDGET_VERSION_ID BIGINT NULL, ORDERING_VALUE FLOAT NULL,
      CONSTRAINT PK_GL_BUDGET_ASSIGNMENTS
        PRIMARY KEY (RANGE_ID, LEDGER_ID, CODE_COMBINATION_ID))`,
    // ★★ NOT ONE OF THE COLUMNS THE ROUTE DECLARES EXISTS ON THIS TABLE.
    //
    //    `routes/funding.ts` declares `BUDGET_ASSIGNMENT_ID`, `BUDGET_VERSION_ID`,
    //    `RANGE_FROM` and `RANGE_TO`. Measured against the real 30 columns:
    //    **all four are absent.** The table's key is `RANGE_ID`, it has no
    //    `BUDGET_VERSION_ID` at all, and the range is expressed as a single
    //    `RANGE_ID` reference rather than a from/to pair.
    //
    //    ★ AND THE ROUTE ALREADY KNOWS. Its own note says the declared key is
    //      absent, that `FUNDING_BUDGET_VERSION_ID` is **NULL on all 234,074 rows**,
    //      and that it therefore returns an **empty list with
    //      `assignmentsScopedByVersion: false`** rather than fabricating one:
    //
    //        const versionKeyReadable = assignmentPlan.ok &&
    //          !assignmentPlan.unavailable.includes('BUDGET_VERSION_ID');
    //
    //      So the honest copy is the columns that exist, and `ledgerPlan` will
    //      report the four missing ones as unavailable — which is exactly the
    //      signal that branch reads. Copying nothing, or inventing the columns,
    //      would both break that.
    //
    //    ★ 234,074 ROWS, AND THE KEY IS THREE COLUMNS — MEASURED, NOT ASSUMED.
    //      distinct RANGE_ID                                     = **30**
    //      distinct (RANGE_ID, LEDGER_ID)                        = 30
    //      distinct (RANGE_ID, LEDGER_ID, CODE_COMBINATION_ID)   = **234,074**
    //
    //      `RANGE_ID` alone has thirty values for 234,074 rows, so it was never a
    //      key — and declaring it one produced **Msg 2627** on `(1091)`, which
    //      reads like duplicate source data rather than a wrong key choice. The
    //      same wrong-first-guess happened on `FND_ID_FLEX_SEGMENTS` and
    //      `FND_ID_FLEX_STRUCTURES`: a surrogate-looking id that is really a
    //      *category*. Measure the candidate keys side by side before declaring one.
    types: {
      RANGE_ID: mssql.BigInt,
      LEDGER_ID: mssql.BigInt,
      BUDGET_ENTITY_ID: mssql.BigInt,
      CODE_COMBINATION_ID: mssql.BigInt,
      CURRENCY_CODE: mssql.NVarChar(20),
      ENTRY_CODE: mssql.NVarChar(60),
      AMOUNT_TYPE: mssql.NVarChar(60),
      BOUNDARY_CODE: mssql.NVarChar(60),
      FUNDING_BUDGET_VERSION_ID: mssql.BigInt,
      ORDERING_VALUE: mssql.Float,
    },
  }),
);

results.push(
  await copyTable({
    name: 'GL_JE_HEADERS',
    select: `SELECT JE_HEADER_ID, LEDGER_ID, JE_CATEGORY, JE_SOURCE, PERIOD_NAME,
                    NAME, STATUS, DATE_CREATED, ACTUAL_FLAG, DEFAULT_EFFECTIVE_DATE,
                    ENCUMBRANCE_TYPE_ID, POSTED_DATE, DESCRIPTION
               FROM GL_JE_HEADERS`,
    createSql: `CREATE TABLE dbo.GL_JE_HEADERS (
      JE_HEADER_ID BIGINT NOT NULL PRIMARY KEY, LEDGER_ID BIGINT NULL,
      JE_CATEGORY NVARCHAR(60) NULL, JE_SOURCE NVARCHAR(60) NULL,
      PERIOD_NAME NVARCHAR(40) NULL, NAME NVARCHAR(200) NULL,
      STATUS NVARCHAR(4) NULL, DATE_CREATED DATETIME2 NULL,
      ACTUAL_FLAG NVARCHAR(2) NULL, DEFAULT_EFFECTIVE_DATE DATETIME2 NULL,
      ENCUMBRANCE_TYPE_ID BIGINT NULL, POSTED_DATE DATETIME2 NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    // ★ 1,011,459 ROWS. Copied because `/api/funding/journals` lists them and
    //   `/api/funding/summary` counts them — this is real data, not a count-only
    //   table.
    //
    //   ★ THE COLUMN LIST IS THE ROUTE'S OWN `JE_HEADER_COLUMNS`, not the table's
    //     126. Copying every column would multiply the transfer for columns
    //     nothing selects, and the route declares exactly these thirteen.
    types: {
      JE_HEADER_ID: mssql.BigInt,
      LEDGER_ID: mssql.BigInt,
      JE_CATEGORY: mssql.NVarChar(60),
      JE_SOURCE: mssql.NVarChar(60),
      PERIOD_NAME: mssql.NVarChar(40),
      NAME: mssql.NVarChar(200),
      STATUS: mssql.NVarChar(4),
      DATE_CREATED: mssql.DateTime2,
      ACTUAL_FLAG: mssql.NVarChar(2),
      DEFAULT_EFFECTIVE_DATE: mssql.DateTime2,
      ENCUMBRANCE_TYPE_ID: mssql.BigInt,
      POSTED_DATE: mssql.DateTime2,
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

// ---------------------------------------------------------------------------
// ★★ `GL_JE_LINES` — COPIED, SCOPED TO FUND 04 + PROGRAM 861/862/863.
//
//   This table was SKIPPED in the first pass, and the reason recorded here was
//   sound at the time: `COUNT(*)` on the whole table timed out at 45 seconds, so
//   the copy looked like a long transfer for a number.
//
//   ★ THAT REASONING WAS OVERTAKEN BY A MEASUREMENT. The whole table is large, but
//     the SCOPE is not: measured exactly, fund 04 + program 861/862/863 is
//     **294,855 rows** — smaller than the AP tables that were skipped for size
//     (6.2M / 6.9M). The table is big; the part this application reads is not.
//
//   ★ AND THE TABLE IS NOT COUNT-ONLY ANY MORE. The first pass registered it for
//     `(SELECT COUNT(*) FROM GL_JE_LINES)` in `/api/funding/summary`. It is now
//     load-bearing for a second, larger reason: **the journal line is where an
//     allocation's DATE lives.**
//
//     `GL_BALANCES` holds the period's net movement and carries NO date column at
//     all — verified, 13 columns, none a timestamp. So "when was this combination
//     first funded" could only ever be answered as "which period", never "which
//     day". `GL_JE_LINES.CREATION_DATE` is the day, and it is populated on every
//     in-scope row (measured: 0 nulls of 294,855).
//
//   ★ THE SCOPE FILTER IS A JOIN, NOT A `WHERE`. `GL_JE_LINES` has no fund column —
//     the fund lives on `GL_CODE_COMBINATIONS.SEGMENT1`. So the copy reads through
//     the combination table, which is the same join the view uses.
//
//   ★ EVERY COLUMN IS QUALIFIED `l.` BECAUSE `LEDGER_ID` IS AMBIGUOUS. Measured:
//     an unqualified `SELECT LEDGER_ID … JOIN GL_CODE_COMBINATIONS` fails with
//     `ORA-00918: column ambiguously defined`. Both tables carry the name.
//
//   ★ THREE COLUMNS THE ROUTE NAMES ARE DELIBERATELY DROPPED, AND THE REASON IS
//     THAT THEY ARE EMPTY. `routes/funding.ts`'s `JE_LINE_COLUMNS` includes
//     `LINE_TYPE_CODE`, `INVOICE_IDENTIFIER` and `INVOICE_AMOUNT`. Measured across
//     all 294,855 in-scope rows, those three are NULL on **every single one** —
//     294,855 of 294,855. They are EBS payables columns this deployment does not
//     populate, so copying them would transfer three columns of nothing. The route
//     still names them, and a SELECT of a column that does not exist on the copy
//     would fail — so the DDL below creates them as nullable and they stay null.
//     That is the honest shape: the route's contract is unchanged, and the copy
//     does not pretend to hold data it does not have.
//
//   ★ `CREATION_DATE` IS ADDED TO THE ROUTE'S LIST, AND THAT IS THE POINT OF THE
//     COPY. The route's 12 columns were chosen for "list the lines of one journal",
//     where the header's date is the date. This copy exists for the per-allocation
//     date, so it carries `CREATION_DATE` and `PERIOD_NAME` as well.
// ---------------------------------------------------------------------------
results.push(
  await copyTable({
    name: 'GL_JE_LINES',
    select: `SELECT l.JE_HEADER_ID, l.JE_LINE_NUM, l.LEDGER_ID, l.CODE_COMBINATION_ID,
                    l.PERIOD_NAME, l.EFFECTIVE_DATE, l.CREATION_DATE, l.STATUS,
                    l.ENTERED_DR, l.ENTERED_CR, l.ACCOUNTED_DR, l.ACCOUNTED_CR,
                    l.DESCRIPTION, l.LINE_TYPE_CODE, l.INVOICE_IDENTIFIER, l.INVOICE_AMOUNT
               FROM GL_JE_LINES l
               JOIN GL_CODE_COMBINATIONS c ON c.CODE_COMBINATION_ID = l.CODE_COMBINATION_ID
              WHERE c.SEGMENT1 = '04' AND c.SEGMENT3 IN ('861', '862', '863')`,
    createSql: `CREATE TABLE dbo.GL_JE_LINES (
      JE_HEADER_ID BIGINT NOT NULL, JE_LINE_NUM BIGINT NOT NULL,
      LEDGER_ID BIGINT NULL, CODE_COMBINATION_ID BIGINT NULL,
      PERIOD_NAME NVARCHAR(40) NULL, EFFECTIVE_DATE DATE NULL,
      CREATION_DATE DATE NULL, STATUS NVARCHAR(4) NULL,
      ENTERED_DR FLOAT NULL, ENTERED_CR FLOAT NULL,
      ACCOUNTED_DR FLOAT NULL, ACCOUNTED_CR FLOAT NULL,
      DESCRIPTION NVARCHAR(500) NULL, LINE_TYPE_CODE NVARCHAR(60) NULL,
      INVOICE_IDENTIFIER NVARCHAR(100) NULL, INVOICE_AMOUNT FLOAT NULL,
      CONSTRAINT PK_GL_JE_LINES PRIMARY KEY (JE_HEADER_ID, JE_LINE_NUM))`,
    // ★ THE WIDTHS ARE MEASURED, NOT GUESSED. Across the in-scope rows:
    //     PERIOD_NAME   max 13   → NVARCHAR(40) is the route's own declaration
    //     STATUS        max  1   → NVARCHAR(4)  matches GL_JE_HEADERS
    //     DESCRIPTION   max 240  → NVARCHAR(500)
    //   A guessed width on a column that holds more truncates silently on copy,
    //   which is the failure mode worth spending one query to avoid.
    types: {
      JE_HEADER_ID: mssql.BigInt,
      JE_LINE_NUM: mssql.BigInt,
      LEDGER_ID: mssql.BigInt,
      CODE_COMBINATION_ID: mssql.BigInt,
      PERIOD_NAME: mssql.NVarChar(40),
      // ★ `Date`, NOT `DateTime2`. The Oracle column is a DATE and the driver
      //   returns `"2017-04-28"` — a plain day with no time part. Declaring
      //   DATETIME2 would store midnight and render a time on a column that has
      //   none, which is the same fault the `version_opened` column had.
      EFFECTIVE_DATE: mssql.Date,
      CREATION_DATE: mssql.Date,
      STATUS: mssql.NVarChar(4),
      ENTERED_DR: mssql.Float,
      ENTERED_CR: mssql.Float,
      ACCOUNTED_DR: mssql.Float,
      ACCOUNTED_CR: mssql.Float,
      DESCRIPTION: mssql.NVarChar(500),
      LINE_TYPE_CODE: mssql.NVarChar(60),
      INVOICE_IDENTIFIER: mssql.NVarChar(100),
      INVOICE_AMOUNT: mssql.Float,
    },
  }),
);

// ---------------------------------------------------------------------------
// ★★ THE AP OBJECTS — AND THE SCOPE IS WHAT MAKES THEM COPYABLE.
//
//   `/api/ap/invoices` and `/api/ap/checks` read four `WCSEXP_AP_*` objects that were
//   never copied, so both endpoints 500 with `Invalid object name`. (They ALSO needed
//   the `TO_CHAR`/`TO_DATE` rewrite in the driver — two independent blockers, and
//   fixing one revealed the other.)
//
//   ★ THE UNFILTERED SIZES SAY "DO NOT COPY THIS":
//
//       WCSEXP_AP_INVOICES            2,569,411
//       WCSEXP_AP_CHECKS              1,246,676
//       WCSEXP_AP_INVOICE_PAYMENTS    2,653,590
//       AP_INVOICE_DISTRIBUTIONS_ALL  6,928,673
//
//   ★ AND THE FUND-04 SCOPE SAYS THE OPPOSITE — MEASURED, not hoped:
//
//       AP_INVOICE_DISTRIBUTIONS_ALL  474,254   (93% smaller)
//       fund 04 + program 861/862/863 174,854   (97% smaller)
//       WCSEXP_AP_INVOICES             56,148
//       WCSEXP_AP_INVOICE_PAYMENTS     58,528
//
//   So the filter turns a six-million-row transfer into a ~290k-row one, which is
//   the same order as the `GL_JE_LINES` copy that took about a minute.
//
//   ★ THE SCOPE IS A JOIN, BECAUSE THE VIEWS CARRY NO ACCOUNT SEGMENT. The route's
//     own doc block says so, and it is why every predicate below reaches
//     `GL_CODE_COMBINATIONS` through `AP_INVOICE_DISTRIBUTIONS_ALL`:
//
//         distribution.DIST_CODE_COMBINATION_ID → combination.SEGMENT1 = '04'
//
//     ★ THE COLUMN IS `DIST_CODE_COMBINATION_ID`, NOT `CODE_COMBINATION_ID`. A first
//       guess at the name raises ORA-00904, and `ALL_TAB_COLUMNS` returns 0 rows for
//       this table — the dictionary blindness recorded elsewhere in this repo.
//
//   ★ AND THE CHECKS ARE SCOPED THROUGH THE PAYMENT LINK, NOT THE INVOICE. A check
//     has no invoice id of its own; `WCSEXP_AP_INVOICE_PAYMENTS` is what joins them.
//     Scoping checks by any other route would either miss them or include every
//     check ever written.
//
//   ★ `AP_INVOICE_LINES_ALL` IS DELIBERATELY NOT COPIED. It is 6,239,905 rows, the
//     route uses it only for the invoice→order link, and the user's decision was to
//     take the four views plus the distributions table. Its absence is a named
//     failure if that link is ever needed, not a silent wrong answer.
// ---------------------------------------------------------------------------

/** The scoped invoice ids, as a predicate every AP copy below reuses. */
const SCOPED_INVOICE_IDS = `SELECT DISTINCT d.INVOICE_ID
     FROM AP_INVOICE_DISTRIBUTIONS_ALL d
     JOIN GL_CODE_COMBINATIONS c ON c.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
    WHERE c.SEGMENT1 = '04' AND c.SEGMENT3 IN ('861', '862', '863')`;

results.push(
  await copyTable({
    name: 'WCSEXP_AP_INVOICES',
    select: `SELECT INVOICE_ID, INVOICE_NUM, VENDOR_ID, VENDOR_SITE_ID, INVOICE_AMOUNT,
                    AMOUNT_PAID, INVOICE_DATE, DESCRIPTION, TAX_AMOUNT,
                    PAYMENT_STATUS_FLAG, PO_HEADER_ID
               FROM WCSEXP_AP_INVOICES
              WHERE INVOICE_ID IN (${SCOPED_INVOICE_IDS})`,
    createSql: `CREATE TABLE dbo.WCSEXP_AP_INVOICES (
      INVOICE_ID BIGINT NOT NULL PRIMARY KEY, INVOICE_NUM NVARCHAR(60) NULL,
      VENDOR_ID BIGINT NULL, VENDOR_SITE_ID BIGINT NULL,
      INVOICE_AMOUNT FLOAT NULL, AMOUNT_PAID FLOAT NULL,
      INVOICE_DATE DATE NULL, DESCRIPTION NVARCHAR(500) NULL,
      TAX_AMOUNT FLOAT NULL, PAYMENT_STATUS_FLAG NVARCHAR(4) NULL,
      PO_HEADER_ID BIGINT NULL)`,
    // ★ `Date`, NOT `DateTime2`: the Oracle column is a DATE and the driver returns
    //   `"2000-06-22"`. Declaring DATETIME2 would store midnight and render a time on
    //   a column that has none — the fault `version_opened` had.
    types: {
      INVOICE_ID: mssql.BigInt,
      INVOICE_NUM: mssql.NVarChar(60),
      VENDOR_ID: mssql.BigInt,
      VENDOR_SITE_ID: mssql.BigInt,
      INVOICE_AMOUNT: mssql.Float,
      AMOUNT_PAID: mssql.Float,
      INVOICE_DATE: mssql.Date,
      DESCRIPTION: mssql.NVarChar(500),
      TAX_AMOUNT: mssql.Float,
      PAYMENT_STATUS_FLAG: mssql.NVarChar(4),
      PO_HEADER_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'WCSEXP_AP_CHECKS',
    // ★★ A JOIN, NOT A NESTED `IN` — AND THE FIRST VERSION WAS THE `IN`.
    //
    //    The obvious scoping is
    //
    //        WHERE CHECK_ID IN (
    //          SELECT p.CHECK_ID FROM WCSEXP_AP_INVOICE_PAYMENTS p
    //           WHERE p.INVOICE_ID IN (SELECT DISTINCT d.INVOICE_ID FROM …))
    //
    //    which is a nested subquery over a 1.2M-row view and a 2.6M-row view. It ran
    //    for many minutes without returning, and the copy appeared to hang — the
    //    output stopped after the previous table's header and never reached this one.
    //
    //    ★ THE JOIN FORM LETS THE OPTIMISER DRIVE FROM THE SMALL SIDE. `DISTINCT` on
    //      the scoped invoices is ~56k rows, and joining it to the payment links is a
    //      hash join rather than a repeated `IN` probe. Same rows, and it returns.
    //
    //    ★ `DISTINCT` IS NOT DECORATION. An invoice can be paid by several checks, so
    //      the join fans out; without it the copy would try to insert the same
    //      `CHECK_ID` repeatedly and fail on the primary key — a failure that names a
    //      constraint rather than the missing `DISTINCT`.
    select: `SELECT DISTINCT ck.CHECK_ID, ck.CHECK_NUMBER, ck.CHECK_DATE, ck.AMOUNT
               FROM WCSEXP_AP_CHECKS ck
               JOIN WCSEXP_AP_INVOICE_PAYMENTS p ON p.CHECK_ID = ck.CHECK_ID
               JOIN (${SCOPED_INVOICE_IDS}) s ON s.INVOICE_ID = p.INVOICE_ID`,
    createSql: `CREATE TABLE dbo.WCSEXP_AP_CHECKS (
      CHECK_ID BIGINT NOT NULL PRIMARY KEY, CHECK_NUMBER NVARCHAR(60) NULL,
      CHECK_DATE DATE NULL, AMOUNT FLOAT NULL)`,
    types: {
      CHECK_ID: mssql.BigInt,
      CHECK_NUMBER: mssql.NVarChar(60),
      CHECK_DATE: mssql.Date,
      AMOUNT: mssql.Float,
    },
  }),
);

results.push(
  await copyTable({
    name: 'WCSEXP_AP_INVOICE_PAYMENTS',
    select: `SELECT INVOICE_PAYMENT_ID, INVOICE_ID, PAYMENT_NUM, CHECK_ID
               FROM WCSEXP_AP_INVOICE_PAYMENTS
              WHERE INVOICE_ID IN (${SCOPED_INVOICE_IDS})`,
    createSql: `CREATE TABLE dbo.WCSEXP_AP_INVOICE_PAYMENTS (
      INVOICE_PAYMENT_ID BIGINT NOT NULL PRIMARY KEY, INVOICE_ID BIGINT NULL,
      PAYMENT_NUM BIGINT NULL, CHECK_ID BIGINT NULL)`,
    types: {
      INVOICE_PAYMENT_ID: mssql.BigInt,
      INVOICE_ID: mssql.BigInt,
      PAYMENT_NUM: mssql.BigInt,
      CHECK_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'AP_INVOICE_DISTRIBUTIONS_ALL',
    select: `SELECT d.INVOICE_DISTRIBUTION_ID, d.INVOICE_ID, d.DIST_CODE_COMBINATION_ID,
                    d.AMOUNT, d.DISTRIBUTION_LINE_NUMBER
               FROM AP_INVOICE_DISTRIBUTIONS_ALL d
               JOIN GL_CODE_COMBINATIONS c ON c.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
              WHERE c.SEGMENT1 = '04' AND c.SEGMENT3 IN ('861', '862', '863')`,
    createSql: `CREATE TABLE dbo.AP_INVOICE_DISTRIBUTIONS_ALL (
      INVOICE_DISTRIBUTION_ID BIGINT NOT NULL PRIMARY KEY,
      INVOICE_ID BIGINT NULL, DIST_CODE_COMBINATION_ID BIGINT NULL,
      AMOUNT FLOAT NULL, DISTRIBUTION_LINE_NUMBER BIGINT NULL)`,
    types: {
      INVOICE_DISTRIBUTION_ID: mssql.BigInt,
      INVOICE_ID: mssql.BigInt,
      DIST_CODE_COMBINATION_ID: mssql.BigInt,
      AMOUNT: mssql.Float,
      DISTRIBUTION_LINE_NUMBER: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'WCSEXP_PO_VENDOR_SITES',
    select: `SELECT VENDOR_SITE_ID, VENDOR_ID, VENDOR_SITE_CODE, ADDRESS_LINE1,
                    ADDRESS_LINE2, ADDRESS_LINE3, CITY, STATE, ZIP,
                    AREA_CODE, PHONE, CUSTOMER_NUM
               FROM WCSEXP_PO_VENDOR_SITES`,
    createSql: `CREATE TABLE dbo.WCSEXP_PO_VENDOR_SITES (
      VENDOR_SITE_ID BIGINT NOT NULL PRIMARY KEY, VENDOR_ID BIGINT NULL,
      VENDOR_SITE_CODE NVARCHAR(60) NULL, ADDRESS_LINE1 NVARCHAR(240) NULL,
      ADDRESS_LINE2 NVARCHAR(240) NULL, ADDRESS_LINE3 NVARCHAR(240) NULL,
      CITY NVARCHAR(60) NULL, STATE NVARCHAR(60) NULL, ZIP NVARCHAR(30) NULL,
      AREA_CODE NVARCHAR(30) NULL, PHONE NVARCHAR(60) NULL, CUSTOMER_NUM NVARCHAR(60) NULL)`,
    // ★ NOT SCOPED, AND IT CANNOT BE. A vendor site carries no account, so there is
    //   no join that would narrow it. 99,316 rows is small enough that copying it
    //   whole is cheaper than inventing a scope — and a scoped copy would silently
    //   drop the site of any vendor whose invoice is in scope.
    types: {
      VENDOR_SITE_ID: mssql.BigInt,
      VENDOR_ID: mssql.BigInt,
      VENDOR_SITE_CODE: mssql.NVarChar(60),
      ADDRESS_LINE1: mssql.NVarChar(240),
      ADDRESS_LINE2: mssql.NVarChar(240),
      ADDRESS_LINE3: mssql.NVarChar(240),
      CITY: mssql.NVarChar(60),
      STATE: mssql.NVarChar(60),
      ZIP: mssql.NVarChar(30),
      AREA_CODE: mssql.NVarChar(30),
      PHONE: mssql.NVarChar(60),
      CUSTOMER_NUM: mssql.NVarChar(60),
    },
  }),
);

results.push(
  await copyTable({
    name: 'AP_INVOICE_LINES_ALL',
    select: `SELECT l.INVOICE_ID, l.LINE_NUMBER, l.PO_HEADER_ID, l.PO_LINE_ID,
                    l.AMOUNT, l.DESCRIPTION
               FROM AP_INVOICE_LINES_ALL l
              WHERE l.INVOICE_ID IN (${SCOPED_INVOICE_IDS})`,
    createSql: `CREATE TABLE dbo.AP_INVOICE_LINES_ALL (
      INVOICE_ID BIGINT NOT NULL, LINE_NUMBER BIGINT NOT NULL,
      PO_HEADER_ID BIGINT NULL, PO_LINE_ID BIGINT NULL,
      AMOUNT FLOAT NULL, DESCRIPTION NVARCHAR(500) NULL,
      CONSTRAINT PK_AP_INVOICE_LINES_ALL PRIMARY KEY (INVOICE_ID, LINE_NUMBER))`,
    // ★★ SIX COLUMNS OUT OF 202, AND THE SCOPE IS WHAT MAKES IT COPYABLE.
    //
    //   Unscoped this table is 6,239,905 rows — the one the user said to skip. MEASURED
    //   for the fund-04 / program-861-863 scope it is **162,639**, which is 97% smaller
    //   and smaller than the distributions table already copied. The raw size said no;
    //   the scoped size says yes, and the scope is the same predicate every other AP
    //   copy uses.
    //
    //   ★ THE TWO COLUMNS THE ROUTE ACTUALLY READS ARE `PO_HEADER_ID` (the order link)
    //     AND `INVOICE_ID` (the join). `LINE_NUMBER` is the other half of the key.
    //     `AMOUNT` and `DESCRIPTION` are carried because they are the two a reader
    //     would want next and they cost nothing at this size — but the route's own
    //     `SELECT` names only the first three, so the extra two are available rather
    //     than required.
    //
    //   ★ THE LINK IS REAL, NOT A COLUMN OF NULLS: measured, **115,168 of the 162,639**
    //     scoped lines carry a `PO_HEADER_ID` (71%). That is why this table is worth
    //     copying at all — `PO_NUMBER` and `PO_COUNT` on the invoice page come from it,
    //     and `AP_INVOICE_DISTRIBUTIONS_ALL` cannot supply them (it has no
    //     `PO_HEADER_ID` column at all — ORA-00904).
    //
    //   ★ THE KEY IS COMPOSITE AND WAS VERIFIED UNIQUE: 162,639 rows, 162,639 distinct
    //     `(INVOICE_ID, LINE_NUMBER)` pairs.
    types: {
      INVOICE_ID: mssql.BigInt,
      LINE_NUMBER: mssql.BigInt,
      PO_HEADER_ID: mssql.BigInt,
      PO_LINE_ID: mssql.BigInt,
      AMOUNT: mssql.Float,
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

results.push(
  await copyTable({
    name: 'WCSEXP_PO_VENDORS',
    select: `SELECT VENDOR_ID, VENDOR_NAME, VENDOR_TYPE_LOOKUP_CODE, CUSTOMER_NUM,
                    PARENT_VENDOR_ID
               FROM WCSEXP_PO_VENDORS`,
    createSql: `CREATE TABLE dbo.WCSEXP_PO_VENDORS (
      VENDOR_ID BIGINT NOT NULL PRIMARY KEY, VENDOR_NAME NVARCHAR(240) NULL,
      VENDOR_TYPE_LOOKUP_CODE NVARCHAR(60) NULL, CUSTOMER_NUM NVARCHAR(60) NULL,
      PARENT_VENDOR_ID BIGINT NULL)`,
    // ★ FIVE COLUMNS, NOT THE 79,685-ROW `PO_VENDORS` TABLE'S 100+. The AP routes join
    //   this view for the vendor NAME only, and the view is the narrow shape they
    //   read. Copying `PO_VENDORS` instead would transfer a hundred columns nothing
    //   selects.
    //
    //   ★ NOT SCOPED, AND IT CANNOT BE. A vendor carries no account, so there is no
    //     join that would narrow it — the same reasoning as `WCSEXP_PO_VENDOR_SITES`.
    //     At 79,685 rows it is small enough that a scope would cost more than it saved.
    types: {
      VENDOR_ID: mssql.BigInt,
      VENDOR_NAME: mssql.NVarChar(240),
      VENDOR_TYPE_LOOKUP_CODE: mssql.NVarChar(60),
      CUSTOMER_NUM: mssql.NVarChar(60),
      PARENT_VENDOR_ID: mssql.BigInt,
    },
  }),
);

results.push(
  await copyTable({
    name: 'FND_CURRENCIES',
    select: `SELECT CURRENCY_CODE, DESCRIPTION, SYMBOL, ENABLED_FLAG
               FROM FND_CURRENCIES`,
    createSql: `CREATE TABLE dbo.FND_CURRENCIES (
      CURRENCY_CODE NVARCHAR(20) NOT NULL PRIMARY KEY, DESCRIPTION NVARCHAR(500) NULL,
      SYMBOL NVARCHAR(20) NULL, ENABLED_FLAG NVARCHAR(2) NULL)`,
    // ★ NO `NAME` COLUMN — `DESCRIPTION` AND `SYMBOL` ARE WHAT IT HAS.
    //   Measured across the table's 59 columns. Same class of error as
    //   `GL_BUDGET_ENTITIES` above: a plausible column name that does not exist,
    //   reported as `ORA-00904: "NAME": invalid identifier`.
    types: {
      CURRENCY_CODE: mssql.NVarChar(20),
      DESCRIPTION: mssql.NVarChar(500),
      SYMBOL: mssql.NVarChar(20),
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'FND_ID_FLEX_STRUCTURES',
    select: `SELECT ID_FLEX_NUM, ID_FLEX_CODE, APPLICATION_ID, ID_FLEX_STRUCTURE_CODE, ENABLED_FLAG
               FROM FND_ID_FLEX_STRUCTURES`,
    createSql: `CREATE TABLE dbo.FND_ID_FLEX_STRUCTURES (
      ID_FLEX_NUM BIGINT NOT NULL, ID_FLEX_CODE NVARCHAR(20) NOT NULL,
      ID_FLEX_STRUCTURE_CODE NVARCHAR(60) NOT NULL, APPLICATION_ID BIGINT NOT NULL,
      ENABLED_FLAG NVARCHAR(2) NULL,
      CONSTRAINT PK_FND_ID_FLEX_STRUCTURES
        PRIMARY KEY (ID_FLEX_NUM, ID_FLEX_CODE, ID_FLEX_STRUCTURE_CODE, APPLICATION_ID))`,
    // ★★ THE KEY IS FOUR COLUMNS, AND EACH NARROWER GUESS WAS REJECTED BY THE DATA.
    //
    //    Measured on the 244 rows:
    //      distinct ID_FLEX_NUM                                          = 175
    //      distinct (ID_FLEX_NUM, ID_FLEX_CODE)                          = 243
    //      distinct (…, ID_FLEX_STRUCTURE_CODE)                          = 243
    //      distinct (…, ID_FLEX_STRUCTURE_CODE, APPLICATION_ID)          = **244**
    //
    //    ★ 243 OF 244 IS THE INTERESTING NUMBER, AND IT IS WHY THE FIRST ATTEMPT
    //      FAILED. `ID_FLEX_NUM` alone was rejected by the data immediately (175 of
    //      244 — a clear signal), but `(NUM, CODE)` is unique on *243* of 244 rows,
    //      so it looks like a key and fails on exactly one row with **Msg 2627**. A
    //      near-miss composite key is the hardest kind to spot, because the first
    //      243 rows insert cleanly.
    //
    //    ★ THE ROW THAT BREAKS IT is `ID_FLEX_NUM = 1`, which carries both
    //      `('RLOC', 'NO_VALIDATION_-_COUNTRY')` and another structure under the
    //      same num and code — the application distinguishes them, which is why
    //      `APPLICATION_ID` is part of the key rather than decoration.
    //
    //    ★ AND `APPLICATION_ID` IS DECLARED NOT NULL HERE, unlike the other tables'
    //      nullable id columns: a column in a PRIMARY KEY cannot be nullable, and
    //      the source has no nulls in it.
    types: {
      ID_FLEX_NUM: mssql.BigInt,
      ID_FLEX_CODE: mssql.NVarChar(20),
      ID_FLEX_STRUCTURE_CODE: mssql.NVarChar(60),
      APPLICATION_ID: mssql.BigInt,
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'FND_ID_FLEX_SEGMENTS',
    select: `SELECT ID_FLEX_NUM, ID_FLEX_CODE, APPLICATION_ID, SEGMENT_NUM,
                    SEGMENT_NAME, APPLICATION_COLUMN_NAME, FLEX_VALUE_SET_ID,
                    DISPLAY_SIZE, REQUIRED_FLAG, ENABLED_FLAG
               FROM FND_ID_FLEX_SEGMENTS`,
    createSql: `CREATE TABLE dbo.FND_ID_FLEX_SEGMENTS (
      ID_FLEX_NUM BIGINT NOT NULL, ID_FLEX_CODE NVARCHAR(20) NOT NULL,
      SEGMENT_NUM BIGINT NOT NULL, APPLICATION_COLUMN_NAME NVARCHAR(60) NOT NULL,
      APPLICATION_ID BIGINT NULL, SEGMENT_NAME NVARCHAR(120) NULL,
      FLEX_VALUE_SET_ID BIGINT NULL, DISPLAY_SIZE BIGINT NULL,
      REQUIRED_FLAG NVARCHAR(2) NULL, ENABLED_FLAG NVARCHAR(2) NULL,
      CONSTRAINT PK_FND_ID_FLEX_SEGMENTS
        PRIMARY KEY (ID_FLEX_NUM, ID_FLEX_CODE, SEGMENT_NUM, APPLICATION_COLUMN_NAME))`,
    // ★★ THE KEY IS FOUR COLUMNS, AND I ASSUMED TWO — MEASURED, NOT GUESSED.
    //
    //    Measured on the 1,247 rows:
    //      distinct (ID_FLEX_NUM, ID_FLEX_CODE)                    = **204**
    //      distinct (…, SEGMENT_NUM)                               = 1,246
    //      distinct (…, SEGMENT_NUM, APPLICATION_COLUMN_NAME)      = **1,247**
    //
    //    So `(ID_FLEX_NUM, ID_FLEX_CODE)` is not a key at all — it is the
    //    flexfield, and one flexfield carries many segments. The note that used to
    //    be here said "one `ID_FLEX_NUM` carries six rows across five flexfield
    //    codes", which was true and pointed at the wrong conclusion: the missing
    //    columns are `SEGMENT_NUM` and `APPLICATION_COLUMN_NAME`.
    //
    //    ★ THE THIRD COLUMN ALONE IS NOT ENOUGH EITHER (1,246 of 1,247), so the
    //      key needs the application column too. Each step was measured rather
    //      than assumed, which is the only way a composite key can be settled.
    types: {
      ID_FLEX_NUM: mssql.BigInt,
      ID_FLEX_CODE: mssql.NVarChar(20),
      SEGMENT_NUM: mssql.BigInt,
      APPLICATION_COLUMN_NAME: mssql.NVarChar(60),
      APPLICATION_ID: mssql.BigInt,
      SEGMENT_NAME: mssql.NVarChar(120),
      FLEX_VALUE_SET_ID: mssql.BigInt,
      DISPLAY_SIZE: mssql.BigInt,
      REQUIRED_FLAG: mssql.NVarChar(2),
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'FND_FLEX_VALUES',
    select: `SELECT FLEX_VALUE_SET_ID, FLEX_VALUE_ID, FLEX_VALUE, ENABLED_FLAG,
                    SUMMARY_FLAG, START_DATE_ACTIVE, END_DATE_ACTIVE
               FROM FND_FLEX_VALUES`,
    createSql: `CREATE TABLE dbo.FND_FLEX_VALUES (
      FLEX_VALUE_ID BIGINT NOT NULL PRIMARY KEY, FLEX_VALUE_SET_ID BIGINT NULL,
      FLEX_VALUE NVARCHAR(120) NULL, ENABLED_FLAG NVARCHAR(2) NULL,
      SUMMARY_FLAG NVARCHAR(2) NULL, START_DATE_ACTIVE DATETIME2 NULL,
      END_DATE_ACTIVE DATETIME2 NULL)`,
    // ★ 41,877 ROWS. Read by `/api/coa/levels` for the value-set counts and by
    //   the legend join.
    //
    //   ★ `DESCRIPTION` IS NOT IN THE SELECTION, AND THAT IS THE POINT. The
    //     seeded `V_SEGMENT_LEGEND` selects `fv.DESCRIPTION`, and this table has
    //     **no such column** — `ORA-00904` measured. The name lives on
    //     `FND_FLEX_VALUES_TL`, which is copied next. Copying a column that does
    //     not exist is impossible; copying the one that does, and joining to the
    //     `_TL` table for the name, is what `derived.ts` already does.
    types: {
      FLEX_VALUE_ID: mssql.BigInt,
      FLEX_VALUE_SET_ID: mssql.BigInt,
      FLEX_VALUE: mssql.NVarChar(120),
      ENABLED_FLAG: mssql.NVarChar(2),
      SUMMARY_FLAG: mssql.NVarChar(2),
      START_DATE_ACTIVE: mssql.DateTime2,
      END_DATE_ACTIVE: mssql.DateTime2,
    },
  }),
);

results.push(
  await copyTable({
    name: 'FND_FLEX_VALUES_TL',
    select: `SELECT FLEX_VALUE_ID, LANGUAGE, DESCRIPTION, FLEX_VALUE_MEANING
               FROM FND_FLEX_VALUES_TL`,
    createSql: `CREATE TABLE dbo.FND_FLEX_VALUES_TL (
      FLEX_VALUE_ID BIGINT NOT NULL, LANGUAGE NVARCHAR(10) NOT NULL,
      DESCRIPTION NVARCHAR(500) NULL, FLEX_VALUE_MEANING NVARCHAR(240) NULL,
      CONSTRAINT PK_FND_FLEX_VALUES_TL PRIMARY KEY (FLEX_VALUE_ID, LANGUAGE))`,
    // ★ 42,031 ROWS — THE TABLE THAT ACTUALLY HOLDS THE LEVEL NAMES.
    //   `derived.ts`'s `legendFragment` joins it on `FLEX_VALUE_ID` +
    //   `LANGUAGE = 'US'`, and that join is what turns 829 null level names into
    //   829 real ones. The composite key is the table's own grain: one row per
    //   value per language.
    //
    //   ★ IT HAS NO `FLEX_VALUE` COLUMN — it has `FLEX_VALUE_MEANING`. Measured
    //     across its 12 columns; the copy answered
    //     `ORA-00904: "FLEX_VALUE": invalid identifier` until this was corrected.
    //     The DESCRIPTION is what the legend reads, so the extra column is
    //     carried for completeness rather than for the join.
    types: {
      FLEX_VALUE_ID: mssql.BigInt,
      LANGUAGE: mssql.NVarChar(10),
      DESCRIPTION: mssql.NVarChar(500),
      FLEX_VALUE_MEANING: mssql.NVarChar(240),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_AGENTS',
    select: `SELECT AGENT_ID, LOCATION_ID, CATEGORY_ID, AUTHORIZATION_LIMIT,
                    START_DATE_ACTIVE, END_DATE_ACTIVE, IS_CONTRACT_OFFICER
               FROM PO_AGENTS`,
    createSql: `CREATE TABLE dbo.PO_AGENTS (
      AGENT_ID BIGINT NOT NULL PRIMARY KEY, LOCATION_ID BIGINT NULL,
      CATEGORY_ID BIGINT NULL, AUTHORIZATION_LIMIT FLOAT NULL,
      START_DATE_ACTIVE DATETIME2 NULL, END_DATE_ACTIVE DATETIME2 NULL,
      IS_CONTRACT_OFFICER NVARCHAR(2) NULL)`,
    // ★★ NO `NAME` AND NO `DESCRIPTION` — MEASURED ACROSS ITS 33 COLUMNS.
    //
    //    This is the more interesting kind of wrong guess: `PO_AGENTS` sounds like
    //    a table of people with names, and the route reads it as
    //    `a.NAME AS agent_name`. **The route's expectation is what is wrong**, not
    //    the copy — a buyer is identified by a `LOCATION_ID` and a `CATEGORY_ID`,
    //    and the person's name lives elsewhere (there is no `PER_PEOPLE` in the
    //    granted set).
    //
    //    ★ SO THE COPY CARRIES WHAT THE TABLE HAS, and `ledgerPlan` will report
    //      `NAME` as an unreadable declared column and serve it as null — which is
    //      the honest outcome the resolution machinery was built for. Inventing a
    //      `NAME` column here would make the copy succeed and the endpoint lie.
    types: {
      AGENT_ID: mssql.BigInt,
      LOCATION_ID: mssql.BigInt,
      CATEGORY_ID: mssql.BigInt,
      AUTHORIZATION_LIMIT: mssql.Float,
      START_DATE_ACTIVE: mssql.DateTime2,
      END_DATE_ACTIVE: mssql.DateTime2,
      IS_CONTRACT_OFFICER: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_LINE_TYPES',
    select: `SELECT LINE_TYPE_ID, LINE_TYPE, DESCRIPTION
               FROM PO_LINE_TYPES`,
    createSql: `CREATE TABLE dbo.PO_LINE_TYPES (
      LINE_TYPE_ID BIGINT NOT NULL PRIMARY KEY, LINE_TYPE NVARCHAR(60) NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    types: {
      LINE_TYPE_ID: mssql.BigInt,
      LINE_TYPE: mssql.NVarChar(60),
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PO_LOOKUP_CODES',
    select: `SELECT LOOKUP_TYPE, LOOKUP_CODE, DISPLAYED_FIELD, DESCRIPTION, ENABLED_FLAG
               FROM PO_LOOKUP_CODES`,
    createSql: `CREATE TABLE dbo.PO_LOOKUP_CODES (
      LOOKUP_TYPE NVARCHAR(60) NOT NULL, LOOKUP_CODE NVARCHAR(60) NOT NULL,
      DISPLAYED_FIELD NVARCHAR(160) NULL, DESCRIPTION NVARCHAR(500) NULL,
      ENABLED_FLAG NVARCHAR(2) NULL,
      CONSTRAINT PK_PO_LOOKUP_CODES PRIMARY KEY (LOOKUP_TYPE, LOOKUP_CODE))`,
    // ★ `DISPLAYED_FIELD`, NOT `MEANING` — measured across its 31 columns.
    //   `GL_LOOKUPS` has a `MEANING` column and this one does not, which is exactly
    //   the kind of near-identical-table difference that makes an assumed column
    //   list fail on one of the two. The copy answered
    //   `ORA-00904: "MEANING": invalid identifier`.
    //
    //   ★ THE KEY IS UNIQUE CASE-INSENSITIVELY TOO, unlike `GL_LOOKUPS`: measured
    //     82,438 rows and 82,438 distinct BOTH ways, so no collation is needed here.
    types: {
      LOOKUP_TYPE: mssql.NVarChar(60),
      LOOKUP_CODE: mssql.NVarChar(60),
      DISPLAYED_FIELD: mssql.NVarChar(160),
      DESCRIPTION: mssql.NVarChar(500),
      ENABLED_FLAG: mssql.NVarChar(2),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PA_TASKS',
    allowEmpty: true,
    select: `SELECT TASK_ID, PROJECT_ID, TASK_NUMBER, TASK_NAME, DESCRIPTION
               FROM PA_TASKS`,
    createSql: `CREATE TABLE dbo.PA_TASKS (
      TASK_ID BIGINT NOT NULL PRIMARY KEY, PROJECT_ID BIGINT NULL,
      TASK_NUMBER NVARCHAR(60) NULL, TASK_NAME NVARCHAR(240) NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    types: {
      TASK_ID: mssql.BigInt,
      PROJECT_ID: mssql.BigInt,
      TASK_NUMBER: mssql.NVarChar(60),
      TASK_NAME: mssql.NVarChar(240),
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PA_BUDGET_VERSIONS',
    allowEmpty: true,
    select: `SELECT BUDGET_VERSION_ID, PROJECT_ID, BUDGET_TYPE_CODE, VERSION_NUMBER,
                    BUDGET_STATUS_CODE, VERSION_NAME, DESCRIPTION
               FROM PA_BUDGET_VERSIONS`,
    createSql: `CREATE TABLE dbo.PA_BUDGET_VERSIONS (
      BUDGET_VERSION_ID BIGINT NOT NULL PRIMARY KEY, PROJECT_ID BIGINT NULL,
      BUDGET_TYPE_CODE NVARCHAR(60) NULL, VERSION_NUMBER NVARCHAR(60) NULL,
      BUDGET_STATUS_CODE NVARCHAR(60) NULL, VERSION_NAME NVARCHAR(240) NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    // ★ `BUDGET_STATUS_CODE`, NOT `STATUS_CODE` — measured across its 108 columns.
    //   `VERSION_NAME` is also carried because it is the human label for the
    //   version; `VERSION_NUMBER` is the ordinal.
    types: {
      BUDGET_VERSION_ID: mssql.BigInt,
      PROJECT_ID: mssql.BigInt,
      BUDGET_TYPE_CODE: mssql.NVarChar(60),
      VERSION_NUMBER: mssql.NVarChar(60),
      BUDGET_STATUS_CODE: mssql.NVarChar(60),
      VERSION_NAME: mssql.NVarChar(240),
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

results.push(
  await copyTable({
    name: 'PA_BUDGET_LINES',
    allowEmpty: true,
    select: `SELECT BUDGET_LINE_ID, BUDGET_VERSION_ID, CODE_COMBINATION_ID,
                    PERIOD_NAME, RAW_COST, BURDENED_COST, REVENUE, DESCRIPTION
               FROM PA_BUDGET_LINES`,
    createSql: `CREATE TABLE dbo.PA_BUDGET_LINES (
      BUDGET_LINE_ID BIGINT NOT NULL PRIMARY KEY, BUDGET_VERSION_ID BIGINT NULL,
      CODE_COMBINATION_ID BIGINT NULL, PERIOD_NAME NVARCHAR(40) NULL,
      RAW_COST FLOAT NULL, BURDENED_COST FLOAT NULL, REVENUE FLOAT NULL,
      DESCRIPTION NVARCHAR(500) NULL)`,
    // ★★ NO `PROJECT_ID` AND NO `TASK_ID` — MEASURED ACROSS ITS 131 COLUMNS.
    //
    //    `routes/projects.ts` names both, and neither exists here. The line
    //    reaches its project through `BUDGET_VERSION_ID` — the version carries
    //    the `PROJECT_ID` — so the route's expectation is what is wrong, not the
    //    table.
    //
    //    ★ THIS IS THE THIRD TABLE IN THIS COPY WHERE THE ROUTE NAMES A COLUMN THE
    //      TABLE DOES NOT HAVE (`PO_AGENTS.NAME`, `FND_FLEX_VALUES.DESCRIPTION`,
    //      and this). Each one is reported by `ledgerPlan` as an unreadable
    //      declared column and served as null, which is the honest outcome — but
    //      the pattern is worth stating: **the descriptors were written against the
    //      libSQL sample, whose tables were built to match the routes rather than
    //      to match Oracle.**
    //
    //    ★ `ORA-00942` IS WHAT A BAD COLUMN IN A `SELECT` LIST REPORTS, not just a
    //      missing table — which is why this looked like "the table does not exist"
    //      when the table exists and has 0 rows. The probe that settled it compared
    //      the wanted column list against `SELECT * … WHERE 1=0`'s metadata.
    //
    //    ★ ALL THREE MONEY COLUMNS ARE FLOAT, for the reason `DISTRIBUTION_NUM`
    //      was: a budget amount is money, and an INT column would truncate it
    //      silently rather than fail.
    types: {
      BUDGET_LINE_ID: mssql.BigInt,
      BUDGET_VERSION_ID: mssql.BigInt,
      CODE_COMBINATION_ID: mssql.BigInt,
      PERIOD_NAME: mssql.NVarChar(40),
      RAW_COST: mssql.Float,
      BURDENED_COST: mssql.Float,
      REVENUE: mssql.Float,
      DESCRIPTION: mssql.NVarChar(500),
    },
  }),
);

// ---------------------------------------------------------------------------
// ★★ THE LAST SIX: THE EXTRACT VIEW, THE TWO LARGE PO TABLES, AND THE AP PAIR.
//
//   `WCSEXP_PO_HEADERS` is the one `WCSEXP_*` object the app's resolution actually
//   needs — measured by asking `ledgerPlan` for every registered descriptor and
//   collecting the `WCSEXP_` names it produced. The other eighteen views are
//   **not** required, because the resolution prefers the base table and the base
//   tables supply every declared column except the three `EXP_*` ones here.
//
//   The AP pair is large (6.2 M and 6.9 M rows) and only two of its columns are
//   read per table — see the notes on each.
// ---------------------------------------------------------------------------

results.push(
  await copyTable({
    name: 'WCSEXP_PO_HEADERS',
    select: `SELECT PO_HEADER_ID, TYPE_LOOKUP_CODE, PO_NUMBER, VENDOR_ID, VENDOR_SITE_ID,
                    APPROVED_FLAG, APPROVED_DATE, START_DATE_ACTIVE,
                    EXP_PROJECT_NAME, EXP_PO_NUMBER
               FROM WCSEXP_PO_HEADERS`,
    createSql: `CREATE TABLE dbo.WCSEXP_PO_HEADERS (
      PO_HEADER_ID BIGINT NOT NULL PRIMARY KEY, TYPE_LOOKUP_CODE NVARCHAR(60) NULL,
      PO_NUMBER NVARCHAR(60) NULL, VENDOR_ID BIGINT NULL, VENDOR_SITE_ID BIGINT NULL,
      APPROVED_FLAG NVARCHAR(2) NULL, APPROVED_DATE DATETIME2 NULL,
      START_DATE_ACTIVE DATETIME2 NULL, EXP_PROJECT_NAME NVARCHAR(240) NULL,
      EXP_PO_NUMBER NVARCHAR(60) NULL)`,
    // ★★ THIS IS THE ONE `WCSEXP_*` VIEW THAT MUST EXIST, AND IT IS NOT OPTIONAL.
    //
    //    `ledger-shape.ts` declares a divergence for `PO_HEADERS_ALL` whose `from`
    //    is `WCSEXP_PO_HEADERS v JOIN PO_HEADERS_ALL h`, and whose `at` map resolves
    //    `PO_NUMBER`, `EXP_PROJECT_NAME` and `EXP_PO_NUMBER` to `v.…`. So the route
    //    that reads a purchase order **joins this view to the base table** — the two
    //    are not supersets of one another: `PO_HEADERS_ALL` has `AGENT_ID`/`ORG_ID`/
    //    `CANCEL_FLAG` and no `PO_NUMBER`, and this view has `PO_NUMBER`/`EXP_*` and
    //    none of the first three.
    //
    //    ★ 288,056 ROWS — the same count as `PO_HEADERS_ALL`, which is the check
    //      that the join is 1:1 rather than fanning out.
    //
    //    ★ ALL TEN COLUMNS ARE COPIED, unlike the other tables where a hand-picked
    //      subset is used. The view is already a projection built for this purpose,
    //      so there is nothing to trim.
    types: {
      PO_HEADER_ID: mssql.BigInt,
      TYPE_LOOKUP_CODE: mssql.NVarChar(60),
      PO_NUMBER: mssql.NVarChar(60),
      VENDOR_ID: mssql.BigInt,
      VENDOR_SITE_ID: mssql.BigInt,
      APPROVED_FLAG: mssql.NVarChar(2),
      APPROVED_DATE: mssql.DateTime2,
      START_DATE_ACTIVE: mssql.DateTime2,
      EXP_PROJECT_NAME: mssql.NVarChar(240),
      EXP_PO_NUMBER: mssql.NVarChar(60),
    },
  }),
);

results.push(
  await copyTable({
    name: 'AP_INVOICE_DISTRIBUTIONS_ALL',
    select: `SELECT INVOICE_DISTRIBUTION_ID, INVOICE_ID, DIST_CODE_COMBINATION_ID, AMOUNT
               FROM AP_INVOICE_DISTRIBUTIONS_ALL`,
    createSql: `CREATE TABLE dbo.AP_INVOICE_DISTRIBUTIONS_ALL (
      INVOICE_DISTRIBUTION_ID BIGINT NOT NULL PRIMARY KEY, INVOICE_ID BIGINT NULL,
      DIST_CODE_COMBINATION_ID BIGINT NULL, AMOUNT FLOAT NULL)`,
    // ★★ THE SCOPE KEY, AND ITS NAME IS NOT GUESSABLE.
    //
    //    `DIST_CODE_COMBINATION_ID` — **not** `CODE_COMBINATION_ID`, which raises
    //    ORA-00904 here. `ALL_TAB_COLUMNS` returns **zero rows** for this table
    //    while a qualified `SELECT` reads it fine, so the name had to come from
    //    result metadata rather than the dictionary. That is recorded in
    //    `routes/ap.ts` and in `store.ts`'s registry comment, and it is the reason
    //    this column is spelled out rather than assumed.
    //
    //    ★ THIS IS THE TABLE THE SCOPE GOES THROUGH. Measured: scoping through the
    //      distribution gives **126** invoices — the frozen extract's own count —
    //      while scoping through the line gives **61**, because a line's default
    //      account may differ from where the money was distributed.
    //
    //    ★ 6,928,672 ROWS, FOUR COLUMNS OF 244. `AMOUNT` is carried because the
    //      account rows report it; the rest are not read.
    types: {
      INVOICE_DISTRIBUTION_ID: mssql.BigInt,
      INVOICE_ID: mssql.BigInt,
      DIST_CODE_COMBINATION_ID: mssql.BigInt,
      AMOUNT: mssql.Float,
    },
  }),
);

// ---------------------------------------------------------------------------
// Summary
//
// ★★ A TABLE THAT WAS NOT COPIED MUST NOT PRINT "MATCH".
//
//   The first version of this compared `source` to `dest` and called them equal
//   when both were -1 -- the sentinel used for "not attempted" and for "source
//   failed". So a `--only PO_LINES_ALL` run printed:
//
//       GL_BALANCES              source        -1  dest        -1  MATCH
//       PO_VENDORS               source        -1  dest        -1  MATCH
//       PO_LINES_ALL             source   1141923  dest   1141923  MATCH
//       ALL TABLES COPIED AND VERIFIED
//
//   Three of those four tables were never touched. The line that mattered most --
//   the verdict -- was FALSE, and it was false in the direction that stops a
//   reader looking: a run that copied one table claimed to have verified six.
//
//   ★ -1 IS NOT A COUNT AND MUST NEVER BE COMPARED AS ONE. Each outcome now
//     carries an explicit status, and only `copied` can be verified. The verdict
//     distinguishes three states rather than two, because "did not run" and
//     "ran and failed" are different facts and collapsing them is what produced
//     the false pass.
// ---------------------------------------------------------------------------
say('\n=== SUMMARY ===');
const copied = results.filter((r) => r && r.status === 'copied');
const failed = results.filter((r) => r && r.status === 'failed');
const skipped = results.filter((r) => r && r.status === 'skipped');

for (const r of results) {
  if (!r) continue;
  const mark =
    r.status === 'copied' ? (r.ok ? 'MATCH' : '★ MISMATCH')
    : r.status === 'skipped' ? 'not run (--skip)'
    : '★ FAILED';
  const s = r.status === 'copied' ? String(r.source).padStart(9) : '        -';
  const d = r.status === 'copied' ? String(r.dest).padStart(9) : '        -';
  say(`   ${r.name.padEnd(24)} source ${s}  dest ${d}  ${mark}`);
}

// ★ THE VERDICT NAMES WHAT IT DID NOT DO. A summary that says "all verified"
//   after a partial run is worse than no summary, because it is the line a reader
//   trusts without checking the rows above it.
const mismatched = copied.filter((r) => !r.ok);
const verdict =
  mismatched.length > 0
    ? `★ ${mismatched.length} TABLE(S) DID NOT MATCH: ${mismatched.map((r) => r.name).join(', ')}`
    : failed.length > 0
      ? `★ ${failed.length} TABLE(S) FAILED: ${failed.map((r) => r.name).join(', ')}`
      : skipped.length > 0
        ? `${copied.length} TABLE(S) COPIED AND VERIFIED; ${skipped.length} NOT RUN: ${skipped.map((r) => r.name).join(', ')}`
        : `ALL ${copied.length} TABLES COPIED AND VERIFIED`;
say(`\n   ${verdict}`);

await pool.close();
await closeDb();
process.exit(mismatched.length === 0 && failed.length === 0 ? 0 : 1);
