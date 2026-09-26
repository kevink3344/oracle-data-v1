import { config, type DbConfig } from '../config/env.js';
import { createLibsqlDriver, type SqlDriver } from './driver.js';
import { createRoutedDriver, type RoutedDriver, type StoreId } from './hybrid.js';
import { createOracleDriver, oracleClientVersion } from './oracle.js';
import { createSqlServerDriver } from './sqlserver.js';
import { storeForTable } from './store.js';
import { noteStatement } from '../http/sql-trace.js';

/**
 * The single database driver for the process, plus the readiness flag the health
 * endpoint reports.
 *
 * WHY READINESS IS A FLAG AND NOT A THROW
 *   The server must accept connections before the database is reachable.
 *   A remote libSQL endpoint can be cold, and a DNS blip would otherwise make
 *   `app.listen` never happen — the worst possible failure, because the operator
 *   sees a dead port and no explanation. So: listen first, probe in the
 *   background, and report the outcome on `/api/health` as
 *   `{ ok: true, dbReady: false }`. That shape lets a client distinguish
 *   "the API is down" from "the API is up and the database is not", which are
 *   completely different problems.
 *
 * ★ THE DRIVERS ARE BUILT HERE, ONCE — AND WHAT "ONCE" MEANS HAS CHANGED.
 *   This used to be a *selection*: `config.db.mode === 'oracle' ? oracle : libsql`,
 *   one line, one winner, and the comment said so — "there is exactly one place
 *   where the wrong backend could be selected". That was true, and it is no longer
 *   the shape of the problem. There are two stores:
 *
 *     - the **ledger**, chosen by `DB_MODE`: the sample file, Turso, or Oracle;
 *     - the **app store**, where `saved_view`, `project`, `table_count_snapshot`
 *       and the `X_REPORT_*` extract tables live — the same database by default,
 *       a separate one when `APP_DB_URL` names it.
 *
 *   They are the same database in every configuration that existed before
 *   `APP_DB_URL`, which is why separating them changes nothing until someone does
 *   it. They are built here, once, for the same reason as before: one place where
 *   a backend can be opened, so a third one cannot appear in a route.
 *
 *   ★ WHERE A STATEMENT GOES IS DECIDED PER STATEMENT, by `hybrid.ts` from the
 *   explicit registry in `store.ts` — not by branching on the mode here, and not
 *   by anything a route can get wrong. The old comment promised one place where
 *   the wrong backend could be *selected*; the new promise is stronger and
 *   harder: no statement can reach the wrong backend, because the table-to-store
 *   map is written down and gated.
 */

const ledger: SqlDriver =
  config.db.mode === 'oracle'
    ? createOracleDriver()
    : config.db.mode === 'sqlserver'
      ? createSqlServerDriver()
      : createLibsqlDriver();

/**
 * The app store's driver. The same object as `ledger` when they are one database,
 * which is what `shared` buys: one connection, one probe, one close.
 */
const app: SqlDriver =
  config.appDb.shared
    ? ledger
    : config.appDb.sqlserver !== undefined
      ? createSqlServerDriver()
      : createLibsqlDriver(config.appDb);

/**
 * ★ THE SQL TRACE IS RECORDED AT THE DRIVER, AND THAT IS THE ONLY PLACE THAT CATCHES EVERYTHING.
 *
 *   The first attempt recorded statements in `db/sql.ts`'s `rows()`/`one()`/`execute()` helpers. That
 *   covers every route that uses them — which is most of the app — but **not** the routes that call
 *   `db.execute` directly, and the two payables registers (`routes/ap.ts`) are exactly that: five
 *   direct calls each. So `/api/ap/checks` and `/api/ap/invoices` answered with no trace while every
 *   other endpoint carried one, which is the opposite of what a reader checking a payables figure
 *   needs.
 *
 *   Decorating the driver instead means the trace is a property of *running a statement*, not of
 *   which helper ran it. It also removes the risk of the next direct caller being silently untraced,
 *   which is the failure mode a per-helper hook has by construction.
 *
 *   `noteStatement` is a no-op when no request scope is active, so scripts, startup probes and the
 *   smoke suite are unaffected. It measures with `performance.now()` rather than trusting a driver
 *   to report its own duration, because only one of the two backends does.
 */
function traced(inner: SqlDriver): SqlDriver {
  return {
    ...inner,
    async execute(req) {
      const started = performance.now();
      const res = await inner.execute(req);
      noteStatement(req.sql, performance.now() - started, res.rows.length);
      return res;
    },
  };
}

export const db: RoutedDriver = createRoutedDriver({
  ledger: traced(ledger),
  app: traced(app),
  shared: config.appDb.shared,
  labels: { ledger: config.db.label, app: config.appDb.label },
  writable: { ledger: config.db.allowWrites, app: config.appDb.allowWrites },
});

export function dbConfig(): DbConfig {
  return config.db;
}

/**
 * The driver for a store, chosen explicitly rather than from the statement text.
 *
 * ★ FOR FEATURES THAT ARE APP-OWNED BY NATURE. The View Builder is the case: its
 *   SQL is written by a user against the app store's schema, it is guarded as
 *   SQLite, and its results are stored in `saved_view_run`. Routing it by the
 *   tables the text happens to mention would make the dialect — and the
 *   `query_only` switch that depends on the dialect — a function of the user's
 *   query, which is neither what it is nor what they expect. `routes/views.ts`
 *   asks for the app store by name.
 */
export function storeDriver(id: StoreId): SqlDriver {
  return db.storeDriver(id);
}

/**
 * Whether a mutation against this table is accepted, and why not when it is not.
 *
 * ★ WRITABILITY IS A PROPERTY OF A STORE, NOT OF THE PROCESS. This replaces
 *   `config.db.allowWrites` as the answer to "may I write". Under `DB_MODE=oracle`
 *   with a local app store the two stores hold opposite policies: Oracle refuses
 *   (the account is SELECT-only) while the app store accepts. One flag cannot say
 *   that, and it silently said the wrong half — it would refuse to save a view
 *   *because Oracle is read-only*, which is a fact about a different database.
 *
 * Returns a reason rather than only a boolean so the 405 can quote it. This is
 * the one place `storeForTable` is allowed to throw into a request: a table the
 * registry does not know is a defect in this codebase, and a 500 that says so is
 * better than a write aimed at a store nobody chose.
 */
export function writableForTable(name: string): { writable: boolean; reason?: string } {
  const id = storeForTable(name);
  const store = db.stores().find((s) => s.id === id);
  if (store === undefined) return { writable: false, reason: 'the store is not configured' };
  if (store.writable) return { writable: true };
  return {
    writable: false,
    reason:
      `the ${id === 'app' ? 'app-owned' : 'ledger'} store is read-only (${store.label})` +
      (store.dialect === 'oracle'
        ? ', because the Oracle account holds a SELECT-only grant.'
        : ', because remote writes are switched off.'),
  };
}

let ready = false;
let lastError: string | null = null;
let lastProbeMs: number | null = null;
let storeProbes: Awaited<ReturnType<RoutedDriver['probeStores']>> = [];

export const isDbReady = (): boolean => ready;
export const dbLastError = (): string | null => lastError;

/** One store's readiness, as `/api/health` reports it. */
export interface StoreStatus {
  id: StoreId;
  target: string;
  dialect: SqlDriver['dialect'];
  writable: boolean;
  shared: boolean;
  ok: boolean;
  lastProbeMs: number | null;
  error: string | null;
}

export interface DbStatus {
  mode: DbConfig['mode'];
  target: string;
  ready: boolean;
  writable: boolean;
  lastProbeMs: number | null;
  error: string | null;
  /** Present only in oracle mode, so "Oracle up" is never inferred from a flag. */
  oracleClient?: string;
  /**
   * ★ ONE ENTRY PER STORE, BECAUSE ONE IS NOT THE ANSWER.
   *   `ready: true` with the app store unreachable is a lie the single flag used to
   *   tell: the health check would pass while every saved view returned 503. The
   *   array carries the per-store detail, and the top-level `ready` is the AND of
   *   it, so a client reading only the old shape goes *more* conservative than
   *   before rather than less.
   */
  stores: StoreStatus[];
}

export function dbStatus(): DbStatus {
  const stores: StoreStatus[] = db.stores().map((s) => {
    const probe = storeProbes.find((p) => p.id === s.id);
    return {
      id: s.id,
      target: s.label,
      dialect: s.dialect,
      writable: s.writable,
      shared: s.shared,
      ok: probe?.ok ?? false,
      lastProbeMs: probe?.ms ?? null,
      error: probe?.error ?? null,
    };
  });

  return {
    mode: config.db.mode,
    target: config.db.label,
    ready,
    /**
     * ★ THE COARSE ANSWER, DEFINED SO IT MATCHES THE COARSE GUARD.
     *
     * `writesGuard` in `http/middleware.ts` refuses a non-GET request when *no*
     * store accepts writes. This flag has to be that same predicate, or the server
     * publishes a description of itself that its own middleware contradicts: with
     * `writable: true` set from one store, a request refused by the guard would
     * read as a bug in the guard.
     *
     * So: true means the guard will let the request through *and then* the
     * per-table decision is made by `writableForTable`. It does NOT mean every
     * write route works — a resource on a read-only store answers 403 with the
     * store named. The flag is deliberately not narrowed to the app store, which
     * would make it false in a configuration that accepts writes to half its
     * tables.
     */
    writable: stores.some((s) => s.writable),
    lastProbeMs,
    error: lastError,
    ...(config.db.mode === 'oracle' ? { oracleClient: oracleClientVersion() } : {}),
    stores,
  };
}

/** A single round-trip per store. Cheap enough to call on every health request. */
export async function probeDb(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    // Every distinct store, each with its own ping — `SELECT 1` is ORA-00923 on a
    // pre-23c Oracle, which is why the statement belongs to the driver.
    const results = await db.probeStores();
    storeProbes = results;
    const ms = Math.round(performance.now() - t0);
    const failed = results.filter((r) => !r.ok);
    ready = failed.length === 0;
    lastError =
      failed.length === 0 ? null : failed.map((f) => `${f.id}: ${f.error ?? 'unreachable'}`).join('; ');
    lastProbeMs = ms;
    return failed.length === 0 ? { ok: true, ms } : { ok: false, ms, error: lastError ?? undefined };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const message = e instanceof Error ? e.message : String(e);
    ready = false;
    lastError = message;
    lastProbeMs = ms;
    return { ok: false, ms, error: message };
  }
}

/**
 * Probe until it succeeds, then stop. Never throws.
 *
 * Backoff rather than a tight loop because the remote case is usually a cold
 * start or a dropped connection, both of which resolve in seconds — and the
 * process is already serving traffic, so there is nothing to fail fast for.
 */
export async function startDbProbe(opts: { attempts?: number; baseDelayMs?: number } = {}): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 500;

  for (let i = 0; i < attempts; i += 1) {
    const result = await probeDb();
    if (result.ok) {
      if (i > 0) {
        console.log(`[db] reachable after ${i + 1} attempt(s) — ${result.ms}ms`);
      }
      return;
    }
    if (i === 0) {
      console.warn(`[db] first probe failed: ${result.error}`);
    }
    if (i < attempts - 1) await sleep(base * 2 ** i);
  }

  console.error(
    `[db] still unreachable after ${attempts} attempts. ` +
      'The API is serving, but data endpoints will return DB_UNAVAILABLE until it recovers.',
  );
  // One more probe shortly after the backoff expires, so a slow cold start
  // heals without a restart.
  setTimeout(() => void probeDb(), 5000);
}

/**
 * Per-connection setup, delegated to the driver.
 *
 * For SQLite this turns foreign keys on; SQLite only enforces them when the
 * pragma is set *per connection*, and a pooled client may not reuse one. So the
 * pragma is a best-effort there (it makes the common path correct) and the API
 * layer additionally checks referenced rows exist before insert — enforcement
 * that does not depend on which connection served the write.
 *
 * For Oracle it opens the pool and pins the session formats, which is why it is
 * not a no-op: skipping it would leave the first request to discover a bad
 * connect string instead of the startup log.
 */
export async function applyPragmas(): Promise<void> {
  try {
    await db.prepare();
  } catch (e) {
    // Not fatal for libSQL (remote libSQL rejects some pragmas). For Oracle this
    // is the connect itself failing, which `probeDb` reports as `dbReady:false`
    // with the driver's own message — so it is logged, not swallowed silently.
    if (config.db.mode === 'oracle') {
      console.warn(`[db] oracle session setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export async function closeDb(): Promise<void> {
  // Awaited: an Oracle pool needs its drain to finish, and libSQL's close is
  // synchronous but harmless to await. Returning before the pool has closed
  // would let a shutdown race the connections it is waiting on.
  await db.close();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
