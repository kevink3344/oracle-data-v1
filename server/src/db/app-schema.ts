import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, REPO_ROOT, config } from '../config/env.js';
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

/**
 * Where the app-store DDL is read from — a LIST, because the git location and the
 * deployed location are different directories.
 *
 * ★ THE FILE LIVES IN `data/sql/` IN GIT AND IN `server/ddl/` WHEN DEPLOYED, and
 *   that is the same split as `.env` rather than a quirk to be tidied away. The
 *   deploy publishes `server/` alone (see the workflow's `package: server`), so
 *   nothing above it travels: on App Service `REPO_ROOT` resolves to `/home/site`
 *   while the code and everything it owns sit in `/home/site/wwwroot`.
 *
 *   The DDL is the one repo-root file the running process needs, and it needs it
 *   at *request* time — the schema is applied lazily, on the first app-store call,
 *   not at build time — so it cannot simply be inlined into the bundle.
 *
 *   Shipping a copy inside the package is what makes the deployed process work,
 *   and `scripts/copy-ddl.mjs` is what puts it there. `npm run build` runs it, so
 *   a build that produced a runnable `dist/` also produced a runnable `ddl/`.
 *
 * ★ ORDER MATTERS: THE PACKAGE COPY FIRST. In the package it is authoritative and
 *   current. `REPO_ROOT` is the development fallback, for the case where `npm run
 *   build` has not been run and the source is executed directly (`npm run dev` and
 *   the smoke suite both run `src/` through tsx).
 *
 * ★ NAME EVERY PATH THAT WAS TRIED. The failure this replaces named exactly one
 *   path, and it was a path that could not exist on the host reading the log — so
 *   the message pointed at `/home/site/data/...` and said nothing about the copy
 *   in `wwwroot/ddl/` that the fix would add. Listing the candidates makes the
 *   next occurrence one line to compare against reality.
 */
const DDL_ROOTS: readonly string[] = [
  path.join(PACKAGE_ROOT, 'ddl'),
  path.join(REPO_ROOT, 'data', 'sql'),
];

/** The DDL file's name — identical in both dialect folders. */
const APP_SCHEMA_NAME = '01-app.sql';

/**
 * Resolve the DDL to apply for a store dialect.
 *
 * ★ THIS THROWS RATHER THAN RETURNING A PATH THAT MIGHT NOT EXIST, because a path
 *   is only useful here if it can be read, and the caller needs a message naming
 *   what was missing. `apply()` treats this and a read failure alike, so both
 *   arrive as the same `failed` status carrying the paths attempted.
 */
function findSchemaFile(dialect: 'turso' | 'sqlserver'): string {
  const candidates = DDL_ROOTS.map((root) => path.join(root, dialect, APP_SCHEMA_NAME));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    `no ${dialect} app schema file on disk. Looked in: ${candidates.join(' | ')}. ` +
      '`npm run build` copies these into the package via scripts/copy-ddl.mjs, so a ' +
      'deployment packaged without that step has no DDL to apply.',
  );
}

/**
 * ★ THE SAME TABLES, IN T-SQL — A SECOND FILE, NOT A TRANSLATION.
 *
 * The two files declare the same thirteen tables and must stay in step, but they
 * cannot be one file: `AUTOINCREMENT`, `datetime('now')`, `INTEGER CHECK(x IN
 * (0,1))` and `CREATE INDEX IF NOT EXISTS` have no T-SQL spelling, and the
 * rewrites are not mechanical (`AUTOINCREMENT` → `IDENTITY(1,1)` changes where
 * the column keyword sits, and `IF NOT EXISTS` becomes an `IF OBJECT_ID(...) IS
 * NULL` guard *around* the statement rather than a clause inside it).
 *
 * ★ WHAT KEEPS THEM IN STEP IS THE SMOKE SUITE, and it is the same gate that
 *   already guards `APP_TABLES`: it reads the SQLite file, extracts every
 *   `CREATE TABLE` name, and asserts the set equals `APP_TABLES`. That gate does
 *   not currently read this file — see the note on `APP_TABLES` — so the honest
 *   position is: the SQLite file is gated, this one is not yet, and adding a
 *   table to one without the other is a change the suite will not catch.
 *
 * Which of the two is applied is decided at run time by the store's dialect — see
 * `findSchemaFile()` above.
 */

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
  // Which organizations an account belongs to — one, or many. Beside `app_user`
  // rather than folded into it because `app_user.organization_id` answers a
  // different question: which organization the account SIGNS IN TO. See the DDL
  // header for why the tenants are named rather than derived from this set.
  'app_user_organization',
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
  // The last counted pass over the ledger, keyed by scope, so the sign-in card
  // reads a stored estimate instead of re-counting on every load. A cache: every
  // row may be deleted without losing a fact. See the DDL header.
  'ledger_summary_cache',
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

  if (store.dialect !== 'sqlite' && store.dialect !== 'sqlserver') {
    // Reachable only if someone points `APP_DB_URL` at a non-SQLite, non-SQL-Server
    // store — Oracle today. Not an error state — there is simply no DDL this module
    // can apply there, and saying so is more useful than a syntax error from the
    // driver.
    return {
      state: 'skipped',
      statements: 0,
      error: `the app store (${config.appDb.label}) is ${store.dialect}, not SQLite or SQL Server`,
    };
  }

  // ★ WHICH FILE IS APPLIED IS DECIDED BY THE STORE'S DIALECT, NOT BY `DB_MODE`.
  //   The two are the same thing in every configuration that exists, but the app
  //   store is what receives the statements, so it is what should choose the
  //   syntax. A future `APP_DB_URL` pointing at SQL Server under a libSQL ledger
  //   would then get the right DDL without this function learning about it.
  const isSqlServer = store.dialect === 'sqlserver';
  const schemaFile = findSchemaFile(isSqlServer ? 'sqlserver' : 'turso');

  let source: string;
  try {
    source = readFileSync(schemaFile, 'utf8');
  } catch (e) {
    // A missing file is a deployment problem, not a data problem, and saying so
    // by path is the difference between a two-minute fix and a hunt.
    //
    // ★ `cause` IS CARRIED ON PURPOSE. The message names the path, but the original
    //   error carries the errno (`ENOENT`/`EACCES`) and the stack — the two facts that
    //   distinguish "the file is not there" from "the process may not read it".
    //   Dropping them turns a diagnosable failure into a sentence.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`could not read ${schemaFile}: ${message}`, { cause: e });
  }

  const statements = splitSql(source);

  // ★★ THE ROLE MIGRATION RUNS *BEFORE* THE FILE, UNLIKE EVERY OTHER MIGRATION
  //    HERE, AND THE ORDER IS THE MITIGATION. `ALTER TABLE ... RENAME TO` rewrites
  //    the `REFERENCES` clauses of child tables, so rebuilding `app_user` after the
  //    file had created `app_user_organization` would repoint the child at the
  //    table being dropped and abort half-done. Running first makes that
  //    unreachable. The full argument is on `applyUserRoleMigration`; the short
  //    version is that this line must not be moved below the loop.
  const roles = isSqlServer ? false : await applyUserRoleMigration(store);

  for (const statement of statements) {
    await store.execute({ sql: statement, args: [] });
  }

  // ★ THE TWO MIGRATIONS BELOW ARE SQLITE-ONLY AND ARE SKIPPED FOR SQL SERVER.
  //   Both read `sqlite_master` and one rebuilds a table with `AUTOINCREMENT` —
  //   neither can run in T-SQL. Skipping them is correct rather than a gap: a
  //   freshly created SQL Server store carries the current shape already.
  //
  // ★★ BUT "FRESHLY CREATED" WAS AN ASSUMPTION AND IT JUST STOPPED BEING TRUE.
  //   This note used to end by predicting that "the day a SQL Server app store
  //   needs a column added, it needs its own addition path — `ALTER TABLE … ADD`
  //   in T-SQL is idempotent-guarded by `IF COL_LENGTH(...) IS NULL`, which is a
  //   different mechanism from the `pragma_table_info` probe below." That day is
  //   the project background image: the SQL Server `project` table holds fifteen
  //   rows of real data, and `CREATE TABLE` is wrapped in `IF OBJECT_ID(...) IS
  //   NULL`, so it never revisits them — a column added only to the DDL body
  //   would never reach the database that exists. Hence
  //   `applyColumnAdditionsSqlServer` below, which is called from here and takes
  //   the place the branch used to hand to an empty array.
  //
  //   ★ AND THE SAME DAY CAME FOR A CONSTRAINT. `app_user` is the live store
  //     (`DB_MODE=sqlserver`), the role vocabulary widened, and the DDL change can
  //     never reach a table that exists — see `applyUserRoleMigrationSqlServer`,
  //     which is this arm's counterpart to the SQLite rebuild above.
  const added = isSqlServer
    ? await applyColumnAdditionsSqlServer(store)
    : await applyColumnAdditions(store);
  const migrated = isSqlServer ? false : await applyPinCategoryMigration(store);
  const roleConstraint = isSqlServer ? await applyUserRoleMigrationSqlServer(store) : false;

  console.log(
    `[db] app schema ready (${statements.length} statements from ` +
      `${path.basename(schemaFile)} → ${config.appDb.label}` +
      `${added.length > 0 ? `, ${added.length} column${added.length === 1 ? '' : 's'} added: ${added.join(', ')}` : ''}` +
      `${roles ? ', app_user role vocabulary widened' : ''}` +
      `${roleConstraint ? ', role constraint upgraded' : ''}` +
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
 * `app_user` as the file states it, in SQLite's vocabulary, under a caller-chosen
 * name.
 *
 * ★ THIS IS A SECOND COPY OF A `CREATE TABLE` THAT ALREADY EXISTS IN `01-app.sql`,
 *   and it is the same trade `APP_TABLES` and `COLUMN_ADDITIONS_SQLSERVER` already
 *   make: a rebuild cannot reuse the file's statement without re-parsing the file,
 *   and the file is not parsed here. The two are meant to be identical, so the
 *   `COLUMN_ADDITIONS_SQLSERVER` rule applies verbatim — **the two must not
 *   drift**, and the way they are held together is that this copy carries no
 *   comment the file's does not, so a diff of the two bodies is short.
 *
 * ★ IT TAKES THE NAME AS AN ARGUMENT because the rebuild creates the replacement
 *   under a scratch name before the original is dropped — see the header on
 *   `applyUserRoleMigration` for why the original cannot simply be renamed aside.
 *   Callers pass literals defined in this file; the name is never user input.
 */
function createAppUserSql(name: string): string {
  return (
    `CREATE TABLE ${name} (` +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'email TEXT NOT NULL UNIQUE, ' +
    'display_name TEXT NOT NULL, ' +
    "role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('super_admin','administrator','staff')), " +
    'organization_id INTEGER REFERENCES organization(id), ' +
    'password_hash TEXT, ' +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), " +
    'last_seen_at TEXT)'
  );
}

/** The scratch name the rebuild builds under, before the swap. */
const APP_USER_SCRATCH = 'app_user_rebuilt';

/** Every column `app_user` has today, in the order the file declares them. */
const APP_USER_COLUMNS = [
  'id',
  'email',
  'display_name',
  'role',
  'organization_id',
  'password_hash',
  'created_at',
  'last_seen_at',
] as const;

/**
 * Widen `app_user.role` from two values to three, and map the old lower role onto
 * the new one.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `01-app.sql`'s own comment used to read *"there are two roles and a third would
 * be a decision, not a migration."* The decision has been made, and it turns out
 * to be a migration: SQLite cannot relax a `CHECK` in place, and `CREATE TABLE IF
 * NOT EXISTS` never revisits a table that exists — so the new set of values is
 * reachable only by rebuilding the table. That is the same shape as
 * `applyPinCategoryMigration` above, and this function is deliberately a sibling
 * of it rather than a generalisation: two rebuilds with one shared helper would
 * need a table-agnostic column list, and the one thing a table rebuild must never
 * have is a column list it derived rather than was told.
 *
 * ---------------------------------------------------------------------------
 * ★★ THE TABLE IS REBUILT SIDEWAYS, NEVER RENAMED OUT OF THE WAY, AND THAT IS A
 *    CORRECTION MADE BY MEASUREMENT RATHER THAN BY READING
 * ---------------------------------------------------------------------------
 * The obvious rebuild — rename `app_user` to `app_user_legacy`, create a new
 * `app_user`, copy, drop the legacy table — IS WRONG HERE and was measured to be
 * wrong. SQLite's modern `ALTER TABLE ... RENAME TO` rewrites the `REFERENCES`
 * clauses of every other table that points at the renamed one. So with
 * `app_user_organization` present, the rename repoints the child at
 * `app_user_legacy`; the `DROP` of that table then fires the child's declared
 * `ON DELETE CASCADE` and **silently deletes every membership row** before the
 * drop succeeds. Measured on SQLite 3.45.1: the child was repointed, the
 * memberships went from 1 to 0, and no error was raised anywhere. A migration
 * that loses data and reports success is the worst failure mode available, so the
 * mechanism changed rather than the comment.
 *
 * `PRAGMA legacy_alter_table = ON` is the documented way to suppress that
 * rewrite, and IT DID NOT — the pragma read back as `1` and the child was still
 * repointed. It is not used here, because a pragma that reports success and does
 * nothing is worse than no pragma at all.
 *
 * What is done instead: the replacement is built under a scratch name, the copy
 * goes into it, the ORIGINAL is dropped, and the SCRATCH is renamed into place.
 * The only rename is of a name nothing references, so nothing is repointed, and
 * the drop is surrounded by `PRAGMA foreign_keys = OFF` so no cascade can fire.
 * Measured on the same store: the child still references `app_user`, the
 * membership rows survived, and `PRAGMA foreign_key_check` came back clean.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY IT STILL RUNS BEFORE THE FILE
 * ---------------------------------------------------------------------------
 * Not because it has to — the sideways rebuild is safe either way — but because
 * running first makes the window in which `app_user` does not exist as small and
 * as unobserved as it can be: it opens and closes before the DDL below has
 * created anything that could reference it, at boot, with no other query in
 * flight. On every later run the stored definition names all three roles, so the
 * early return fires and the window never opens at all.
 *
 * ---------------------------------------------------------------------------
 * ★ AND THE COLUMN COPY IS DERIVED FROM THE STORE, NOT FROM A CONSTANT
 * ---------------------------------------------------------------------------
 * Running before the file also means running before `applyColumnAdditions`, so a
 * store old enough to predate `password_hash` does not have it yet. The copy
 * therefore reads `pragma_table_info` and carries only the columns the store
 * actually has, while the table it creates is the CURRENT shape. That is the
 * `applyColumnAdditions` posture applied inside the rebuild: state the destination
 * shape, copy what exists, and let the later pass fill any gap.
 *
 * ---------------------------------------------------------------------------
 * ★ AND IT COUNTS ITS OWN WORK
 * ---------------------------------------------------------------------------
 * The defect described above deleted rows and reported success, so the guard
 * against it is not a comment but arithmetic: the row count is taken before the
 * rebuild and again after, and a shortfall is reported by name. That is the
 * assertion that would have caught the original bug in one line.
 *
 * Non-fatal, matching both siblings. A failed rebuild warns and returns `false`;
 * it never throws, because everything else in the schema has to still apply.
 */
async function applyUserRoleMigration(store: SqlDriver): Promise<boolean> {
  try {
    const stored = await store.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_user'",
      args: [],
    });
    const definition = String((stored.rows[0] as { sql?: unknown } | undefined)?.sql ?? '');

    // No row means a fresh store. The file creates the table with the current
    // constraint, so there is nothing to convert — and converting nothing is not
    // the same as having converted something, which is why this is `false`.
    if (definition === '') return false;

    // Already widened. Checked against the stored text rather than a version
    // number, so a store migrated by hand is recognised as done.
    const lowered = definition.toLowerCase();
    if (lowered.includes("'administrator'") && lowered.includes("'staff'")) return false;

    // Which columns this store actually has. Inlined, never bound — a bound
    // parameter inside `pragma_table_info` panics the libSQL Rust core. The name
    // is a literal in this file, not user input.
    const info = await store.execute({
      sql: `SELECT name FROM pragma_table_info('app_user')`,
      args: [],
    });
    const have = new Set(
      info.rows.map((r) => String((r as { name?: unknown }).name ?? '').toLowerCase()),
    );
    if (have.size === 0) return false;

    // How many accounts there are, before. See the header — the defect this
    // replaces deleted rows and returned success, so the count is the assertion.
    const before = await store.execute({ sql: 'SELECT COUNT(*) AS n FROM app_user', args: [] });
    const expected = Number((before.rows[0] as { n?: unknown } | undefined)?.n ?? 0);

    const carried = APP_USER_COLUMNS.filter((c) => have.has(c));
    // ★ `member` BECOMES `staff`. The old vocabulary's lower role is the new
    //   vocabulary's lower role, so the mapping is a rename and not a promotion —
    //   nobody gains a capability by the store being upgraded. `administrator` is
    //   deliberately NOT assigned to anyone: a migration that hands out a role is
    //   a migration that grants access, and that is a decision for an operator.
    const select = carried
      .map((c) => (c === 'role' ? "CASE WHEN role = 'member' THEN 'staff' ELSE role END" : c))
      .join(', ');

    // ★★ FOREIGN KEYS OFF FOR THE DROP. With them on, `DROP TABLE` performs an
    //    implicit delete of the parent's rows, which fires every child's
    //    `ON DELETE CASCADE` — the exact mechanism that emptied the membership
    //    table. Nothing else is running, and the count below proves the restore.
    await store.execute({ sql: 'PRAGMA foreign_keys = OFF', args: [] });
    try {
      await store.execute({ sql: createAppUserSql(APP_USER_SCRATCH), args: [] });
      await store.execute({
        sql:
          `INSERT INTO ${APP_USER_SCRATCH} (${carried.join(', ')}) ` +
          `SELECT ${select} FROM app_user`,
        args: [],
      });
      await store.execute({ sql: 'DROP TABLE app_user', args: [] });
      await store.execute({ sql: `ALTER TABLE ${APP_USER_SCRATCH} RENAME TO app_user`, args: [] });
    } finally {
      // `finally`, not a plain call: a throw between here and there must not leave
      // the process enforcing no foreign keys for the rest of its life.
      await store.execute({ sql: 'PRAGMA foreign_keys = ON', args: [] });
    }

    const after = await store.execute({ sql: 'SELECT COUNT(*) AS n FROM app_user', args: [] });
    const got = Number((after.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    if (got !== expected) {
      console.warn(
        `[db] app_user role upgrade kept ${got} of ${expected} account${expected === 1 ? '' : 's'}` +
          (got < expected ? ' — accounts were lost' : ''),
      );
    }

    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[db] could not upgrade app_user role constraint: ${message}`);
    return false;
  }
}

/**
 * The same widening for SQL Server, and it needs its own function because the
 * mechanism is not the same one.
 *
 * ★ T-SQL CAN ALTER A `CHECK`, SO THERE IS NO REBUILD HERE. `sp_rename` and
 *   `AUTOINCREMENT` do not exist on this arm, and — the reason this is not simply
 *   a dialect branch inside the function above — neither does `sqlite_master`, so
 *   the function above cannot even ask the question. It is skipped for SQL Server
 *   by name in `apply()`, exactly as `applyPinCategoryMigration` is.
 *
 * ★ `DEFAULT 'member'` HAD TO MOVE WITH THE CHECK, and this is the half that is
 *   easy to miss. The column was declared `DEFAULT 'member'` beside a constraint
 *   permitting `'member'`. Widening only the constraint would leave every `INSERT`
 *   that omits the column writing a value the table now FORBIDS — the two would
 *   contradict each other, and only on the path no test covers. The default is an
 *   UNNAMED constraint, so it is found through `sys.default_constraints` and
 *   dropped by the name SQL Server gave it.
 *
 * ★ ORDER IS LOAD-BEARING HERE TOO, for a different reason: `UPDATE ... SET role =
 *   'staff' WHERE role = 'member'` has to run while the OLD constraint is still
 *   off and the NEW one is not yet on, because the row being written is the row the
 *   new constraint would reject.
 */
async function applyUserRoleMigrationSqlServer(store: SqlDriver): Promise<boolean> {
  try {
    const check = await store.execute({
      sql:
        'SELECT definition FROM sys.check_constraints ' +
        "WHERE name = 'CK_app_user_role' AND parent_object_id = OBJECT_ID('dbo.app_user')",
      args: [],
    });
    const definition = String(
      (check.rows[0] as { definition?: unknown } | undefined)?.definition ?? '',
    );

    // Nothing to do: a fresh store was created from the DDL with the wide
    // constraint already, so its definition names `administrator`. An empty
    // definition means no such constraint exists, which this function does not
    // create — it widens one, and a store without it was not built from this DDL.
    if (definition === '' || definition.toUpperCase().includes('ADMINISTRATOR')) return false;

    await store.execute({ sql: 'ALTER TABLE dbo.app_user DROP CONSTRAINT CK_app_user_role', args: [] });

    // The default, found by column rather than by name. The name is SQL Server's
    // own (`DF__app_user__role__1A14E395` and its cousins), so it cannot be typed
    // here — and it is bracketed because an object name is an identifier and may
    // contain a `]`, which is doubled to escape it.
    const defaults = await store.execute({
      sql:
        'SELECT dc.name AS name FROM sys.default_constraints dc ' +
        'JOIN sys.columns c ON c.object_id = dc.parent_object_id ' +
        'AND c.column_id = dc.parent_column_id ' +
        "WHERE dc.parent_object_id = OBJECT_ID('dbo.app_user') AND c.name = 'role'",
      args: [],
    });
    const defaultName = (defaults.rows[0] as { name?: unknown } | undefined)?.name;
    if (typeof defaultName === 'string' && defaultName !== '') {
      await store.execute({
        sql: `ALTER TABLE dbo.app_user DROP CONSTRAINT [${defaultName.replace(/]/g, ']]')}]`,
        args: [],
      });
    }

    // The mapping, between the two constraints. `administrator` is granted to
    // nobody, deliberately — see the SQLite sibling.
    await store.execute({
      sql: "UPDATE dbo.app_user SET role = 'staff' WHERE role = 'member'",
      args: [],
    });

    await store.execute({
      sql:
        'ALTER TABLE dbo.app_user ADD CONSTRAINT CK_app_user_role ' +
        "CHECK (role IN ('super_admin','administrator','staff'))",
      args: [],
    });
    await store.execute({
      sql: "ALTER TABLE dbo.app_user ADD DEFAULT 'staff' FOR role",
      args: [],
    });

    return true;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[db] could not upgrade the SQL Server role constraint: ${message}`);
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
  /*
   * ── the background image, five columns on `project` ────────────────────────
   *
   * ★ THE LIST ABOVE RECORDED THE HAZARD AND THIS IS THE HAZARD HAPPENING. The
   *   `saved_view_run.truncated` entry warns that the store shipped at
   *   `data/sql/turso/sample.db` was built from an earlier draft of the DDL, so
   *   `CREATE TABLE IF NOT EXISTS` will not revisit it. Adding the image columns to
   *   the `.sql` file alone was therefore not enough: the FIRST call to
   *   `GET /api/projects/registry` against that store answered 500 with
   *   `SQLITE_ERROR: no such column: background_image`, while a store created from
   *   scratch would have been fine. A column added to a `CREATE TABLE` is invisible
   *   to every store that already has the table, which is every store that matters.
   *
   *   These five are the SQLite half of `COLUMN_ADDITIONS_SQLSERVER` below — the
   *   two arms carry the same change because they are the same change. Nothing in
   *   the repository enforces that they agree; this note is the only thing that
   *   says so, which is worth knowing when the next column is added. The fifth,
   *   `background_strength`, is the one that is a *choice about* the picture rather
   *   than a part of it — which is why removing the picture removes it too.
   *
   * ★ `BLOB` AND NULLABLE, LIKE ITS SQL SERVER COUNTERPART. SQLite columns are
   *   typeless, so the declaration is documentation — but the NULL is load-bearing:
   *   `row.has_background` is `CASE WHEN background_image IS NULL THEN 0 ELSE 1 END`,
   *   and a zero-length blob is a real value, so "no image" has to be absence rather
   *   than emptiness. The four companions are nullable for the same reason — they
   *   describe an image that may not be there, and each of them is meaningless
   *   without it.
   *
   * ★ NO `DEFAULT` ON `background_updated_at`, ON PURPOSE. The other timestamps in
   *   these tables carry `DEFAULT (datetime('now'))`; this one is written by the
   *   route, and a default would let a row claim an image was set at the moment the
   *   column was added. NULL means "no image has been set", which is the answer the
   *   registry needs to distinguish.
   */
  {
    table: 'project',
    column: 'background_image',
    declaration: 'BLOB',
  },
  {
    table: 'project',
    column: 'background_image_mime',
    declaration: 'TEXT',
  },
  {
    table: 'project',
    column: 'background_name',
    declaration: 'TEXT',
  },
  {
    table: 'project',
    column: 'background_updated_at',
    declaration: 'TEXT',
  },
  {
    /**
     * `project.background_strength` — how strongly the header draws the picture,
     * as a percent, or NULL for "never chosen".
     *
     * ★ `INTEGER` BECAUSE THE VALUE IS A COUNT OF PERCENT AND NOT A FRACTION.
     *   Storing `0.55` as a REAL would make every comparison a float comparison,
     *   and being compared against a control's value is this column's whole job.
     *
     * ★ NULL IS NOT 0. Zero is a choice a reader can make and keep — the picture
     *   stored and deliberately not drawn; NULL is the absence of a choice. The
     *   default for NULL is answered at the *drawing* end (`projectpage.css`, where
     *   the number `33` appears once), not in the row projection — the wire carries
     *   the stored value, NULL included, so that "never chosen" is still
     *   distinguishable from "chosen 33" at the last layer that can see it.
     *
     * ★ NO `DEFAULT`, like its neighbour. A default here would mean a row that
     *   predates the control advertised a value nobody chose, and the read path
     *   already has the default in one place.
     */
    table: 'project',
    column: 'background_strength',
    declaration: 'INTEGER',
  },
  {
    /**
     * `app_user.password_hash` — a salted scrypt derivative, or NULL.
     *
     * ★ THIS ONE IS A LOCK, NOT A READING, AND THAT CHANGES WHAT A MISTAKE COSTS.
     *   The entries above are columns a screen reads; a store that never received
     *   one shows a stale picture or a 500. This column *is* the credential. A
     *   store that never receives it answers every member sign-in with
     *   `no such column: password_hash` — and, worse, a store that receives the
     *   column but not the values has members who can no longer get in at all.
     *
     * ★ IT IS NULLABLE AND THAT IS THE SAFE DIRECTION. `app_user` ships empty, so
     *   in practice no row is affected today. When a row does exist without a hash
     *   the sign-in is REFUSED (`authenticate()` treats an absent hash as a failed
     *   comparison), which is the recoverable failure: an operator runs
     *   `npm run set:password` and the account works. The alternative — treating
     *   an absent hash as "no password required" — would make the column's absence
     *   a back door, which is the exact behaviour this change exists to remove.
     *
     * ★ `TEXT` WITH NO DECLARED LENGTH, like every other string on this arm. SQLite
     *   columns are typeless, so the declaration is documentation; the SQL Server
     *   arm below carries the real 200-character bound.
     */
    table: 'app_user',
    column: 'password_hash',
    declaration: 'TEXT',
  },
];

/**
 * The SQL Server half of the same job, and the path the note above promised.
 *
 * ★ THE COMMENT IN `apply()` USED TO READ AS A PREDICTION AND IS NOW A CALL SITE.
 *   It said: *"The day a SQL Server app store needs a column added, it needs its
 *   own addition path — `ALTER TABLE … ADD` in T-SQL is idempotent-guarded by
 *   `IF COL_LENGTH(...) IS NULL`, which is a different mechanism from the
 *   `pragma_table_info` probe."* That day is the background image: the live
 *   `dbo.project` holds fifteen rows of real data, `CREATE TABLE` is guarded by
 *   `IF OBJECT_ID(...) IS NULL` so it will never revisit them, and the first
 *   `SELECT ... background_image` would fail against the existing table. The
 *   column had to be added, not declared.
 *
 * ★ THE GUARD IS PROVEN IDEMPOTENT, AND THE PROOF IS WHY IT IS WRITTEN THIS WAY.
 *   Two runs of the same single batch against a real table left exactly one
 *   column (`SELECT COUNT(*) FROM tempdb.sys.columns …` → `2` before and after,
 *   the other column being the primary key), because `IF COL_LENGTH(...) IS NULL`
 *   is evaluated by the server before the `ALTER` is compiled. It is therefore
 *   safe to run on every boot, which is what `apply()` does — and it has to be,
 *   because there is no migration ledger here to record that it already ran.
 *
 * ★ ONE BATCH PER COLUMN, WITH A SEPARATE EXISTENCE PROBE, BECAUSE `ALTER TABLE`
 *   REPORTS NOTHING. The SQLite path can call `ALTER TABLE` unconditionally and
 *   treat the driver's `duplicate column name` as the guard; T-SQL's guarded form
 *   succeeds either way and returns no rows, so it cannot say whether it changed
 *   anything. Without the probe the boot line would claim it added a column every
 *   single run — a log that lies about what happened to the schema is worse than
 *   no log. So: ask `COL_LENGTH` first, act on the answer, and report only real
 *   additions.
 *
 * ★ A FAILURE IS NOT FATAL, MATCHING THE SQLITE PATH. Everything in the schema
 *   file has already run by this point. A column that could not be added leaves
 *   one endpoint reporting a missing column, which is a far better outcome than
 *   refusing to serve the application — and it is `console.warn`, not a throw,
 *   for exactly the reason the sibling function gives.
 */
async function applyColumnAdditionsSqlServer(store: SqlDriver): Promise<string[]> {
  const added: string[] = [];

  for (const change of COLUMN_ADDITIONS_SQLSERVER) {
    try {
      // Both names are literals in this file, never user input — the same reason
      // the SQLite probe inlines its argument rather than binding it.
      const probe = await store.execute({
        sql: `SELECT COL_LENGTH('${change.table}','${change.column}') AS len`,
        args: [],
      });
      const len = (probe.rows[0] as { len?: unknown } | undefined)?.len ?? null;

      // `null` is the answer for "no such column". A non-null length — including
      // 0, which is what an existing zero-length column would answer — means the
      // column is there and must not be added a second time.
      if (len !== null) continue;

      await store.execute({
        sql:
          `IF COL_LENGTH('${change.table}','${change.column}') IS NULL ` +
          `ALTER TABLE ${change.table} ADD ${change.column} ${change.declaration}`,
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
 * The additions that apply to the SQL Server store, declared once.
 *
 * ★ A SEPARATE LIST RATHER THAN ONE LIST WITH A DIALECT FILTER ON EACH ENTRY.
 *   The SQLite entries are spelled in SQLite's own vocabulary and none of them
 *   belongs on this arm, so a shared list would need a per-entry dialect tag
 *   whose only possible value today is "one of the two". Two lists say the same
 *   thing with less machinery, and the boot line reports whichever one ran.
 *
 * ★ THE DECLARATIONS HERE MUST MATCH THE `CREATE TABLE` BODY EXACTLY. A store
 *   created from the DDL and an older store patched by a `SELECT` of this list
 *   must end up with the same shape, or the schema depends on when the database
 *   happened to be created — which is the failure this whole mechanism exists to
 *   prevent. `VARBINARY(MAX) NULL` and `NVARCHAR(n) NULL` are deliberately
 *   verbatim, including the `NULL`, so the two paths cannot drift.
 */
const COLUMN_ADDITIONS_SQLSERVER: readonly { table: string; column: string; declaration: string }[] = [
  {
    /**
     * `project.background_image` — the project's background picture, as bytes.
     *
     * The first entry on this arm, and the reason the arm needed a path at all.
     * Nullable: most projects have no image, and `DATALENGTH(NULL)` answering null
     * (measured) is what lets the route tell "no image" from a zero-byte one.
     */
    table: 'dbo.project',
    column: 'background_image',
    declaration: 'VARBINARY(MAX) NULL',
  },
  {
    /** `project.background_image_mime` — the type the bytes are served back as. */
    table: 'dbo.project',
    column: 'background_image_mime',
    declaration: 'NVARCHAR(100) NULL',
  },
  {
    /** `project.background_name` — the filename the image arrived with. */
    table: 'dbo.project',
    column: 'background_name',
    declaration: 'NVARCHAR(400) NULL',
  },
  {
    /**
     * `project.background_updated_at` — when the image was last replaced.
     *
     * No `DEFAULT`, on purpose: the route stamps it explicitly in style 120, the
     * shape the fifteen stored rows carry. A default here would be style 126 like
     * its neighbours and would put two formats in one table. See `stampNow()`.
     */
    table: 'dbo.project',
    column: 'background_updated_at',
    declaration: 'NVARCHAR(30) NULL',
  },
  {
    /**
     * `project.background_strength` — how strongly the header draws the picture,
     * as a percent, or NULL for "never chosen".
     *
     * ★ `INT NULL` AND NOT `TINYINT`. The SQLite arm declares `INTEGER`, and a
     *   one-byte column here would be a dialect detail inside a pair whose whole
     *   purpose is that the two paths cannot drift into different shapes. Four
     *   bytes spent on a percent is not the place to save one. The route bounds
     *   the value to 0-100, and the column is nullable because zero is a real
     *   choice a reader can make — see the note on the SQLite entry above.
     */
    table: 'dbo.project',
    column: 'background_strength',
    declaration: 'INT NULL',
  },
  {
    /**
     * `app_user.password_hash` — a salted scrypt derivative, or NULL.
     *
     * ★ THIS IS THE COLUMN THE WHOLE MECHANISM WAS BUILT IN ANTICIPATION OF. The
     *   note on `applyColumnAdditionsSqlServer` above predicted it — *"the day a
     *   SQL Server app store needs a column added"* — and named the background
     *   image as the first case. This is the second, and it is the one where being
     *   wrong matters most: the live `dbo.app_user` is guarded by
     *   `IF OBJECT_ID(...) IS NULL`, so a `password_hash` added only to the DDL body
     *   would never reach it, and every sign-in would fail with
     *   `Invalid column name 'password_hash'` instead of with a credential check.
     *
     * ★ `NVARCHAR(200) NULL`, VERBATIM, INCLUDING THE `NULL`. The stored string
     *   `scrypt$16384$8$1$<24-char salt>$<88-char key>` is about 130 characters; 200
     *   leaves room for a wider salt or a longer key without a second migration.
     *   The `NULL` is the same NULL the SQLite arm declares, so the two paths cannot
     *   drift into different shapes — which is the rule this pair of lists exists to
     *   keep. It is nullable so a row carries "no credential set", and
     *   `authenticate()` refuses such a row rather than accepting any password.
     */
    table: 'dbo.app_user',
    column: 'password_hash',
    declaration: 'NVARCHAR(200) NULL',
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

  /**
   * ★ THIS METHOD IS THE DIFFERENCE BETWEEN A LEGIBLE 503 AND A BARE 500.
   *
   *   `http/errors.ts` recognises what to render with `isAppError`, and the version
   *   of that guard this class was written against tested `instanceof AppError`.
   *   `AppErrorLike` is deliberately *not* an `AppError` — the note above explains
   *   why it cannot import one — so the guard was false, `errorHandler` skipped its
   *   own branch, every later branch failed to match, and the throw landed in the
   *   final `res.status(500)` with the generic `INTERNAL` message. Measured in the
   *   deploy log: this class threw `status: 503, code: 'DB_UNAVAILABLE'` with a
   *   message naming the missing DDL path, and the browser received a bare 500.
   *
   *   The whole point of the message written below (`requireAppSchema`'s `why`) is
   *   that it names the cause and the fix. `name` was already set to `'AppError'`
   *   for exactly this recognition, but the guard tested the class and ignored the
   *   name, so the intent and the implementation disagreed and only the guard was
   *   load-bearing. Both halves are now aligned: this method provides the shape,
   *   and `isAppError` accepts it.
   *
   * The return type is written out rather than imported so that `db/` stays free of
   * `http/` — it is structurally `ErrorBody`, and `errorHandler` only serialises it.
   */
  toBody(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
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
 *
 * ★★ `GO` IS A BATCH SEPARATOR THE DRIVER DOES NOT UNDERSTAND — AND IT IS NOT SQL.
 *
 *   The T-SQL DDL (`data/sql/sqlserver/01-app.sql`) uses `GO` on its own line
 *   between batches, which is an SSMS/sqlcmd convention: the *client* splits on it
 *   before sending anything. `mssql` does not, so `GO` arrived at the server as a
 *   statement and SQL Server answered
 *
 *       Could not find stored procedure 'GO'.
 *
 *   ★ THAT FAILURE TOOK OUT THE WHOLE APP STORE, NOT ONE STATEMENT. `apply()`
 *     executes the statements in order and throws on the first error, so the
 *     schema was never applied — and every app-store endpoint answered 503
 *     `DB_UNAVAILABLE`. Measured: `/api/views` failed with that 503 while
 *     `saved_view` held a perfectly good row, because the *schema application*
 *     had aborted, not the read.
 *
 *   ★ THE COPY SCRIPT ALREADY SPLIT ON `GO` (see `copy-oracle-to-sqlserver.ts`),
 *     which is exactly why the tables exist and the app could not read them. Two
 *     appliers of the same file, one of which knew about `GO` and one which did
 *     not — the fix is to teach this one, not to remove `GO` from the file, since
 *     the file is also read by humans and by `sqlcmd`.
 *
 * A `GO` is only a separator when it is the whole line (case-insensitive, optional
 * surrounding whitespace), which is the same rule sqlcmd applies. `'GO'` inside a
 * literal is already protected by the string handling above.
 */
export function splitSql(src: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;
  // Tracks whether the current line has any non-whitespace before the cursor, so
  // a `GO` can be recognised as standing alone.
  let lineHasContent = false;

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
      lineHasContent = true;
      continue;
    }

    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') {
        buf += src[i];
        i += 1;
      }
      if (i < src.length) buf += src[i];
      lineHasContent = false;
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

    if (c === '\n') {
      // ★ A LINE THAT IS EXACTLY `GO` ENDS A BATCH. Checked at the newline so the
      //   whole line is known — `\bGO\b` on the running buffer would also fire on
      //   a column named `GO` or a word in a comment.
      const line = buf.slice(buf.lastIndexOf('\n') + 1).trim();
      if (/^GO$/i.test(line) && lineHasContent) {
        buf = buf.slice(0, buf.lastIndexOf('\n'));
        const statement = stripCommentOnly(buf);
        if (statement) out.push(statement);
        buf = '';
      } else {
        buf += c;
      }
      lineHasContent = false;
      continue;
    }

    if (c === ';') {
      const statement = stripCommentOnly(buf);
      if (statement) out.push(statement);
      buf = '';
      lineHasContent = false;
      continue;
    }

    if (!/\s/.test(c ?? '')) lineHasContent = true;
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
