import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, config } from '../config/env.js';
import { storeDriver } from './client.js';
import type { SqlDriver } from './driver.js';

/**
 * Applies `data/sql/turso/01-app.sql` — the tables this application owns.
 *
 * WHY LAZY, AND NOT AT STARTUP
 *   The process must serve before the database is reachable (see `client.ts`:
 *   listen first, probe in the background). Applying DDL at boot would either
 *   block the listen or race the probe, and it would do database work on a
 *   server whose operator may only want the read-only endpoints. So it runs on
 *   first *use* — the first request that touches a saved view — and the promise
 *   is memoised so it runs once per process no matter how many requests arrive
 *   together.
 *
 * WHY IT IS NOT IN THE BUILD SCRIPT
 *   `scripts/build-turso-sample.mjs` builds the *Oracle surrogate*, and
 *   `scripts/verify-turso-sample.mjs` asserts its object count (36 tables, 6
 *   views). App tables are a different kind of thing — they change whenever the
 *   app does — so folding them into that build would make a schema-migration
 *   look like a seed change and would move a verified number. The .sql file
 *   stays the single source of truth either way; only the applier differs.
 *
 * ★ WHY THE APP STORE IS CONTACTED DIRECTLY, AND WHY THAT IS NOT ORACLE MODE
 *   This used to open with `if (config.db.mode === 'oracle') return skipped`, on
 *   the reasoning that every statement in the file is SQLite DDL —
 *   `AUTOINCREMENT`, `datetime('now')`, `CHECK` — so against Oracle they are all
 *   syntax errors.
 *
 *   The reasoning was right and the conclusion was wrong. What made them syntax
 *   errors was never that the *server* was in Oracle mode; it was that the DDL was
 *   being sent to *Oracle*. Those were the same thing while one mode meant one
 *   database, and `APP_DB_URL` separates them: under `DB_MODE=oracle` with a local
 *   app store, these statements are perfectly valid SQLite and must be applied,
 *   because that file is now the only place `saved_view` can live.
 *
 *   So the statements are sent to the app store by name (`storeDriver('app')`)
 *   rather than routed or gated. Under every configuration that existed before
 *   `APP_DB_URL` that store *is* the ledger — when the mode is local it is the
 *   sample file, and the old `skipped` answer for oracle mode is exactly the case
 *   where the app store is a separate SQLite file and the DDL now runs. Oracle mode
 *   itself no longer skips anything; the database that cannot take this DDL is no
 *   longer reachable from this module.
 *
 *   What is left of the skip is a real, narrower condition: the app store is not
 *   there. `skipped` now means that, and the 503 says which store and why.
 *
 * WHY A FAILURE IS REMEMBERED RATHER THAN THROWN
 *   This module's job is to apply DDL. Whether that is fatal is a question for
 *   the caller — a preview does not need the tables at all and must keep working
 *   when they are missing, which is exactly the phase-1 state. `requireAppSchema`
 *   is the throwing wrapper, and only the endpoints that genuinely need a table
 *   call it.
 */

export interface AppSchemaStatus {
  /**
   * `applied` — this process created or confirmed the tables.
   * `skipped` — the app store is not a SQLite store, or is not reachable, so the
   *             DDL was not attempted. See `apply()`.
   */
  state: 'pending' | 'applied' | 'skipped' | 'failed';
  /** Statements the file contained and that were executed without error. */
  statements: number;
  error: string | null;
}

const APP_SCHEMA_FILE = path.join(REPO_ROOT, 'data', 'sql', 'turso', '01-app.sql');

/**
 * The tables `01-app.sql` owns, as opposed to the ones the extract ships.
 *
 * ★ THIS IS A SECOND COPY OF A LIST THAT ALREADY EXISTS, AND IT IS DELIBERATE.
 *   The first copy is the `CREATE TABLE` statements in the file above. The reason
 *   this one exists anyway is that the question "did this app write this table, or
 *   Oracle?" is asked when the *file cannot be read* — a server pointed at Oracle
 *   never applies it, and a deploy that forgot the file has no DDL to parse. A
 *   caller that had to read the file to answer would get the wrong answer in
 *   exactly the two situations where the answer matters most.
 *
 * ★ AND IT IS CHECKED RATHER THAN TRUSTED. `npm run smoke` reads `01-app.sql`,
 *   extracts every `CREATE TABLE` name from it, and asserts the two sets are equal
 *   — so adding a table to the file without adding it here fails the suite rather
 *   than producing one screen that quietly calls an app table part of the extract.
 *
 * Ordered as the file orders them, so a diff of the two lists reads cleanly.
 */
export const APP_TABLES = [
  'saved_view',
  'saved_view_run',
  'saved_view_subscription',
  'project',
  'table_count_snapshot',
  'organization',
  'app_user',
  'user_pin',
  'geo_origin',
  'vendor_site_geo',
  // The road between the origin and a pin, and its turns — separate from
  // `vendor_site_geo` because the two tables answer two different questions and
  // are read at two different times. The geometry is ~3.8 KB a row and the geo
  // table is read *whole* (all 800 rows) into every register payload, so folding
  // this in would add ~3 MB to every register load. See the DDL header.
  'vendor_site_route',
  // A reader's own value for a field the ledger already holds — one vendor name
  // today. Tiny and narrow: it stores the custom value and who set it, never a
  // copy of the Oracle value, because the delete path restores "what the ledger
  // says" by removing this row rather than by replaying a cached one.
  'field_override',
  // How many rows this app reads from a ledger object, and in what order. One row
  // per object the administrator has decided to bound; an object with no row is
  // uncapped, so adding this table changes nothing until a row is written. The
  // `order_by` column is required whenever `max_rows` is set — a cap with no
  // ordering is a random sample, not a smaller answer. See the DDL header.
  'ledger_read_cap',
] as const;

const APP_TABLE_SET: ReadonlySet<string> = new Set<string>(APP_TABLES);

/** True when this app owns the table, rather than the extract having shipped it. */
export function isAppTable(name: string): boolean {
  return APP_TABLE_SET.has(name.toLowerCase());
}

let current: AppSchemaStatus = { state: 'pending', statements: 0, error: null };
let inFlight: Promise<AppSchemaStatus> | null = null;

export function appSchemaStatus(): AppSchemaStatus {
  return current;
}

/**
 * Apply the file, or return the result of the attempt already running.
 *
 * Never throws — the outcome is in the returned status — so a caller that only
 * wants to *report* the state does not have to wrap it in a try.
 */
export function ensureAppSchema(): Promise<AppSchemaStatus> {
  if (current.state === 'applied' || current.state === 'skipped') {
    return Promise.resolve(current);
  }
  // A failed attempt is *not* cached as final: the usual cause is a database that
  // was not reachable yet, and the next request should get a real try rather than
  // inheriting a startup failure forever.
  if (inFlight) return inFlight;

  inFlight = apply()
    .then((status) => {
      current = status;
      return status;
    })
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      current = { state: 'failed', statements: current.statements, error: message };
      console.error(`[db] app schema failed: ${message}`);
      return current;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function apply(): Promise<AppSchemaStatus> {
  /**
   * The app store, named rather than routed.
   *
   * ★ THIS IS THE ONE PLACE THE STORE IS CHOSEN RATHER THAN DERIVED, and the
   *   reason is that the statements have no tables in them to derive from — they
   *   are `CREATE TABLE`, and on a fresh store the tables they name do not exist
   *   yet. Routing by text would send them to the ledger (nothing registered is
   *   named *as a query*), which under a divergent configuration is Oracle, where
   *   they are syntax errors. The DDL belongs to the app store by definition.
   */
  const store = storeDriver('app');

  if (store.dialect !== 'sqlite') {
    // Reachable only if someone points `APP_DB_URL` at a non-SQLite store. Not an
    // error state — there is simply no DDL this module can apply there, and
    // saying so is more useful than a syntax error from the driver.
    return {
      state: 'skipped',
      statements: 0,
      error: `the app store (${config.appDb.label}) is ${store.dialect}, not SQLite`,
    };
  }

  let source: string;
  try {
    source = readFileSync(APP_SCHEMA_FILE, 'utf8');
  } catch (e) {
    // A missing file is a deployment problem, not a data problem, and saying so
    // by path is the difference between a two-minute fix and a hunt.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`could not read ${APP_SCHEMA_FILE}: ${message}`);
  }

  const statements = splitSql(source);
  for (const statement of statements) {
    await store.execute({ sql: statement, args: [] });
  }

  const added = await applyColumnAdditions(store);
  const migrated = await applyPinCategoryMigration(store);

  console.log(
    `[db] app schema ready (${statements.length} statements from 01-app.sql → ${config.appDb.label}` +
      `${added.length > 0 ? `, ${added.length} column${added.length === 1 ? '' : 's'} added: ${added.join(', ')}` : ''}` +
      `${migrated ? ', user_pin category constraint upgraded' : ''})`,
  );
  return { state: 'applied', statements: statements.length, error: null };
}

/**
 * Upgrade the first draft of `user_pin`, whose category check did not include
 * purchase orders. SQLite cannot alter a CHECK constraint in place, so the
 * table is rebuilt only when its stored DDL proves that it needs the change.
 * The copy is deliberately data-preserving and idempotent for existing Turso
 * stores; fresh stores already get the current definition above.
 */
async function applyPinCategoryMigration(store: SqlDriver): Promise<boolean> {
  try {
    const result = await store.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_pin'",
      args: [],
    });
    const definition = String((result.rows[0] as { sql?: unknown } | undefined)?.sql ?? '').toLowerCase();
    if (!definition || definition.includes('purchase-order')) return false;

    await store.execute({ sql: 'ALTER TABLE user_pin RENAME TO user_pin_legacy', args: [] });
    await store.execute({
      sql:
        "CREATE TABLE user_pin (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, " +
        "category TEXT NOT NULL CHECK (category IN ('project', 'invoice', 'check', 'purchase-order')), " +
        "entity_key TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', href TEXT NOT NULL, " +
        "created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (owner_email, category, entity_key))",
      args: [],
    });
    await store.execute({
      sql: 'INSERT INTO user_pin (id, owner_email, category, entity_key, title, subtitle, href, created_at) ' +
        'SELECT id, owner_email, category, entity_key, title, subtitle, href, created_at FROM user_pin_legacy',
      args: [],
    });
    await store.execute({ sql: 'DROP TABLE user_pin_legacy', args: [] });
    await store.execute({
      sql: 'CREATE INDEX IF NOT EXISTS IDX_USER_PIN_OWNER_CATEGORY ON user_pin (owner_email, category, created_at DESC)',
      args: [],
    });
    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[db] could not upgrade user_pin category constraint: ${message}`);
    return false;
  }
}

/**
 * Columns added to tables that may already exist.
 *
 * ★ THIS IS THE ONE THING THE .SQL FILE CANNOT DO BY ITSELF, AND THE REASON IS
 *   STRUCTURAL RATHER THAN A SHORTCUT. `CREATE TABLE IF NOT EXISTS` is a no-op when
 *   the table is there, so adding a column to its body only reaches stores created
 *   *after* the change. Every store built before it — including the one this
 *   repository ships at `data/sql/turso/sample.db` — keeps the old shape, and the
 *   first SELECT naming the new column fails.
 *
 * ★ THE ALTERNATIVE WAS CONSIDERED AND IS WORSE. Putting `ALTER TABLE ... ADD
 *   COLUMN` straight into the .sql file would look tidier, but `apply()` executes
 *   every statement unconditionally, so the second run of the process would get
 *   `duplicate column name` out of the driver, which throws out of `apply()` and
 *   takes the *whole* schema application with it — one migration breaking every
 *   other table. SQLite has no `ADD COLUMN IF NOT EXISTS` to make that safe. So the
 *   decision is made in code, where it can be read back: ask the table what columns
 *   it has, and add only what is missing. Re-running is a no-op, and the .sql file
 *   still declares the column for a fresh store.
 *
 * ★ THE PRAGMA ARGUMENT IS INLINED, NOT BOUND, AND THAT IS NOT A STYLE CHOICE.
 *   `SELECT name FROM pragma_table_info(?)` with a bound parameter panics the libSQL
 *   Rust core — `called Option::unwrap() on a None value` — and the driver reports it
 *   as a bare process error with no SQL in the message, so it reads like a crash
 *   rather than a bad query. The table names here are literals in this file, never
 *   user input, so inlining is both correct and the only thing that works.
 *
 * ★ A FAILURE IS NOT FATAL TO THE SCHEMA APPLICATION. Everything in the .sql file
 *   has already been executed by this point; a column that could not be added means
 *   one query elsewhere will report a missing column, which is a far better outcome
 *   than refusing to serve the application at all.
 */
async function applyColumnAdditions(store: SqlDriver): Promise<string[]> {
  const added: string[] = [];

  for (const change of COLUMN_ADDITIONS) {
    try {
      // Inlined deliberately — see above. Not user input.
      const info = await store.execute({
        sql: `SELECT name FROM pragma_table_info('${change.table}')`,
        args: [],
      });
      const have = new Set(
        info.rows.map((r) => String((r as { name?: unknown }).name ?? '').toLowerCase()),
      );
      // No rows means the table does not exist yet, which cannot happen after the
      // file was applied — but if it somehow did, the `CREATE TABLE` above would
      // have carried the column, so there is nothing to add.
      if (have.size === 0) continue;
      if (have.has(change.column.toLowerCase())) continue;

      await store.execute({
        sql: `ALTER TABLE ${change.table} ADD COLUMN ${change.column} ${change.declaration}`,
        args: [],
      });
      added.push(`${change.table}.${change.column}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[db] could not add ${change.table}.${change.column}: ${message}`);
    }
  }

  return added;
}

/**
 * The additions, declared once.
 *
 * ★ A LIST RATHER THAN A MIGRATIONS FRAMEWORK, ON PURPOSE. There is one live store
 *   and no deployed fleet, so a versioned migration chain would be machinery for a
 *   problem this project does not have. If this list ever grows past a handful of
 *   entries that is the moment to reconsider, and not before.
 */
const COLUMN_ADDITIONS: readonly { table: string; column: string; declaration: string }[] = [
  {
    /**
     * `table_count_snapshot.counted_in` — which database produced a recorded count.
     *
     * ★ THE READINGS ALREADY IN THIS TABLE WERE TAKEN FROM THE APP STORE. They were
     *   written by an earlier version of the Activity register, which counted every
     *   object in the local SQLite sample because that was the only database it
     *   read. The register now counts each object in the store that actually holds
     *   it, so those old rows are the sample's numbers and nothing distinguishes
     *   them from the ledger's except this column's absence. The register reads
     *   `counted_in IS NOT NULL`, so they are not served, and the first press of
     *   "Record counts now" replaces them with readings that carry their provenance.
     */
    table: 'table_count_snapshot',
    column: 'counted_in',
    declaration: 'TEXT',
  },
  {
    /**
     * `field_override.subject_written` — the subject key as it was typed.
     *
     * Added while the feature was being built, so it is here for one situation
     * only: a store that applied an earlier draft of the `field_override` DDL. The
     * column is nullable and the route falls back to the folded key when it is
     * null, so an un-patched store degrades to a less readable orphan row rather
     * than to a failed write.
     */
    table: 'field_override',
    column: 'subject_written',
    declaration: 'TEXT',
  },
  {
    /**
     * `saved_view_run.truncated` — whether a run hit the row cap.
     *
     * ★ WITHOUT THIS COLUMN THE HISTORY CANNOT TELL A TOTAL FROM A FLOOR. Every
     *   statement the View Builder runs is wrapped to fetch at most `maxRows + 1`
     *   rows, and the count that gets recorded is the length of the capped array. So
     *   a query over 900,000 rows would record `row_count = 200` — the same number a
     *   query over exactly 200 rows records. `saved_view_run` is one of the three
     *   tables added in the same release as this column, so in principle no store
     *   predates it; the entry is here because the store this repository ships at
     *   `data/sql/turso/sample.db` predates it, having been built from an earlier
     *   draft of the same DDL. `CREATE TABLE IF NOT EXISTS` will not revisit it, and
     *   the first `SELECT ... truncated` would fail with `no such column`.
     *
     *   Nullable, and deliberately not defaulted: a run that was refused before it
     *   reached the database produced no result and therefore has no truncation
     *   state. `1` means there were more rows than the cap; `0` means the count is
     *   the whole answer; `null` means the question did not arise.
     */
    table: 'saved_view_run',
    column: 'truncated',
    declaration: 'INTEGER',
  },
];

/**
 * The wrapper for endpoints that cannot work without the tables.
 *
 * Throws `503 DB_UNAVAILABLE` rather than a 400: nothing the caller sent is
 * wrong, and the fix is not in the request. 503 rather than 500 because this is
 * a recoverable *state* — the next attempt may well succeed, which is exactly
 * what the un-cached failure above allows for.
 *
 * `what` names the thing the caller wanted, because "the app tables could not be
 * created" is not an answer to "where are my projects". It was added when the
 * project registry became the second domain to need these tables: the saved-view
 * wording was being returned for a project request, which is the kind of message
 * that sends a reader to the wrong file.
 */
export async function requireAppSchema(what = 'Saved views'): Promise<void> {
  const status = await ensureAppSchema();
  if (status.state === 'applied') return;

  /**
   * ★ THE OLD COPY BLAMED THE DIALECT, AND SAID SO CONFIDENTLY.
   *   It read "app-owned tables, which are SQLite-only. This server is pointed at
   *   Oracle, where there is no storage for them." Under `DB_MODE=oracle` with an
   *   `APP_DB_URL` file that is now doubly wrong: there *is* storage, it is that
   *   file, and the reason the request failed is that the file does not have the
   *   tables yet — or could not be opened. A message that names the wrong cause
   *   sends the reader to the wrong fix, so it now names the store, the label and
   *   the driver's own error.
   */
  const why =
    status.state === 'skipped'
      ? `${what} are stored in the app-owned store, and this run has no SQLite store for them ` +
        `(${status.error ?? `app store: ${config.appDb.label}`}). ` +
        'Point APP_DB_URL at a writable SQLite file to give them one.'
      : `The app tables in ${config.appDb.label} could not be created: ${status.error ?? 'unknown error'}`;
  throw new AppErrorLike(503, 'DB_UNAVAILABLE', why);
}

/**
 * Local stand-in for `http/errors.ts`'s `AppError`.
 *
 * Imported statically, it would make the database layer depend on the HTTP layer
 * — `db/` is used by scripts that never build a request, and the dependency would
 * also be circular the day an error handler wants to read `dbStatus()`. The error
 * this module throws only has to carry `status` and `code`, which is the shape
 * `errorHandler` reads, so it does exactly that and nothing more.
 */
export class AppErrorLike extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Split a script into statements, respecting string literals and comments.
 *
 * ★ A LITERAL IS NOT A SEMICOLON, and a comment is not code. This file contains
 *   `'[]'`, `'draft'`, `datetime('now')` and a header full of apostrophes
 *   (`project's`, `app does`) inside `--` comments. A naive `split(';')` survives
 *   by luck until someone adds a semicolon to a comment, and then it produces a
 *   fragment of prose that fails as SQL with a syntax error pointing at the
 *   middle of a sentence.
 *
 * Comments are kept rather than stripped: SQLite parses them, and retaining them
 * means a failure reported by the driver quotes the line the file actually has.
 */
export function splitSql(src: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (inString) {
      buf += c;
      if (c === "'") {
        if (src[i + 1] === "'") {
          // A doubled quote is an escaped quote, not the end of the literal.
          buf += src[i + 1];
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (c === "'") {
      inString = true;
      buf += c;
      continue;
    }

    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') {
        buf += src[i];
        i += 1;
      }
      if (i < src.length) buf += src[i];
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      buf += c + src[i + 1];
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        buf += src[i];
        i += 1;
      }
      if (i < src.length) {
        buf += '*/';
        i += 1;
      }
      continue;
    }

    if (c === ';') {
      const statement = stripCommentOnly(buf);
      if (statement) out.push(statement);
      buf = '';
      continue;
    }

    buf += c;
  }

  const last = stripCommentOnly(buf);
  if (last) out.push(last);
  return out;
}

/**
 * Trim a candidate statement, and discard it if there is nothing in it but
 * comments.
 *
 * Needed because the file's header ends with a blank line and comments before
 * the first `CREATE`; without this the leading block would be emitted as a
 * statement on its own, which is a zero-length SQL string as far as libSQL is
 * concerned and fails as one.
 */
function stripCommentOnly(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const withoutComments = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
  return withoutComments.trim() ? trimmed : null;
}
