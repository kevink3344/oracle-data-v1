/**
 * The SQL a request actually ran, kept so the page can show it.
 *
 * ── WHY THIS EXISTS
 *
 * Staff asked to see how a number is arrived at: "the actual sql used on the page", in red, beside
 * the figures and the stat cards, behind a Settings toggle. That is a review aid, and it only works
 * if what is shown is the statement the database really ran. A hand-written copy of the SQL in the
 * frontend would be a *claim* about the number rather than evidence for it, and it would drift the
 * first time anyone edited a query — which is precisely the failure the feature exists to prevent.
 *
 * So the statement is captured where it runs, on the server, and returned with the response.
 *
 * ── WHY ASYNC LOCAL STORAGE AND NOT A PARAMETER
 *
 * The alternative is to thread a collector through every `rows()`/`one()` call site — several
 * hundred of them — or to set a field on the request and hope every query helper can reach it. The
 * helpers (`db/sql.ts`) talk to the driver seam and have no `req`; giving them one would invert the
 * layering this codebase keeps (`sql.ts` is deliberately backend-agnostic and request-agnostic).
 *
 * `AsyncLocalStorage` is the standard answer: the collector is bound to the async execution context
 * of the request, so a query anywhere inside a handler — however deep, through however many awaits —
 * finds it without being told. No signature changes, and a query run outside a request (a startup
 * probe, a script) simply finds no collector and is ignored.
 *
 * ── ★ WHY IT IS OFF UNLESS ASKED FOR, AND WHY THAT IS NOT AN OPTIMISATION
 *
 * Capturing is cheap, but *returning* it is not free of consequence: the trace is part of the
 * response body, so it would appear in every logged payload, every smoke assertion and every
 * screenshot. It is therefore collected only when the request asks for it (`?sql=1`, which the
 * frontend sends only while the toggle is on), and `sendResult` attaches it only then. A request
 * that does not ask is byte-identical to before this module existed.
 *
 * ── ★ BOUNDS, BECAUSE A TRACE IS UNBOUNDED OTHERWISE
 *
 * A page that fans out to five endpoints, each running a count and a page query, is a dozen
 * statements. A pathological handler could run hundreds. `MAX_STATEMENTS` caps what is kept, and
 * the cap is *reported* rather than silent — a truncated trace that looks complete is worse than no
 * trace, because a reader would conclude the numbers came from fewer queries than they did.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** One statement as it ran: the text, and what it cost. */
export interface SqlTraceEntry {
  /** The statement, with binds left as placeholders — never with values substituted in. */
  readonly sql: string;
  /** Wall-clock milliseconds the driver reported for this statement. */
  readonly ms: number;
  /** Rows the statement returned. `null` for a write, which returns none. */
  readonly rows: number | null;
}

interface Collector {
  readonly entries: SqlTraceEntry[];
  /** Statements seen, including any beyond the cap. */
  total: number;
}

/**
 * How many statements one request may record.
 *
 * ★ THE CAP IS A REPORTING BOUND, NOT A MEMORY GUARD. Twelve is comfortably above the widest
 *   fan-out any page in this app issues (the Budgets page fires five requests, the busiest of
 *   which runs two statements), so a normal request is never truncated. It exists so a runaway
 *   handler cannot put a megabyte of SQL in a response body.
 */
const MAX_STATEMENTS = 24;

const storage = new AsyncLocalStorage<Collector>();

/**
 * Run `fn` with statement capture active.
 *
 * Called by the request middleware for every request. The collector is created unconditionally —
 * the decision to *return* it is made later, in `sendResult`, because a handler cannot know whether
 * the caller wants the trace and a middleware cannot know whether the response will be an error.
 */
export function withSqlTrace<T>(fn: () => T): T {
  return storage.run({ entries: [], total: 0 }, fn);
}

/**
 * Record one statement, if a collector is active.
 *
 * Called from the driver seam. Deliberately total: it never throws and never alters control flow,
 * because a failure to *record* a query must never become a failure to *run* it.
 */
export function noteStatement(sql: string, ms: number, rowCount: number | null): void {
  const collector = storage.getStore();
  if (!collector) return;
  collector.total += 1;
  if (collector.entries.length >= MAX_STATEMENTS) return;
  collector.entries.push({ sql, ms: Math.round(ms * 10) / 10, rows: rowCount });
}

/** What a response carries when the caller asked for the trace. */
export interface SqlTrace {
  readonly statements: readonly SqlTraceEntry[];
  /** Statements run, which exceeds `statements.length` when the cap was reached. */
  readonly total: number;
  /** True when the cap truncated the list, so a reader is told rather than misled. */
  readonly truncated: boolean;
}

/** The trace for the current request, or `null` when none was collected. */
export function currentSqlTrace(): SqlTrace | null {
  const collector = storage.getStore();
  if (!collector || collector.entries.length === 0) return null;
  return {
    statements: collector.entries,
    total: collector.total,
    truncated: collector.total > collector.entries.length,
  };
}

/**
 * Whether this request asked for the trace.
 *
 * ★ IT IS A QUERY PARAMETER AND NOT A HEADER, DELIBERATELY. A header would be invisible in a URL a
 *   person pastes into a bug report, and the whole audience for this feature is somebody checking a
 *   figure by hand. `?sql=1` travels with the link.
 */
export function wantsSqlTrace(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  const raw = (query as Record<string, unknown>).sql;
  return raw === '1' || raw === 'true' || raw === 1 || raw === true;
}
