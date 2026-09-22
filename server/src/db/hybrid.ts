/**
 * The driver that sends each statement to the store its tables belong to.
 *
 * WHY THE NAME
 *   This is the driver `hybrid` mode would use, written now because `APP_DB_URL`
 *   can already point the app-owned tables at a different database than the
 *   ledger. The mode is not shipped — `DB_MODES` is untouched — but the situation
 *   it was designed for is reachable today, so the routing has to exist before the
 *   mode does. Naming the file for the configuration rather than the mode keeps
 *   `docs/plans/hybrid-mode-plan.md` §5 and §6 readable against the code.
 *
 * ★ ROUTING IS PER STATEMENT, NEVER PER REQUEST OR PER DRIVER.
 *   Every entry point in this server funnels through `SqlDriver.execute`, and a
 *   single HTTP request may issue several statements with different owners — the
 *   projects summary reads `X_REPORT_PROJECT_FACTS` and `PA_PROJECTS_ALL` in two
 *   statements, expecting each from its own store. A driver-level decision would
 *   have to pick one, and picking one is wrong for the other. So the decision is
 *   taken inside `execute`, from the statement text, every time.
 *
 * ★ THE ONE OPERATION ROUTING CANNOT SERVE, AND WHAT IS DONE ABOUT IT.
 *   `transaction()` is a *unit* of several statements by definition, so there is no
 *   statement to route. It delegates to the app store, because the only writes that
 *   flow through it are app-owned rows — `withTransaction` in `db/sql.ts` is a write
 *   helper with no callers. When the two stores are the same database (the default,
 *   and every configuration that existed before `APP_DB_URL`) this is the ledger's
 *   own driver and the distinction is invisible. Under a divergent configuration a
 *   caller wanting a *ledger* transaction has to open it on that driver explicitly;
 *   there is no such caller, and inventing a silent choice for one would be the
 *   wrong-answer failure this file is built to avoid.
 *
 * ★ A STATEMENT THAT NAMES TABLES FROM BOTH STORES IS REFUSED — WHEN THAT MEANS
 *   SOMETHING. If the two stores resolve to the same database, `shared` is true
 *   and a mixed statement is harmless: every routing answer is the same answer, so
 *   the classification cannot change the result. Only when they diverge does
 *   mixing become unanswerable, and then it throws rather than picking a side. That
 *   is why the check reads the *configuration* and not the statement alone.
 */

import type { SqlDriver } from './driver.js';
import { describeRoute, routeStatement, type StatementRoute, type StoreId } from './store.js';

export type { StoreId, StatementRoute };

/** A one-line description of a store, for the startup banner and the health payload. */
export interface StoreSummary {
  id: StoreId;
  /** Human label. Never contains a credential. */
  label: string;
  dialect: SqlDriver['dialect'];
  /**
   * Whether non-GET requests against this store's tables are accepted.
   *
   * ★ THIS IS THE VALUE THAT REPLACED A PROCESS-WIDE FLAG. `config.db.allowWrites`
   *   answered this for the whole server, which was correct while there was one
   *   store. There are two now, and they can hold opposite policies: Oracle outside
   *   (SELECT-only grant) with a writable local file for the app's own rows. So
   *   writability is a property of a store, and the resource guard asks about the
   *   store its table is in.
   */
  writable: boolean;
  /** True for the store the ledger resolved to, when both are the same database. */
  shared: boolean;
}

/** What a readiness probe found, per store. */
export interface StoreProbeResult extends StoreSummary {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RoutedDriver extends SqlDriver {
  /** Where a statement would go, and the driver that would take it. */
  route(sql: string): StatementRoute & { driver: SqlDriver };
  /** The driver for a store, chosen explicitly. For features that are app-owned by nature. */
  storeDriver(id: StoreId): SqlDriver;
  /** Every store, in a stable order: ledger first. */
  stores(): StoreSummary[];
  /**
   * Probe each *distinct* store.
   *
   * ★ `/api/health` MUST NOT REPORT ONE STORE'S HEALTH AS THE WHOLE ANSWER. With
   *   the ledger in Oracle and the app store on disk, a single probe would report
   *   either "the database is up" while saved views are unreachable, or the reverse
   *   — and both readings are wrong in a way the operator cannot see. The array is
   *   the honest shape: one entry per store, each with its own outcome.
   */
  probeStores(): Promise<StoreProbeResult[]>;
}

export function createRoutedDriver(opts: {
  ledger: SqlDriver;
  app: SqlDriver;
  /** True when both resolve to the same database. See the file doc block. */
  shared: boolean;
  writable: Record<StoreId, boolean>;
  labels: Record<StoreId, string>;
}): RoutedDriver {
  const { ledger, app, shared, writable, labels } = opts;

  /** The distinct drivers, so a shared store is prepared, probed and closed once. */
  const distinct: SqlDriver[] = shared ? [ledger] : [ledger, app];

  const summary = (id: StoreId): StoreSummary => ({
    id,
    label: labels[id],
    dialect: (id === 'app' ? app : ledger).dialect,
    writable: writable[id],
    shared: shared && id === 'ledger',
  });

  /**
   * The routing decision, as a plain function rather than a method, so `execute`
   * does not depend on being called as one.
   */
  const route = (sql: string): StatementRoute & { driver: SqlDriver } => {
    const decision = routeStatement(sql);
    if (decision.mixed && !shared) {
      throw new Error(
        `A statement cannot be run against two stores, and this one names both: ${describeRoute(decision)}. ` +
          `The ledger is "${labels.ledger}" and the app store is "${labels.app}". ` +
          'Split it into one statement per store.',
      );
    }
    // `shared` makes the two entries the same driver, so a mixed statement that
    // reaches here routes to the ledger and is executed by its own connection.
    return { ...decision, driver: decision.store === 'app' ? app : ledger };
  };

  return {
    /**
     * The ledger's dialect, and it is the one property on this interface that is
     * genuinely not per-statement.
     *
     * Every existing caller means "the primary database" by `db.dialect` — the View
     *   Builder is the only one, and it does not, which is why it asks for the app
     *   store's driver by name instead (`routes/views.ts`). Reporting the ledger's
     *   here keeps the meaning it has always had rather than making it a property
     *   that is right for one statement and wrong for the next.
     */
    dialect: ledger.dialect,
    ping: ledger.ping,

    route,

    storeDriver(id) {
      return id === 'app' ? app : ledger;
    },

    stores() {
      return shared ? [summary('ledger')] : [summary('ledger'), summary('app')];
    },

    /**
     * ★ `async` IS LOAD-BEARING, and not for style. `route()` throws for a statement
     * that names both stores, and an `async` keyword is what turns that into a
     * rejected promise. Without it the throw is **synchronous**, which breaks the
     * contract every other driver's `execute` keeps (including libSQL's and
     * Oracle's): a caller that works in promises —
     * `db.execute(req).catch(...)`, which is exactly how the abandoned-statement and
     * timeout paths are written — gets an exception out of a line that other drivers
     * guarantee cannot raise one, and the `.catch` it attached is never reached.
     *
     * Caught by the smoke suite: `assert.rejects` validates the rejection *reason*
     * only for a genuinely rejected promise. Given a synchronous throw from the
     * function it was passed, Node rejects with the raw error and skips the message
     * assertion — so the check failed with the driver's own message rather than on a
     * mismatch, which is how a contract violation shows up as a "wrong expectation".
     */
    async execute(req) {
      return route(req.sql).driver.execute(req);
    },

    /**
     * The app store's transaction. See the file doc block for why it is not routed.
     * With `shared` this is the ledger's own driver, so nothing changes.
     */
    transaction: () => app.transaction(),

    async close() {
      // Sequential rather than `Promise.all`: an Oracle pool drain and a libSQL
      // close have no reason to overlap, and a rejection from one should not leave
      // the other half-closed with no explanation of which failed.
      for (const d of distinct) await d.close();
    },

    async prepare() {
      for (const d of distinct) await d.prepare();
    },

    async probeStores() {
      const results: StoreProbeResult[] = [];
      for (const id of shared ? (['ledger'] as StoreId[]) : (['ledger', 'app'] as StoreId[])) {
        const driver = id === 'app' ? app : ledger;
        const t0 = performance.now();
        try {
          // The driver's own `ping`: `SELECT 1` is ORA-00923 on a pre-23c Oracle,
          // which is why it is a property of the driver rather than a constant here.
          await driver.execute({ sql: driver.ping, args: [] });
          results.push({ ...summary(id), ok: true, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          results.push({
            ...summary(id),
            ok: false,
            ms: Math.round(performance.now() - t0),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return results;
    },
  };
}
