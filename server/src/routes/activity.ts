import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { execute, rows, type Binds } from '../db/sql.js';
import { storeDriver } from '../db/client.js';
import { config } from '../config/env.js';
import { isAppTable, ensureAppSchema, requireAppSchema } from '../db/app-schema.js';
import { AppError } from '../http/errors.js';

/**
 * The Activity register — an inventory of how many rows each object holds.
 *
 * ★ WHAT THIS PAGE IS, AND WHAT IT USED TO BE. It was a register of *changes*: for
 *   one day, how many rows each table had created and updated. That question can
 *   only be asked of tables carrying a timestamp, and most of the ledger's do not
 *   — `PO_LINES_ALL`, `PO_LINE_LOCATIONS_ALL`, `PO_DISTRIBUTIONS_ALL` and
 *   `PO_LOOKUP_CODES` have no column to filter on, so for them the honest answer
 *   was `null` plus a paragraph explaining why. The page spent most of its height
 *   saying "cannot say", and a reader had to hold three kinds of answer in mind.
 *
 *   It is now an inventory of ROW COUNTS: one figure per object, which every object
 *   can produce, split into the two tabs a reader actually wants — the
 *   application's own tables, and the Oracle/EBS objects beside them.
 *
 * ★ AND THAT MOVE TAKES THE COUNTS INTO THE LEDGER, WHICH INVERTS THE ONE RULE THE
 *   REST OF THIS FILE WAS BUILT ON. Everything else here is read from the **app
 *   store** — a local SQLite file when `DB_MODE=oracle` — because the catalogue has
 *   to be (`sqlite_master` and `pragma_table_info` are SQLite facilities, and
 *   Oracle has nowhere to keep this app's own bookkeeping). Read `appRows` below
 *   for that half, which still holds. But a row count of `AP_INVOICES_ALL` is only
 *   meaningful from the database that holds `AP_INVOICES_ALL`, and the app store
 *   holds a small sample of it, not the ledger. So:
 *
 *     catalogue + recorded readings → the app store, always, by construction
 *     row counts                    → the store that actually contains the object
 *
 * ★ A STORE-ROUTED READER IS THE PRICE OF THAT, AND `appRows` EARNED ITS PLACE THE
 *   HARD WAY. `rows()` routes a statement by the registered table names it
 *   mentions; a name that no literal SQL in the codebase mentions — and a register
 *   built from `sqlite_master` mentions forty-nine of them — falls through to the
 *   default, which is the **ledger**. That is exactly what bit a throwaway probe of
 *   this feature: it read `AP_INVOICES_ALL` as 2,569,410 rows and reported the
 *   ledger's number as though it were the sample's, and nothing in the response
 *   could have told a reader which database had answered. So every statement here
 *   names its store, and the store that answered is published on the row.
 *
 * ★ THE COUNT IS A RECORDED READING, NOT A LIVE ONE — A MEASUREMENT, NOT A TASTE.
 *   Counting the live ledger is a full scan of whichever table is asked: measured
 *   against `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`, the register's own first
 *   two entries alone are `AP_INVOICES_ALL` at 2,569,410 rows and
 *   `AP_INVOICE_PAYMENTS_ALL` at 2,653,590. Doing that on every page load would
 *   make a list of table names the slowest request in the app, and it would return
 *   the same number every time. So the count is taken when somebody asks for it —
 *   the "Record counts now" button — and stored, one row per object per day, in
 *   `table_count_snapshot`. The page then reads a number that is cheap, dated, and
 *   labelled as a reading rather than as "now".
 *
 * ★ A COUNT THAT WAS NEVER TAKEN IS `null`, NOT `0`. A zero would mean "this table
 *   is empty", which is a fact about the database; the absence of a reading is a
 *   fact about this app. The two are indistinguishable on a screen, which is why
 *   every row carries `reading` — the day and the instant the count came from —
 *   and prints "not counted" rather than a figure.
 *
 * ★ AND EVERY READING SAYS WHICH DATABASE TOOK IT. `table_count_snapshot` gained a
 *   `counted_in` column for this, and it is not decoration: the readings this
 *   register already held were taken by the *previous* version of this page from
 *   the *app store*, so serving them under a heading that names the ledger would be
 *   the exact mis-attribution the paragraph above describes, one level down. A
 *   reading with no `counted_in` is a reading from a store this page cannot vouch
 *   for, and the register does not use it. It costs one button press to replace.
 *
 * ★ SCOPED WHERE THE OBJECT CARRIES AN ACCOUNT, AND SAID SO WHERE IT DOES NOT. A
 *   count of the whole ledger is not the question this app asks anywhere else, so
 *   wherever the object has the columns to narrow it, the count is narrowed to fund
 *   `04` and programs `861/862/863`. Two mechanisms, because the data has two
 *   shapes:
 *
 *     own segments — the object carries `SEGMENT1` and `SEGMENT3` itself.
 *     via the CCID — the object carries `CODE_COMBINATION_ID` and the segments live
 *                    in `GL_CODE_COMBINATIONS`, so the count is narrowed by a
 *                    subquery against that table.
 *     neither      — `AP_INVOICES_ALL`, `PO_VENDORS`, `FND_CURRENCIES` and the rest
 *                    carry no account at all. Their count is the whole object, and
 *                    `scoped` is `false` so the page says so instead of implying a
 *                    filter that never ran.
 *
 * ★ THE APP'S OWN TABLES ARE COUNTED IN THE APP STORE, DELIBERATELY. They do not
 *   exist in the ledger and never will — `resolveAppDb` keeps them local precisely
 *   because Oracle has nowhere to put them — so asking the ledger for them would
 *   produce seven `ORA-00942`s and a page that called the app's own tables
 *   unreadable.
 *
 * ★ AND AN OBJECT THE LEDGER WILL NOT READ IS REPORTED, NOT SUBSTITUTED. The
 *   catalogue is built from the sample's schema, so it lists objects this account
 *   cannot read in the live database — a real fact about the account, and worth
 *   showing. There is deliberately **no fallback** to the sample's count: answering
 *   a question about the ledger with the sample's number is the failure described
 *   three paragraphs up. The row says it has no reading and the capture says why.
 */

// ---------------------------------------------------------------------------
// The scope these counts are narrowed to
// ---------------------------------------------------------------------------

/**
 * Fund and programs the counts are narrowed to.
 *
 * ★ THE SAME THREE VALUES EVERY OTHER PAGE FILTERS ON, AND FOR THE SAME REASON. The
 *   rest of the app narrows to one organization's fund and programs, so a row count
 *   covering the whole ledger would be a figure no other screen could reconcile
 *   against its own. They are written here rather than imported because
 *   `derived.ts` resolves a scope per *request* from a tenant row, and this
 *   register has no tenant row: it is a census of the database, and it is asked
 *   before any organization is chosen.
 */
const SCOPE_FUND = '04';
const SCOPE_PROGRAMS = ['861', '862', '863'] as const;

/** The bind values the predicate expects, named once so the two SQL sites agree. */
const SCOPE_ARGS = {
  fund: SCOPE_FUND,
  p1: SCOPE_PROGRAMS[0],
  p2: SCOPE_PROGRAMS[1],
  p3: SCOPE_PROGRAMS[2],
} as const;

/** `SEGMENT1`/`SEGMENT3`, spelled the same way for both stores. */
const SEGMENT_PREDICATE = 'SEGMENT1 = :fund AND SEGMENT3 IN (:p1, :p2, :p3)';

/**
 * Objects in the catalogue that are not part of the register.
 *
 * ★ THE PROVENANCE TABLE IS BOOKKEEPING ABOUT THE SAMPLE, NOT DATA IN IT. Counting
 *   its rows would put a figure on the page describing this app's own bookkeeping
 *   beside forty-eight describing the ledger, and a reader has no way to tell which
 *   is which from the number.
 */
const NOT_ACTIVITY: Record<string, string> = {
  SAMPLE_DATA_PROVENANCE:
    'Bookkeeping about how the sample was built, not a ledger object. Excluded so every ' +
    'count on this page describes the same database.',
};

// ---------------------------------------------------------------------------
// Which store holds what
// ---------------------------------------------------------------------------

export type StoreId = 'app' | 'ledger';

interface ObjectRow {
  name: string;
  type: string;
}

interface ColumnRow {
  object_name: string;
  column_name: string;
  ordinal: number;
}

export interface ActivitySource {
  store: 'app';
  label: string;
  dialect: 'sqlite' | 'oracle' | 'sqlserver';
  ledgerLabel: string;
  sharedWithLedger: boolean;
  countStore: StoreId;
  countLabel: string;
}

/**
 * Which database the row counts come from, and which one only supplied the list.
 *
 * ★ THE PAGE CANNOT BE HONEST ABOUT ITS FIGURES WITHOUT THIS, AND THE SERVER IS THE
 *   ONLY THING THAT KNOWS. Both labels are configuration — a file path, and a host
 *   with a service name — so a client typing them out would be printing a database
 *   name it had no way to check, on a page whose entire subject is which database
 *   each figure came from. In the shipped configuration they are genuinely
 *   different databases: the counts are the ledger's; the catalogue and the
 *   readings are a local SQLite file's.
 */
function activitySource(): ActivitySource {
  const app = storeDriver('app');
  const shared = config.appDb.shared;
  return {
    store: 'app',
    label: config.appDb.label,
    dialect: app.dialect,
    ledgerLabel: config.db.label,
    sharedWithLedger: shared,
    // When the two are the same database there is nothing to distinguish, and the
    // honest answer is that the counts came from that one store.
    countStore: shared ? 'app' : 'ledger',
    countLabel: shared ? config.appDb.label : config.db.label,
  };
}

/**
 * The store a given object's count is taken from.
 *
 * ★ APP-OWNED OBJECTS ARE THE ONLY EXCEPTION, AND IT IS NOT A PREFERENCE. The
 *   ledger has no copy of `app_user` or `table_count_snapshot` — those tables exist
 *   because `resolveAppDb` created them locally — so asking the ledger for them
 *   would report the app's own tables as unreadable.
 */
export function storeFor(name: string): StoreId {
  return isAppTable(name) ? 'app' : activitySource().countStore;
}

/** A quoted identifier. The names come from the catalogue, never from a literal. */
function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** How an object's count can be narrowed to the scope, or that it cannot. */
export type ScopeMode = 'segments' | 'lookup' | null;

/**
 * Which mechanism this object has for narrowing to the scope.
 *
 * ★ READ OFF THE OBJECT'S OWN COLUMNS, NOT FROM A HAND-WRITTEN LIST. A list would
 *   be wrong the moment an extract adds a table, and wrong *silently*: the new
 *   table would simply be counted in full, which looks like every other row. Asking
 *   the catalogue is what `axesFor` did before it, and it leaves nothing to keep in
 *   step.
 *
 * ★ AND THE ORDER MATTERS. An object carrying both its own segments and a
 *   `CODE_COMBINATION_ID` is narrowed by its own columns, because those are
 *   answerable without a join and are what the row actually stores. The lookup is
 *   the fallback for objects carrying only the key.
 */
export function scopeModeFor(columns: readonly string[]): ScopeMode {
  const have = new Set(columns.map((c) => c.toUpperCase()));
  if (have.has('SEGMENT1') && have.has('SEGMENT3')) return 'segments';
  if (have.has('CODE_COMBINATION_ID')) return 'lookup';
  return null;
}

// ---------------------------------------------------------------------------
// Reading a store by door rather than by name
// ---------------------------------------------------------------------------

/**
 * Run one statement against the app store.
 *
 * ★ THIS EXISTS BECAUSE `rows()` CANNOT BE TRUSTED WITH A NAME IT HAS NOT SEEN, and
 *   this register is nothing but names it has not seen. `db/store.ts` routes a
 *   statement by the registered table names it mentions; a name absent from that
 *   registry falls through to the default, which is the ledger. The register's names
 *   come from `sqlite_master` at runtime, so almost every one is absent — meaning
 *   `rows()` would send a `sqlite_master` query to Oracle and answer `ORA-00936`, or
 *   worse, send a query about the sample to the live ledger and answer with the live
 *   ledger's numbers under a heading that said "sample". `storeDriver('app')` names
 *   the store by construction, so there is no name it can misread.
 *
 * ★ THE SAME DOOR IS NOW USED IN BOTH DIRECTIONS, AND THAT IS THIS FEATURE'S CHANGE.
 *   `storeFor` above sends an EBS-shaped object's count to the **ledger**, on
 *   purpose, because that is the database holding it. So the rule is not
 *   "everything goes to the app store" — the rule is "every statement names its
 *   store, and the response says which store it named". A future reader who finds a
 *   ledger statement here and moves it back to `appRows` to restore uniformity would
 *   be restoring the bug that uniformity was hiding.
 */
async function appRows<T>(sql: string, args: Binds = {}): Promise<T[]> {
  const res = await storeDriver('app').execute({ sql, args });
  return res.rows as T[];
}

/** The same, for the ledger — split out so a call site must say which one it means. */
async function ledgerRows<T>(sql: string, args: Binds = {}): Promise<T[]> {
  const res = await storeDriver('ledger').execute({ sql, args });
  return res.rows as T[];
}

/**
 * Refuse the register when the app store has no catalogue.
 *
 * ★ THE QUESTION IS "DOES THE APP STORE HAVE A CATALOGUE?", NOT "IS THIS SERVER
 *   POINTED AT ORACLE?". They have different answers in the shipped configuration:
 *   `DB_MODE=oracle` with a local SQLite app store is perfectly ordinary, and for a
 *   while this route asked the second question, refused the request, and put a 503
 *   on a page whose every query it could already answer.
 */
function requireSqliteCatalogue(): void {
  const app = storeDriver('app');
  if (app.dialect !== 'sqlite') {
    throw new AppError(
      503,
      'DB_UNAVAILABLE',
      `The activity register reads its catalogue from a SQLite app store, but the app store is ${app.dialect}.`,
    );
  }
}

/**
 * Read the live catalogue.
 *
 * From `sqlite_master` rather than from the DDL files, matching
 * `GET /api/meta/dictionary` — the sample is assembled from several extracts of
 * different grains, so the tables that exist are not the ones a name suggests.
 *
 * ★ THE CATALOGUE IS THE ONE THING THAT CANNOT MOVE TO THE LEDGER, AND THE PAGE HAS
 *   TO SAY SO RATHER THAN PRETEND OTHERWISE. Oracle's data dictionary does not
 *   describe what this account can read — measured on this database, `ALL_OBJECTS`,
 *   `ALL_TAB_COLUMNS`, `SESSION_ROLES`, `USER_TAB_PRIVS` and `ROLE_TAB_PRIVS` all
 *   reported nothing for tables a qualified `SELECT` read perfectly. So the object
 *   list is a *declared inventory* taken from the sample's schema, and the counts
 *   are taken from the ledger wherever the ledger will answer. An object on the list
 *   that the ledger does not expose appears with no reading — the honest rendering
 *   of that fact, not a gap to paper over.
 */
async function readCatalogue(): Promise<{ objects: ObjectRow[]; columns: Map<string, ColumnRow[]> }> {
  const objects = await appRows<ObjectRow>(
    `SELECT name, type
       FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC`,
  );

  const columns = await appRows<ColumnRow>(
    `SELECT m.name AS object_name, p.name AS column_name, p.cid AS ordinal
       FROM sqlite_master m
       JOIN pragma_table_info(m.name) p
      WHERE m.type IN ('table', 'view')
        AND m.name NOT LIKE 'sqlite_%'
      ORDER BY m.name ASC, p.cid ASC`,
  );

  const byObject = new Map<string, ColumnRow[]>();
  for (const c of columns) {
    const list = byObject.get(c.object_name);
    if (list) list.push(c);
    else byObject.set(c.object_name, [c]);
  }

  return { objects, columns: byObject };
}

/** The app store's own idea of today, in the server's zone. */
const TODAY_SQL = `date('now', 'localtime')`;

function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** The outcome of trying to count one object. */
export interface CountOutcome {
  name: string;
  store: StoreId;
  scopeMode: ScopeMode;
  /** The scoped count, or null when the object could not be counted. */
  rowCount: number | null;
  /** Why it could not be counted, in the driver's own words. Null when it could. */
  error: string | null;
}

/** One count, from one named store. */
async function countIn(store: StoreId, sql: string, args: Binds): Promise<number> {
  const res =
    store === 'app' ? await appRows<{ n: unknown }>(sql, args) : await ledgerRows<{ n: unknown }>(sql, args);
  const raw = res[0]?.n;
  const n = Number(raw);
  // ★ `Number(null)` IS `0` AND `Number(undefined)` IS `NaN`, SO THE GUARD HAS TO BE
  //   `isFinite` RATHER THAN A NULL CHECK. Without it, a statement that returned no
  //   row at all — the shape a routing mistake takes — would be recorded as a real
  //   count of zero, indistinguishable from a genuinely empty table.
  if (!Number.isFinite(n)) throw new Error(`the count came back as ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Count one object, narrowed to the scope wherever the object allows it.
 *
 * ★ THE LOOKUP TABLE IS READ FROM THE SAME STORE AS THE OBJECT BEING COUNTED, AND
 *   THAT IS NOT A DETAIL. The two stores keep their own `GL_CODE_COMBINATIONS` with
 *   their own `CODE_COMBINATION_ID`s — the sample's ids mean nothing in the ledger.
 *   A subquery written against one and executed in the other would compare two
 *   unrelated sets of keys and return a number wrong in both directions: too small
 *   (ids the other store never issued) and too large (same-numbered ids that mean
 *   something else).
 */
export async function countObject(
  name: string,
  columns: readonly string[],
  store: StoreId,
): Promise<CountOutcome> {
  const mode = scopeModeFor(columns);
  const table = q(name);

  try {
    if (mode === 'segments') {
      const n = await countIn(store, `SELECT COUNT(*) AS n FROM ${table} WHERE ${SEGMENT_PREDICATE}`, {
        ...SCOPE_ARGS,
      });
      return { name, store, scopeMode: mode, rowCount: n, error: null };
    }

    if (mode === 'lookup') {
      const n = await countIn(
        store,
        `SELECT COUNT(*) AS n FROM ${table}
          WHERE CODE_COMBINATION_ID IN (
                SELECT CODE_COMBINATION_ID
                  FROM GL_CODE_COMBINATIONS
                 WHERE ${SEGMENT_PREDICATE})`,
        { ...SCOPE_ARGS },
      );
      return { name, store, scopeMode: mode, rowCount: n, error: null };
    }

    const n = await countIn(store, `SELECT COUNT(*) AS n FROM ${table}`, {});
    return { name, store, scopeMode: null, rowCount: n, error: null };
  } catch (e: unknown) {
    // The first line only: a driver error arrives with a call stack wrapped around
    // it, and the sentence a reader needs is the first one. Truncated because an
    // Oracle error can carry the whole statement back.
    const first = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
    return { name, store, scopeMode: mode, rowCount: null, error: first.slice(0, 200) };
  }
}

/**
 * Count every object in the register.
 *
 * ★ SEQUENTIAL, NOT `Promise.all`, AND THAT IS A MEASUREMENT RATHER THAN A HABIT.
 *   The counts include full scans of multi-million-row tables, and the pool is
 *   capped. Forty-nine of those in parallel would queue behind the pool and time out
 *   together, producing one batch failure with no way to tell which object was
 *   slow; run in series, each object either finishes or reports its own error, and a
 *   reader watching the button gets one honest answer per object.
 */
async function countAll(
  objects: readonly ObjectRow[],
  columns: Map<string, ColumnRow[]>,
): Promise<CountOutcome[]> {
  const out: CountOutcome[] = [];
  for (const object of objects) {
    if (NOT_ACTIVITY[object.name]) continue;
    const cols = (columns.get(object.name) ?? []).map((c) => c.column_name);
    out.push(await countObject(object.name, cols, storeFor(object.name)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recorded readings
// ---------------------------------------------------------------------------

export interface ActivityReading {
  date: string;
  rowCount: number;
  /** The store that took this count. Recorded with the reading, not inferred from the config. */
  store: StoreId;
  capturedAt: string;
  previousDate: string | null;
  previousCount: number | null;
  delta: number | null;
}

/**
 * The readings for one day — newest on or before it.
 *
 * ★ TWO ROWS PER OBJECT, BECAUSE THE DIFFERENCE NEEDS BOTH. `rn = 1` is the newest
 *   reading on or before the day asked about; `rn = 2` is the reading before that,
 *   and its absence is the honest "first reading" state rather than a zero.
 *   `previousDate` travels with `delta` because there is no scheduler here: a table
 *   read on Monday and again on Thursday yields a three-day difference, and a number
 *   without its other date cannot be told apart from a one-day one.
 *
 * ★ `counted_in IS NOT NULL` IS THE LINE THAT KEEPS THIS PAGE HONEST. The readings
 *   already in the table were taken by the previous version of this register, which
 *   counted the **app store** — so they are the sample's numbers. Serving them under
 *   a heading naming the ledger would be precisely the mis-attribution this file
 *   warns about. A reading that does not say which store produced it is a reading
 *   this register will not use, and the object reads "not counted" until one button
 *   press replaces it with a number that carries its provenance.
 *
 * ★ A FAILURE HERE IS NOT A FAILURE OF THE REGISTER. Before the app schema has been
 *   applied this table does not exist, and a register that refused to load because
 *   its optional second signal was missing would be worse than one reporting every
 *   object as uncounted — which is its state on that request anyway.
 */
async function readReadings(day: string): Promise<Map<string, ActivityReading>> {
  const found = await rows<{
    object_name: string;
    snapshot_date: string;
    row_count: number | string;
    counted_in: string | null;
    captured_at: string;
  }>(
    `SELECT object_name, snapshot_date, row_count, counted_in, captured_at
       FROM (
              SELECT object_name, snapshot_date, row_count, counted_in, captured_at,
                     ROW_NUMBER() OVER (
                       PARTITION BY object_name ORDER BY snapshot_date DESC, captured_at DESC, id DESC
                     ) AS rn
                FROM table_count_snapshot
               WHERE snapshot_date <= :day
                 AND counted_in IS NOT NULL
            )
      WHERE rn <= 2
      ORDER BY object_name ASC, snapshot_date DESC`,
    { day },
  );

  const byObject = new Map<string, { date: string; count: number; store: StoreId; capturedAt: string }[]>();
  for (const row of found) {
    // A store name this register does not recognise is treated the same way as a
    // missing one: better to fall back to "not counted" than to print a claim about
    // a database that was never read.
    if (row.counted_in !== 'app' && row.counted_in !== 'ledger') continue;
    const list = byObject.get(row.object_name) ?? [];
    list.push({
      date: row.snapshot_date,
      count: Number(row.row_count),
      store: row.counted_in,
      capturedAt: row.captured_at,
    });
    byObject.set(row.object_name, list);
  }

  const resolved = new Map<string, ActivityReading>();
  for (const [name, list] of byObject) {
    const current = list[0];
    if (!current) continue;
    const previous = list[1] ?? null;
    /**
     * ★ A DIFFERENCE IS ONLY COMPARABLE ACROSS TWO READINGS OF THE SAME STORE. A
     *   count from the sample subtracted from a count from the ledger is arithmetic
     *   between two different databases — 0 → 2,569,410 reads as two and a half
     *   million new rows. After a store change the difference is reported as unheard
     *   of, which is weak, but it is not false.
     */
    const comparable = previous !== null && previous.store === current.store;
    resolved.set(name, {
      date: current.date,
      rowCount: current.count,
      store: current.store,
      capturedAt: current.capturedAt,
      previousDate: comparable ? previous.date : null,
      previousCount: comparable ? previous.count : null,
      delta: comparable ? current.count - previous.count : null,
    });
  }
  return resolved;
}

/**
 * Write one day's readings.
 *
 * ★ AN UPSERT, NOT AN INSERT, BECAUSE A READING IS A READING *OF A DAY*. The same
 *   day would otherwise be written every time somebody pressed the button, and the
 *   "previous reading" for tomorrow would be whichever of them happened to land
 *   last. The UNIQUE constraint on (object_name, snapshot_date) makes a repeat an
 *   update in place.
 *
 * ★ NOT WRAPPED IN A TRANSACTION, DELIBERATELY. Each upsert is independent — one
 *   object, one day, one number — and every one is idempotent, so a run that stops
 *   halfway leaves a register partly recorded and wholly correct about the parts it
 *   managed. A transaction would buy atomicity for a claim nothing depends on: there
 *   is no invariant here spanning two objects.
 */
async function recordReadings(
  day: string,
  counts: readonly { name: string; rowCount: number; store: StoreId }[],
): Promise<{ written: number; failed: string[] }> {
  let written = 0;
  const failed: string[] = [];

  for (const current of counts) {
    try {
      // ★ `excluded.row_count` RATHER THAN A SECOND BIND. Re-sending the value works
      //   and is the more obvious spelling; using `excluded` states the value exactly
      //   once in the statement, so the two cannot drift apart.
      await execute(
        `INSERT INTO table_count_snapshot (object_name, snapshot_date, row_count, counted_in)
         VALUES (:name, :day, :n, :store)
         ON CONFLICT (object_name, snapshot_date) DO UPDATE SET
           row_count   = excluded.row_count,
           counted_in  = excluded.counted_in,
           captured_at = datetime('now')`,
        { name: current.name, day, n: current.rowCount, store: current.store },
      );
      written += 1;
    } catch {
      failed.push(current.name);
    }
  }

  return { written, failed };
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export interface ActivityTable {
  name: string;
  kind: 'table' | 'view';
  owner: 'app' | 'extract';
  /** The recorded row count, narrowed to the scope where possible. Null when no reading exists, or the count could not be read. */
  rowCount: number | null;
  /** True when the count excludes rows outside fund 04 / programs 861–863. False when the object has no account to narrow by. */
  scoped: boolean;
  /** Which mechanism narrowed it, or null. Carried so the page can say *how*, not just *whether*. */
  scopeMode: ScopeMode;
  /** The store the count came from. Read off the reading itself when there is one. */
  store: StoreId;
  /** The reading this count came from, or null when there is none. */
  reading: { date: string; capturedAt: string } | null;
  /** The reading and its difference from the one before it. */
  snapshot: ActivityReading | null;
  /** Why there is no count. Null when there is one. */
  reason: string | null;
}

export interface ActivitySummary {
  tables: number;
  /** Objects in the "System tables" tab. */
  system: number;
  /** Objects in the "Application tables" tab. */
  application: number;
  /** Objects whose count is narrowed to the scope. */
  scoped: number;
  /** Objects counted in full, because they have no account to narrow by. */
  unscoped: number;
  /** Objects with a recorded count. */
  counted: number;
  skipped: { name: string; reason: string }[];
  readings: {
    latest: string | null;
    capturedAt: string | null;
    read: number;
    comparable: number;
    moved: number;
    /** Readings this request wrote, rather than read. Zero on an ordinary load. */
    recorded: number;
    /** Objects the capture could not count, with the driver's own reason. */
    failed: { name: string; error: string }[];
  };
}

export interface ActivityDay {
  date: string;
  isToday: boolean;
  tables: ActivityTable[];
  summary: ActivitySummary;
  note: string | null;
  source: ActivitySource;
  /**
   * The account scope the counts are narrowed to.
   *
   * ★ ON THE RESPONSE BECAUSE THE PAGE HAS TO NAME IT AND MUST NOT TYPE IT. The fund and
   *   the program codes are a rule this server applies, not a fact the client can observe,
   *   and this rule is deliberately *not* the reader's top-bar selection — the register
   *   narrows to a fixed scope of its own. A page that printed `04` and `861–863` as
   *   literals would keep saying so after the server's scope moved, which is exactly the
   *   drift the `countLabel` field exists to prevent one level up. Naming the values also
   *   lets the page say plainly when the scope it obeyed is not the one the reader chose.
   *
   * ★ IT DESCRIBES THE RULE, NOT ITS REACH. `summary.scoped` is how many objects the rule
   *   could actually be applied to, and the two are different facts: the scope is narrow
   *   even when it reaches nothing.
   */
  scope: { fund: string; programs: string[] };
}

/** Why an object has no count, in a reader's words rather than the driver's. */
function noReadingReason(owner: 'app' | 'extract', countLabel: string): string {
  if (owner === 'app') {
    return 'This application’s own table has no recorded count yet. Press “Record counts now”.';
  }
  return (
    'The ledger answered with no count for this object, so the row has none to show. It is on the list ' +
    `because the object list is a declared inventory taken from the sample’s schema, and ${countLabel} ` +
    'may not expose it to this account. Press “Record counts now” and the reason appears with the table.'
  );
}

/**
 * Build the register for one day.
 *
 * Exported so `GET /api/activity` and the smoke suite ask the same question of the
 * same code rather than each re-deriving it.
 *
 * ★ `record` MAKES THIS A WRITE, AND IT DEFAULTS TO OFF. When it is on, every object
 *   is counted against its own store and the counts are stored as the day's
 *   readings. The default is `false` so the function is a read unless a caller says
 *   otherwise in as many words — and here the difference is not cosmetic, because
 *   the write path is the expensive one: it is the one that scans the ledger.
 *
 * ★ THE READINGS ARE LOADED AFTER THE WRITE, SO THE RESPONSE SHOWS ITS OWN WORK. A
 *   capture comes back with today's reading and its difference already in it, rather
 *   than answering with yesterday's state and leaving the reader to reload to find
 *   out whether the button did anything.
 */
export async function activityFor(day: string, record = false): Promise<ActivityDay> {
  // ★ THE CENSUS HAS TO BE TAKEN AFTER THE APP'S OWN TABLES EXIST, OR IT IS NOT A
  //   CENSUS. This register lists every object in the database and reports how many
  //   the app owns, so a load running before any write had created the app tables
  //   would report one fewer table than the load after it, and a reader cannot tell
  //   that from a table having been dropped. The call is memoised for the life of
  //   the process and never throws, so this costs one attempt.
  await ensureAppSchema();

  const { objects, columns } = await readCatalogue();

  let recorded = 0;
  let captureFailed: { name: string; error: string }[] = [];

  if (record) {
    const outcomes = await countAll(objects, columns);

    // ★ A COUNT THAT COULD NOT BE READ IS NOT A READING. Recording it would put a
    //   row in the snapshot table whose only content is the fact that this code ran,
    //   and every reader would then have to filter it out for ever — the same
    //   mistake as writing `0` for "cannot say", one level down.
    captureFailed = outcomes
      .filter((o) => o.rowCount === null)
      .map((o) => ({ name: o.name, error: o.error ?? 'no reason given' }));

    const counts = outcomes
      .filter((o): o is CountOutcome & { rowCount: number } => o.rowCount !== null)
      .map((o) => ({ name: o.name, rowCount: o.rowCount, store: o.store }));

    if (counts.length > 0) {
      try {
        await requireAppSchema('The activity register');
        const written = await recordReadings(day, counts);
        recorded = written.written;
        captureFailed = [
          ...captureFailed,
          ...written.failed.map((n) => ({ name: n, error: 'the reading could not be stored' })),
        ];
      } catch (e: unknown) {
        /**
         * ★ A TARGET THAT WILL NOT ACCEPT THE READINGS MUST NOT TAKE THE PAGE DOWN.
         *   This is a POST that volunteered to write; a read-only target or an
         *   unapplied schema is a reason to stop writing, not a reason to stop
         *   answering. A 409 from `writesGuard` against a remote Turso connection
         *   without `ALLOW_REMOTE_WRITES` arrives here.
         */
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[activity] could not record row counts for ${day}: ${message}`);
        captureFailed = [...captureFailed, { name: '(the whole capture)', error: message }];
      }
    }

    if (captureFailed.length > 0) {
      console.warn(
        `[activity] ${captureFailed.length} of ${objects.length} objects could not be counted:`,
        captureFailed.map((f) => `${f.name}: ${f.error}`).join(' | '),
      );
    }
  }

  let readings = new Map<string, ActivityReading>();
  try {
    readings = await readReadings(day);
  } catch {
    readings = new Map();
  }

  const src = activitySource();
  const tables: ActivityTable[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const object of objects) {
    const whyNot = NOT_ACTIVITY[object.name];
    if (whyNot) {
      skipped.push({ name: object.name, reason: whyNot });
      continue;
    }

    const cols = (columns.get(object.name) ?? []).map((c) => c.column_name);
    const mode = scopeModeFor(cols);
    const owner: 'app' | 'extract' = isAppTable(object.name) ? 'app' : 'extract';
    const reading = readings.get(object.name) ?? null;

    tables.push({
      name: object.name,
      kind: object.type === 'view' ? 'view' : 'table',
      owner,
      rowCount: reading?.rowCount ?? null,
      scoped: mode !== null,
      scopeMode: mode,
      // The reading's own store when there is one — that is a fact about the number
      // on screen — and what it *would* be when there is not.
      store: reading?.store ?? storeFor(object.name),
      reading: reading ? { date: reading.date, capturedAt: reading.capturedAt } : null,
      snapshot: reading,
      reason: reading ? null : noReadingReason(owner, src.countLabel),
    });
  }

  const values = [...readings.values()];
  /**
   * ★ `counted` IS SCOPED TO THE OBJECTS ABOVE, NOT TO THE READINGS TABLE. It was
   *   `readings.size`, which is every object name with a reading **on or before this
   *   day** — a historical set. An object dropped from the list since its last
   *   reading keeps that reading forever, so `counted` could exceed `tables`: the
   *   page said "67 counted" over a 53-row table, and the summary line contradicted
   *   the column beneath it. Every other figure here derives from `tables`; this one
   *   has to as well. Measured: docs/implementation/wcsexp-view-names.md §6.
   */
  const withReading = tables.filter((t) => t.snapshot !== null).length;
  /**
   * ★ `comparable` AND `moved` ARE SCOPED TO THE OBJECTS ABOVE TOO, AND THEY WERE NOT.
   *
   *   `counted`/`read` were fixed (see the note above) while these two kept being
   *   counted over `values` — the same historical set, the same failure. `comparable`
   *   is the figure the page renders as "**N of M compared**", sitting directly above
   *   a column built from `tables`, so a reading belonging to an object that has left
   *   the list inflated the sentence and contradicted the rows under it.
   *
   *   Measured, not theorised: the smoke check `a difference is the arithmetic on two
   *   readings` counted 20 tables carrying a comparable reading while the census said
   *   **34** — a 14-reading gap, all of it objects with a stored reading that the
   *   register no longer lists. It passed against the local sample (where the two sets
   *   coincide) and failed against the remote store, which is the signature of a
   *   scoping bug rather than of a data bug.
   *
   *   Both now derive from `tables`, like every other figure here, so the summary and
   *   the column cannot describe different sets. `latest`/`capturedAt` stay over
   *   `values` on purpose: they are one stamp answering "when was a reading taken",
   *   which is a fact about the readings themselves and not a claim about these rows.
   */
  const summary: ActivitySummary = {
    tables: tables.length,
    system: tables.filter((t) => t.owner === 'extract').length,
    application: tables.filter((t) => t.owner === 'app').length,
    scoped: tables.filter((t) => t.scoped).length,
    unscoped: tables.filter((t) => !t.scoped).length,
    counted: withReading,
    skipped,
    readings: {
      latest: values.reduce<string | null>((best, s) => (best === null || s.date > best ? s.date : best), null),
      capturedAt: values.reduce<string | null>(
        (best, s) => (best === null || s.capturedAt > best ? s.capturedAt : best),
        null,
      ),
      read: withReading,
      comparable: tables.filter((t) => t.snapshot !== null && t.snapshot.delta !== null).length,
      moved: tables.filter((t) => t.snapshot !== null && t.snapshot.delta !== null && t.snapshot.delta !== 0).length,
      recorded,
      failed: captureFailed.sort((a, b) => a.name.localeCompare(b.name)),
    },
  };

  const isToday = day === today();

  /**
   * ★ THE NOTE IS THE FEATURE, NOT A FOOTNOTE, AND IT HAS TO SAY THREE THINGS.
   *
   *   First, that a figure here is a *reading* and carries a date: the button is the
   *   only thing that moves it, and a reader expecting the page to track the live
   *   ledger will misread every number on it.
   *
   *   Second, which database the counts came from — and, because the object list and
   *   the readings live somewhere else, say so in the same breath. The two are
   *   printed from configuration, never typed.
   *
   *   Third, where the counts stop being the ledger's: seven of the objects are this
   *   app's own tables, counted in the app store because the ledger has nowhere to
   *   keep them, and most of the rest carry no account column at all — so their count
   *   is the whole object rather than the fund/program slice every other page shows.
   *   Both numbers are counted from the rows, so neither can go stale.
   */
  let note =
    `Each figure is a recorded reading, not a live count: it was taken when someone last pressed ` +
    `“Record counts now” and it does not move until someone presses it again. ` +
    `The counts are read from ${src.countLabel}` +
    (src.sharedWithLedger
      ? `, which is also where the object list and the readings themselves are kept.`
      : `, while the object list and the recorded readings come from the app store at ${src.label}.`);

  if (summary.scoped > 0) {
    note +=
      ` ${summary.scoped} of the ${summary.tables} objects carry an account, so their counts are narrowed to ` +
      `fund ${SCOPE_FUND} and program ${SCOPE_PROGRAMS.join('/')}. The other ${summary.unscoped} — including ` +
      `${summary.application === 1 ? 'one application table' : `${summary.application} application tables`} — ` +
      `have no account column to narrow by, and their count is the whole object.`;
  }

  if (summary.counted < summary.tables) {
    const missing = summary.tables - summary.counted;
    note +=
      ` ${missing} object${missing === 1 ? ' has' : 's have'} no recorded count yet, so the row reads ` +
      `“not counted” rather than 0 — a zero would mean the table is empty, which is a fact about the ` +
      `database, and this is a fact about this app.`;
  }

  // Reported rather than swallowed: a partial capture is the one outcome a reader
  // pressing the button deserves to hear about, because it leaves the page holding
  // readings taken at different times.
  if (captureFailed.length > 0) {
    const names = captureFailed
      .slice(0, 5)
      .map((f) => f.name)
      .join(', ');
    note +=
      ` ${captureFailed.length} object${captureFailed.length === 1 ? '' : 's'} could not be counted just now ` +
      `(${names}${captureFailed.length > 5 ? ', …' : ''}), so ${captureFailed.length === 1 ? 'its' : 'their'} ` +
      `reading is missing rather than zero. The reason is given under the table.`;
  }

  return {
    date: day,
    isToday,
    tables,
    summary,
    note,
    source: src,
    scope: { fund: SCOPE_FUND, programs: [...SCOPE_PROGRAMS] },
  };
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const DateQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .optional()
      .openapi({
        example: '2026-08-06',
        description:
          'The day whose recorded reading to report, as `YYYY-MM-DD`. Defaults to today in the server’s own time zone.',
      }),
  })
  .openapi('ActivityQuery');

const StoreIdSchema = z.enum(['app', 'ledger']);

const ActivityReadingSchema = z
  .object({
    date: z.string(),
    rowCount: z.number().int(),
    store: StoreIdSchema,
    capturedAt: z.string(),
    previousDate: z.string().nullable(),
    previousCount: z.number().int().nullable(),
    delta: z.number().int().nullable(),
  })
  .openapi('ActivityReading');

const ActivityTableSchema = z
  .object({
    name: z.string(),
    kind: z.enum(['table', 'view']),
    owner: z.enum(['app', 'extract']),
    rowCount: z.number().int().nullable(),
    scoped: z.boolean(),
    scopeMode: z.enum(['segments', 'lookup']).nullable(),
    store: StoreIdSchema,
    reading: z.object({ date: z.string(), capturedAt: z.string() }).nullable(),
    snapshot: ActivityReadingSchema.nullable(),
    reason: z.string().nullable(),
  })
  .openapi('ActivityTable');

const ActivitySummarySchema = z
  .object({
    tables: z.number().int(),
    system: z.number().int(),
    application: z.number().int(),
    scoped: z.number().int(),
    unscoped: z.number().int(),
    counted: z.number().int(),
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
    readings: z
      .object({
        latest: z.string().nullable(),
        capturedAt: z.string().nullable(),
        read: z.number().int(),
        comparable: z.number().int(),
        moved: z.number().int(),
        recorded: z.number().int(),
        failed: z.array(z.object({ name: z.string(), error: z.string() })),
      })
      .openapi('ActivityReadingsState'),
  })
  .openapi('ActivitySummary');

const ActivityDaySchema = z
  .object({
    date: z.string(),
    isToday: z.boolean(),
    tables: z.array(ActivityTableSchema),
    summary: ActivitySummarySchema,
    note: z.string().nullable(),
    /**
     * ★ PART OF THE RESPONSE RATHER THAN A LINE OF PROSE IN THE PAGE. Both labels are
     *   configuration — a file path, and a host with a service name — and a client
     *   typing them out would be printing a database name it had no way to check, on
     *   a page whose whole subject is which database each figure came from.
     */
    source: z
      .object({
        store: z.enum(['app']),
        label: z.string(),
        dialect: z.enum(['sqlite', 'oracle']),
        ledgerLabel: z.string(),
        sharedWithLedger: z.boolean(),
        countStore: StoreIdSchema,
        countLabel: z.string(),
      })
      .openapi('ActivitySource'),
    /**
     * The fund and program codes the counts are narrowed to. A rule, not a measurement:
     * `summary.scoped` is how many objects it could reach.
     */
    scope: z
      .object({ fund: z.string(), programs: z.array(z.string()) })
      .openapi('ActivityScope'),
  })
  .openapi('ActivityDay');

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerActivity(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/activity',
    operationId: 'getActivity',
    summary: 'Every object in the register, with its recorded row count',
    description:
      'An inventory of the database: every object the app knows about, whether this application owns it, ' +
      'how many rows its last recorded reading found, and which database took that reading.\n\n' +
      '**A count here is a reading, not a live figure.** Counts are taken on demand by ' +
      '`POST /api/activity/snapshot` — counting the live ledger means full scans of multi-million-row ' +
      'tables, so it is not done on a page load — and every row carries the date it was taken. An object ' +
      'with no reading reports `rowCount: null` with a `reason`, never `0`, because a zero would mean the ' +
      'table is empty.\n\n' +
      'Counts are narrowed to fund `04` and programs `861`/`862`/`863` wherever the object carries an ' +
      'account — either its own `SEGMENT1`/`SEGMENT3`, or a `CODE_COMBINATION_ID` resolvable through ' +
      '`GL_CODE_COMBINATIONS`. Rows carry `scoped: false` where no such column exists, so the page can say ' +
      'which figures are the whole object rather than implying a filter that never ran.\n\n' +
      'The object list and the recorded readings live in the app store; each count is read from the store ' +
      'that actually holds the object. `source` names both, and every row names the store its own figure ' +
      'came from.',
    tags: ['Meta'],
    query: DateQuerySchema,
    response: ActivityDaySchema,
    errors: [400, 500, 503],
    handler: async ({ query }) => {
      requireSqliteCatalogue();

      const requested = query.date ?? today();

      // ★ THE ROUND TRIP HAS TO COME BACK IDENTICAL, WHICH IS STRICTER THAN "IS IT A
      //   DATE". `/^\d{4}-\d{2}-\d{2}$/` accepts 2026-02-31, and SQLite answers
      //   `date('2026-02-31')` with '2026-03-03' — it normalises rather than
      //   refusing. So a check for NULL would pass, the register would be built for a
      //   day nobody asked for, and the screen would show one date while the URL said
      //   another.
      const probe = await appRows<{ ok: string | null }>(`SELECT date(:d) AS ok`, { d: requested });
      const resolved = probe[0]?.ok ?? null;
      if (!resolved) {
        throw AppError.badRequest(`"${requested}" is not a real date.`, {
          date: requested,
          expected: 'YYYY-MM-DD',
        });
      }
      if (resolved !== requested) {
        throw AppError.badRequest(`"${requested}" is not a real date — the closest one is ${resolved}.`, {
          date: requested,
          normalised: resolved,
        });
      }

      // ★ A READ, NEVER A WRITE, ON THIS PATH. The old register took a reading the
      //   first time it was asked about today, which was affordable when a reading
      //   was one query per object against a local file. Counting the live ledger is
      //   a different cost by orders of magnitude, and a GET that scans
      //   `AP_INVOICE_PAYMENTS_ALL` because somebody opened a page would be a page
      //   load measured in seconds with nothing on screen to explain why.
      return activityFor(resolved, false);
    },
  });

  /**
   * Count every object and record the counts as today's reading.
   *
   * ★ WHY THIS IS THE ONLY THING THAT COUNTS. There is no scheduler in this app and
   *   no change log anywhere in the database, so a count is only available at the
   *   moment somebody asks for it. Doing it on the button means it happens when a
   *   reader is watching, it happens once, and every figure on the page afterwards is
   *   a stored number that costs nothing to serve.
   *
   * ★ IT READS THE LEDGER AND WRITES ONLY TO THE APP STORE. That is what makes it
   *   legitimate against a SELECT-only Oracle grant: the counts are read from the
   *   ledger, and `table_count_snapshot` — the only thing written — lives in the
   *   local app store, which `resolveAppDb` deliberately leaves writable because
   *   there is nowhere else for this application's own bookkeeping to live.
   */
  api.route({
    method: 'post',
    path: '/api/activity/snapshot',
    operationId: 'activity_snapshot',
    summary: 'Count every table now and record the counts',
    description:
      'Counts every object in the register against the store that holds it — narrowed to fund `04` and ' +
      'programs `861`/`862`/`863` wherever the object carries an account — and stores each count as today’s ' +
      'reading, one row per object in `table_count_snapshot`. Running it again on the same day replaces ' +
      'that day’s reading rather than adding a second.\n\n' +
      'This is the only operation that counts. It is a POST because it writes, and it can take seconds: ' +
      'counting the ledger means full scans of tables holding millions of rows.\n\n' +
      'Objects that could not be counted are named with the driver’s own reason, so a partial capture is ' +
      'distinguishable from a complete one.',
    tags: ['Meta'],
    response: z
      .object({
        date: z.string(),
        capturedAt: z.string(),
        /** Objects counted and stored. */
        written: z.number().int(),
        /** Objects that could not be counted, with the reason each gave. */
        failed: z.array(z.object({ name: z.string(), error: z.string() })),
      })
      .openapi('ActivityCaptureResult'),
    errors: [409, 500, 503],
    handler: async () => {
      requireSqliteCatalogue();

      const clock = await appRows<{ d: string; now: string }>(
        `SELECT ${TODAY_SQL} AS d, datetime('now') AS now`,
      );
      const day = clock[0]?.d ?? today();

      const register = await activityFor(day, true);

      return {
        date: day,
        capturedAt: clock[0]?.now ?? '',
        written: register.summary.readings.recorded,
        failed: register.summary.readings.failed,
      };
    },
  });

  /**
   * The server's own idea of "today", which the rail badge needs.
   *
   * ★ NOT `new Date()` ON THE CLIENT. The register's `isToday` and its default date
   *   come from the server's clock and zone; a browser in another zone computing its
   *   own "today" would ask for a day the server calls yesterday.
   *
   * ★ AND NOT WHAT IT USED TO CARRY. The badge reported "N changes today" — the sum
   *   of two day-scoped counts that no longer exist. Its replacement is the figure
   *   belonging to an inventory: how many objects moved since the previous reading,
   *   which is the only sense in which anything here "changed".
   */
  api.route({
    method: 'get',
    path: '/api/activity/today',
    operationId: 'getActivityToday',
    summary: 'The server’s own today, and how many table counts moved',
    description:
      'The register’s default date and its headline figures in one small response. The rail badge reads ' +
      'this so the badge and the page cannot disagree about which day is being counted.',
    tags: ['Meta'],
    response: z
      .object({
        date: z.string(),
        /** Objects with a recorded reading. */
        counted: z.number().int(),
        /** Objects whose count differs from the reading before it. */
        moved: z.number().int(),
      })
      .openapi('ActivityToday'),
    errors: [500, 503],
    handler: async () => {
      requireSqliteCatalogue();
      const clock = await appRows<{ d: string }>(`SELECT ${TODAY_SQL} AS d`);
      const register = await activityFor(clock[0]?.d ?? today(), false);
      return { date: register.date, counted: register.summary.counted, moved: register.summary.readings.moved };
    },
  });
}
