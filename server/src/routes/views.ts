import { createHash } from 'node:crypto';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { page } from '../http/respond.js';
import { config } from '../config/env.js';
import { storeDriver } from '../db/client.js';
import { execute, one, pageMeta, rows } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import {
  analyzeSql,
  capResult,
  maskLiterals,
  QueryTimeoutError,
  withTimeout,
  wrapForRowCap,
  type GuardFinding,
} from '../db/query-guard.js';
import {
  ViewCreateBodySchema,
  ViewDisplaySchema,
  ViewExecuteBodySchema,
  ViewParamSchema,
  ViewRowSchema,
  ViewRunResponseSchema,
  ViewRunRowSchema,
  ViewRunsQuerySchema,
  ViewStatusSchema,
  ViewUpdateBodySchema,
  ViewWatchQuerySchema,
  ViewWatchSchema,
  ViewsQuerySchema,
  type ViewDisplay,
  type ViewExecuteBody,
  type ViewFormat,
  type ViewParam,
} from '../schemas/views.js';
import { IdParamsSchema } from '../schemas/common.js';
import { z } from '../http/z.js';

/**
 * The View Builder.
 *
 * ★ WHAT THIS IS. A saved view is trusted SQL plus a declared parameter list plus
 *   a display configuration. This module runs the SQL, compiles the parameters,
 *   and reconciles the display config against what actually came back. It is not
 *   a query generator and it never rewrites what the author wrote — the one
 *   exception is the row-cap wrapper, and that is applied *around* the statement
 *   rather than inside it (see `wrapForRowCap`).
 *
 * ★ THE GUARDS ARE THE FEATURE, and they live in `db/query-guard.ts` so they are
 *   pure and testable without a database. This file is the part that has to make
 *   decisions the guard cannot: what to do when the driver itself refuses a
 *   statement, when a declared parameter has no value, and when the display
 *   config names a column that is gone.
 *
 * ★ PREVIEW AND RUN ARE DIFFERENT ENDPOINTS ON PURPOSE.
 *   `POST /api/views/preview` runs SQL that has never been saved and records
 *   nothing. It is the only way to test an idea, and it must work before the view
 *   exists — which is why it takes the SQL in the body rather than an id, and why
 *   it is a POST rather than a GET with `?sql=`: a query string is what ends up in
 *   every access log along the path.
 *
 *   `POST /api/views/{id}/run` runs a *saved* view and writes a history row. It
 *   therefore needs the app tables and a writable database, and refuses without
 *   either. Preview does not, which is what makes the whole feature usable in
 *   phase 1 against a read-only target.
 */

/* ------------------------------------------------------------------------- *
 * Gate
 * ------------------------------------------------------------------------- */

/**
 * The opt-in switch, checked by everything in this domain that *does* something.
 *
 * ★ THE SPLIT IS THE DESIGN, AND IT IS EXACTLY ONE SENTENCE: this guards anything
 *   that executes SQL or writes a row, and nothing else. So the three endpoints
 *   that run a statement — preview, run, and the create/update paths that validate
 *   one — and the three that write are gated; `GET /api/views`, `GET
 *   /api/views/{id}`, the run history and the subscription lists are not.
 *
 * ★ WHY THE READS COME OUT. The flag exists because this is the one endpoint in
 *   this API whose input is executable, and turning that off is a decision about
 *   what the server will *do*, not about what it will *say*. A Saved Views page
 *   that died along with it would be a page that looks broken on a server that is
 *   working — the reader has no way to tell "switched off" from "no such table" —
 *   and the table it draws is already sitting in the database either way. Refusing
 *   to render it protects nothing: whoever can reach this server can read the same
 *   rows through `/api/activity` and every other page.
 *
 * ★ WHAT THE FLAG IS NOT: an access control, and it never was. This domain is
 *   unauthenticated on purpose-right-now — sessions exist
 *   (`POST /api/auth/sign-in`) but no route under `/api/views` checks one, so a
 *   request either reaches the server or does not. The flag bounds the *blast
 *   radius* of the one feature that runs SQL; it does not decide who may use the
 *   app. Whoever makes the reads session-scoped should revisit this whole comment,
 *   because at that point there *is* a check to lean on.
 *
 * 409 `WRITES_DISABLED` rather than a new code, because the situation is exactly
 * the one that code already describes — a server configuration refuses a
 * well-formed request, and the caller cannot fix it by changing the request. A
 * second code for "the same thing but from a different module" would make every
 * client handle two shapes for one condition.
 */
function assertEnabled(): void {
  if (config.viewBuilder.enabled) return;
  throw AppError.writesDisabled(
    'The View Builder is switched off. It is the one endpoint in this API whose input is executable, ' +
      'and it is **unauthenticated** — sessions exist (`POST /api/auth/sign-in`) but no route under ' +
      '/api/views checks one, so enabling this is a decision about who can reach the server at all ' +
      'rather than about who is allowed to. Saved views, their run history and their subscriptions ' +
      'can still be *read*; what is refused is running SQL, saving a view, and subscribing. ' +
      'Set VIEW_BUILDER_ENABLED=1 in .env and restart the server to turn it on.',
  );
}

/* ------------------------------------------------------------------------- *
 * Statement execution
 * ------------------------------------------------------------------------- */

interface Executed {
  /** Cells, aligned to `columns`. */
  rows: (string | number | null)[][];
  columns: string[];
  limit: number;
  truncated: boolean;
  durationMs: number;
  findings: GuardFinding[];
  /**
   * Every parameter that was bound, with the value that was actually used.
   *
   * Returned because "the query ran" and "the query ran with the period you
   * meant" are different, and a default that silently filled a parameter is the
   * most likely way to get a plausible result for the wrong question.
   */
  applied: Record<string, string | number | null>;
}

/**
 * Run one statement under every guard.
 *
 * The order is the guard's order, and each step is here because skipping it
 * changes the answer rather than the error message:
 *
 *   1. gate                — off means nothing runs at all
 *   2. `analyzeSql`        — everything that can be refused before the database
 *                            sees the text: empty, multi-statement, denied
 *                            keyword, not a SELECT, Oracle-only dialect
 *   3. parameter compile   — undeclared tokens, missing values
 *   4. `query_only`        — SQLite only, and only a second layer (see below)
 *   5. row cap wrapper     — the one statement the server appends
 *   6. timeout             — bounds the *request*, not the query, and only on a
 *                            driver that yields while it waits (see `withTimeout`;
 *                            measured: the local file driver does not)
 */
async function runStatement(input: {
  sql: string;
  params: ViewParam[];
  values: Record<string, string | number | null> | undefined;
  viewId: number | null;
  kind: 'preview' | 'run';
}): Promise<Executed> {
  assertEnabled();

  /**
   * ★ THE VIEW BUILDER RUNS AGAINST THE APP STORE, NAMED RATHER THAN ROUTED.
   *   Everything in this module is app-owned: the SQL is written by a user against
   *   the schema the builder shows them, the guard is SQLite's, the row cap is
   *   appended as a SQLite `LIMIT`, and the results land in `saved_view_run`. Its
   *   dialect is therefore a property of *this feature*, not of the statement text.
   *
   *   Routing it by the tables the text mentions would make the dialect — and with
   *   it the `query_only` layer, the `LIMIT` wrapper and the Oracle-only refusal —
   *   a function of whatever the author happened to type. A query mentioning
   *   `GL_BALANCES` would be compiled as Oracle and then executed (by routing)
   *   against whatever store `GL_BALANCES` lives in, which is the ledger — so a
   *   preview would read the production ledger directly and return rows through a
   *   path that was audited as reading the sample. Asking for the store by name
   *   keeps the sandbox a sandbox: one dialect, one schema, one target.
   */
  const vstore = storeDriver('app');

  const analysis = analyzeSql(input.sql, vstore.dialect);
  if (analysis.rejection) {
    throw AppError.badRequest(analysis.rejection.message, {
      code: analysis.rejection.code,
      ...analysis.rejection.details,
    });
  }

  const { binds, warnings } = compileParams(analysis.params, input.params, input.values);
  const findings = [...analysis.findings, ...warnings];

  const limiter = config.viewBuilder.maxRows;
  const wrapped = wrapForRowCap(analysis.statement, limiter, vstore.dialect);

  const started = performance.now();
  let raw: { rows: Record<string, unknown>[]; columns?: string[] };

  // ★ LAYER 4 OF THE SECURITY DESIGN, AND THE WEAKEST ONE.
  //   `PRAGMA query_only = ON` makes the connection refuse table and temp writes.
  //   It is worth having and it is NOT what makes this safe:
  //
  //     - it does not block `ATTACH` (measured — the plan's G4), and
  //     - it applies to whichever connection serves the statement, and the
  //       libSQL client is not guaranteed to use the same one for the restore
  //       below.
  //
  //   The statement allowlist above is what actually holds. This is the extra
  //   layer for the case where the allowlist has a hole nobody has found yet.
  //   It is set only for SQLite, because the pragma is a syntax error on Oracle
  //   and there is no equivalent.
  const pragma = vstore.dialect === 'sqlite';
  if (pragma) await setQueryOnly(true);
  try {
    raw = await withTimeout(
      vstore.execute({ sql: wrapped, args: binds }),
      config.viewBuilder.timeoutMs,
      `The statement did not finish within ${config.viewBuilder.timeoutMs}ms. ` +
        'It was stopped from the request side; the database may still be working on it. ' +
        'Narrow it with a filter, an indexed column, or a smaller period, then run it again.',
    );
  } catch (e) {
    // ★ THE RESTORE IS NOT AWAITED ON THE FAILURE PATH, AND THAT IS THE POINT.
    //   The connection is still busy with the statement that just timed out, so
    //   `PRAGMA query_only = OFF` queues behind it — and awaiting it here would
    //   hold the response for exactly as long as the query the timeout gave up on.
    //   That would leave the timeout bounding the promise while the caller still
    //   waits, which is the one thing it must not do. Fire-and-forget keeps the
    //   request bounded; the cost is that `query_only` may stay on for the life of
    //   a statement that is already abandoned, which affects only that statement.
    if (pragma && e instanceof QueryTimeoutError) void setQueryOnly(false);
    throw asSqlError(e, analysis.statement, findings);
  }
  if (pragma) await setQueryOnly(false);

  const durationMs = Math.round(performance.now() - started);

  const columns = columnNames(raw.columns, raw.rows);
  const capped = capResult(raw.rows, limiter);
  const cells = capped.rows.map((r) => normaliseRow(r, columns));

  logExecution(input.kind, input.viewId, analysis.statement, binds, durationMs, cells.length, capped.truncated);

  return {
    rows: cells,
    columns,
    limit: limiter,
    truncated: capped.truncated,
    durationMs,
    findings,
    applied: binds,
  };
}

/**
 * Turn a driver failure on *user* SQL into a 400 that quotes the driver.
 *
 * ★ THE MESSAGE IS THE DRIVER'S OWN TEXT, UNPREFIXED. V2 in the plan asks for
 *   "the verbatim driver message, not a 500" — and the reason is that the message
 *   is the whole diagnostic. `near "(": syntax error` tells the author where to
 *   look; "the query could not be run" does not, and a paraphrase that tidies the
 *   wording is a paraphrase the author has to map back to their own SQL.
 *
 *   So the message is passed through untouched, and the server's own commentary
 *   goes in `details`, where the client can show it beneath rather than instead.
 *
 * ★ WHY EVERY DRIVER ERROR FROM THIS PATH IS A 400. The statement came from the
 *   caller, so a syntax error, an unknown table, a wrong arity — all of them are
 *   properties of the request. The exceptions are genuinely internal (a connection
 *   that dropped mid-flight), and those are not distinguishable from here, so
 *   they will read as 400 too. That is the deliberate trade: on this endpoint a
 *   misleading 400 is far more likely to be the true answer than a 500, and a 500
 *   would send the author to the server logs for something their own SQL caused.
 */
function asSqlError(e: unknown, statement: string, findings: GuardFinding[]): AppError {
  if (e instanceof QueryTimeoutError) {
    return AppError.badRequest(e.message, { code: 'TIMEOUT', statement });
  }

  const err = e as { code?: unknown; message?: unknown } | null | undefined;
  const message = typeof err?.message === 'string' ? err.message : String(e);
  const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN';

  return AppError.badRequest(message, {
    code,
    statement,
    // ★ THE NAMED PORT TRAVELS WITH THE DRIVER'S ERROR. "no such function: TRUNC"
    //   reads like a server fault; the finding that says `TRUNC(SYSDATE)` is
    //   Oracle-only and `date('now')` is the port is what turns it into an edit.
    //   Attached only when there is one, so a plain typo is not dressed up as a
    //   dialect problem.
    ...(findings.length > 0 ? { findings } : {}),
    // ★ THE HINT HAS TO BE TRUE FOR THE ERROR IT IS ATTACHED TO. This one is on every
    //   driver failure — V2 requires it, because the message is the driver's and the
    //   server's own commentary has to sit alongside rather than instead — so it is
    //   the one piece of copy that cannot assume a cause. It used to end "a column
    //   that exists in EBS but not in the sample is the usual cause", which is right
    //   for `no such column` and simply false under `near "FROM": syntax error`. A
    //   hint that names the wrong cause is the failure mode §4 warns about, one step
    //   short of rewriting the query: it sends the author to the dialect table for a
    //   statement that has no dialect in it.
    //
    //   So the cause is stated conditionally and the authority is named rather than
    //   guessed at. When a named port *is* in hand the guess is gone and the hint
    //   collapses back to the pointer — which is the only case where §4 is the
    //   specific right answer rather than one possibility among several.
    hint:
      storeDriver('app').dialect !== 'sqlite'
        ? 'Check the column and table names against the schema this connection can see.'
        : findings.length > 0
          ? 'The sample database is SQLite, not Oracle — check the dialect table in docs/plans/view-builder.md §4.'
          : 'The sample database is SQLite, not Oracle, so a construct or a column that exists only in EBS is ' +
            'missing here even when the statement is valid against the real schema. The driver’s message above ' +
            'is the authority on which; the known Oracle-only constructs and their ports are in ' +
            'docs/plans/view-builder.md §4.',
  });
}

/** Set or clear `PRAGMA query_only`. Best-effort: a failure must not mask the real error. */
async function setQueryOnly(on: boolean): Promise<void> {
  try {
    // The app store by name, for the same reason as `runStatement`: the pragma is a
    // statement with no table in it, so routing would send it to the ledger — which
    // under a divergent configuration is Oracle, where it is a syntax error and the
    // layer silently evaporates.
    await storeDriver('app').execute({ sql: `PRAGMA query_only = ${on ? 'ON' : 'OFF'}`, args: [] });
  } catch {
    /* A backend that will not accept the pragma is one where it was never a layer. */
  }
}

/**
 * The column list for a result.
 *
 * Driven by the driver's own metadata when it has it, because a result with zero
 * rows still has columns and `Object.keys(rows[0])` reports none. Falling back to
 * the first row keeps a backend without metadata working for the non-empty case,
 * which is the common one.
 *
 * ★ DUPLICATE NAMES ARE COLLAPSED. `SELECT a.id, b.id` returns two columns with
 *   one key each, and a row is a plain object, so the second value is unreachable
 *   by name — the two cells would render the same number. Collapsing is honest
 *   about that; emitting both would render the first value twice and look like a
 *   join that had matched rows it did not. Aliasing is the fix and it is the
 *   author's to make.
 */
function columnNames(metadata: string[] | undefined, resultRows: Record<string, unknown>[]): string[] {
  const source = metadata ?? Object.keys(resultRows[0] ?? {});
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of source) {
    const key = String(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * One row as cells, in column order.
 *
 * `bigint` and `Uint8Array` both have to be converted rather than passed through,
 * because the response is JSON and neither survives serialisation — `JSON.stringify`
 * throws on a bigint, which would turn a successful query into a 500.
 */
function normaliseRow(row: Record<string, unknown>, columns: string[]): (string | number | null)[] {
  return columns.map((c) => toCell(row[c]));
}

/**
 * ★★ A `Date` MUST BECOME AN ISO STRING, NOT `String(date)`.
 *
 * This function's `default` branch is `String(value)`, and for a `Date` that produces
 * **`Date.prototype.toString()`** — `"Mon Jul 20 2026 20:00:00 GMT-0400 (Eastern
 * Daylight Time)"`. That is not a bug in the *value*; it is a bug in the *shape*,
 * and it is invisible until something tries to parse it.
 *
 * ★ MEASURED, AND THE SYMPTOM WAS A DATE COLUMN RENDERING AS `"Mon Jul 20"`. The
 *   client's `isoDay` is `String(value).slice(0, 10)`, which assumes an ISO string —
 *   so slicing `Date.toString()` yields the first ten characters of the *weekday*.
 *   The column showed a day name and a month name and no year, and the cause was
 *   three layers away from the display.
 *
 * ★ AND IT SHIFTS THE DAY. `Date.toString()` renders in the SERVER'S local zone, so
 *   a stored `2026-07-21` (midnight UTC) prints as `Jul 20 20:00 EDT` — the date
 *   moves back a day. `toISOString()` is UTC and does not.
 *
 * ★ A `Date` IS THE ONE TYPE THAT DID *NOT* NEED CONVERTING FOR SERIALISATION.
 *   `JSON.stringify(new Date())` already produces `"2026-07-21T00:00:00.000Z"`, so
 *   passing it through would have been correct — the `default` branch was actively
 *   breaking a value that would otherwise have survived. This case exists to undo
 *   that, and it is written first among the object cases so no later branch can
 *   reach it.
 */
function toCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Uint8Array) return `<${value.byteLength} byte blob>`;
  // ★ AN INVALID DATE IS NOT A DATE. `new Date('nonsense').toISOString()` THROWS
  //   `RangeError: Invalid time value`, which would turn a successful query into a
  //   500 — the same class of failure the bigint case above exists to prevent. A
  //   null is the honest answer for a value that is not a usable date.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

/**
 * One line per executed statement.
 *
 * The plan's §5.4 asks for this, and it is the only record that exists: **this
 * route requires no session**, so "who ran what" cannot be answered from a user
 * identity even though the server can now resolve one. What it can answer is
 * "which statement was running when it went wrong", which is the question that
 * actually gets asked.
 *
 * ★ BIND VALUES ARE NOT LOGGED, ONLY NAMES. A log is the least controlled place
 *   this data goes — it is copied, shipped and grepped — and a parameter value is
 *   whatever the caller typed. The names are enough to see the shape of the call,
 *   and the values are reproducible from the screen.
 */
function logExecution(
  kind: 'preview' | 'run',
  viewId: number | null,
  statement: string,
  binds: Record<string, string | number | null>,
  durationMs: number,
  rowCount: number,
  truncated: boolean,
): void {
  const bound = Object.keys(binds);
  console.log(
    `[views] ${kind} view=${viewId ?? '-'} ${durationMs}ms rows=${rowCount}${truncated ? '+' : ''}` +
      `${bound.length ? ` binds=${bound.join(',')}` : ''} sql=${clip(statement, 240)}`,
  );
}

function clip(sql: string, max: number): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/* ------------------------------------------------------------------------- *
 * Parameters
 * ------------------------------------------------------------------------- */

interface CompiledParams {
  binds: Record<string, string | number | null>;
  /** Declared but unused, or declared without a value that was used. Never fatal. */
  warnings: GuardFinding[];
}

/**
 * Compile declared parameters into named binds.
 *
 * ★ A VALUE IS NEVER SUBSTITUTED INTO THE SQL. The driver binds it, so the text
 *   the database parses is exactly the text the author wrote — no quoting rules,
 *   no escaping, and no way for a value to become syntax. This is also why every
 *   `:token` in the statement must be declared: an undeclared token would have no
 *   bind, and libSQL would answer "missing named parameter", which names nothing.
 *
 * Three outcomes, and they are deliberately different:
 *
 *   - a `:token` in the SQL with no declaration  → **400**, naming the token. The
 *     statement cannot run and the author has to fix the declaration list.
 *   - a declaration with no value and no default → **400, before the query runs**.
 *     Discovered here rather than by the driver, so the message can name the
 *     parameter instead of the placeholder index.
 *   - a declaration the SQL does not use          → **a warning, not an error**.
 *     The author is almost certainly mid-edit, and refusing to run a query that
 *     is otherwise correct because of one stale declaration would be the wrong
 *     trade in a tool whose whole point is trying things.
 */
function compileParams(
  tokens: string[],
  declared: ViewParam[],
  supplied: Record<string, string | number | null> | undefined,
): CompiledParams {
  const byName = new Map(declared.map((p) => [p.name, p]));

  for (const token of tokens) {
    if (!byName.has(token)) {
      throw AppError.badRequest(
        `The SQL uses \`:${token}\`, which is not a declared parameter. ` +
          'A parameter has to be declared before it can be bound — an undeclared one has no value ' +
          'to bind and no type to validate against. Add it to the parameter list, or replace the ' +
          '`:token` in the SQL with a literal.',
        { code: 'UNDECLARED_PARAM', token, declared: [...byName.keys()] },
      );
    }
  }

  const binds: Record<string, string | number | null> = {};
  for (const param of declared) {
    // Only the tokens the statement actually names become binds. Binding an
    // unused name is refused by some drivers and ignored by others, and neither
    // behaviour is worth depending on.
    if (!tokens.includes(param.name)) continue;

    const suppliedValue = supplied?.[param.name];
    const value = suppliedValue === undefined ? param.default : suppliedValue;

    if (value === undefined) {
      throw AppError.badRequest(
        `The parameter \`:${param.name}\` has no value and no default. ` +
          'Supply one, or give it a default so the view can be run without input.',
        { code: 'MISSING_PARAM_VALUE', param: param.name, type: param.type },
      );
    }

    binds[param.name] = coerceParam(param, value);
  }

  const warnings: GuardFinding[] = declared
    .filter((p) => !tokens.includes(p.name))
    .map((p) => ({
      code: 'UNUSED_PARAM',
      severity: 'warning' as const,
      construct: `:${p.name}`,
      message: `The declared parameter \`:${p.name}\` does not appear in the SQL.`,
      fix: `Remove it, or use \`:${p.name}\` in the statement.`,
      index: 0,
    }));

  return { binds, warnings };
}

function coerceParam(param: ViewParam, value: string | number | null): string | number | null {
  if (value === null) return null;

  if (param.type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
      throw AppError.badRequest(
        `\`:${param.name}\` is declared as a number, but ${JSON.stringify(value)} is not one.`,
        { code: 'PARAM_TYPE', param: param.name, type: param.type },
      );
    }
    return n;
  }

  if (param.type === 'date') {
    const text = String(value).trim();
    // `YYYY-MM` is allowed as well as `YYYY-MM-DD`, because the fiscal period is
    // the grain most of this schema is queried at and `PERIOD_NAME` is stored as
    // `YYYY-MM`. Anything else is refused with the expected shape named.
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(text)) {
      throw AppError.badRequest(
        `\`:${param.name}\` is declared as a date, but ${JSON.stringify(value)} is not ` +
          '`YYYY-MM` or `YYYY-MM-DD`.',
        { code: 'PARAM_TYPE', param: param.name, type: param.type },
      );
    }
    return text;
  }

  return String(value);
}

/* ------------------------------------------------------------------------- *
 * Display reconciliation
 * ------------------------------------------------------------------------- */

const DEFAULT_FORMAT: ViewFormat = 'text';

interface Reconciled {
  columns: { key: string; label: string; format: ViewFormat; hidden: boolean }[];
  /** Presentation order into the cell arrays, so the client never re-sorts. */
  order: number[];
  drift: { key: string; message: string }[];
}

/**
 * Apply `display_json` to the columns the query actually returned.
 *
 * ★ DRIFT IS A NOTICE, NOT A FAILURE — the plan's §15 decision. A view whose SQL
 *   changed shape is *still a working query*, and refusing to show its result
 *   because a label no longer matches would turn a cosmetic omission into a total
 *   outage of the thing the person is trying to look at. So: render every column
 *   that exists, and say plainly which declared ones do not.
 *
 * ★ HIDDEN COLUMNS ARE RETURNED, NOT DROPPED. The column picker has to be able to
 *   offer them back, and a client that cannot see a column cannot un-hide it. The
 *   `hidden` flag is what the grid uses to skip them.
 */
function reconcileDisplay(display: ViewDisplay, actual: string[]): Reconciled {
  const actualByLower = new Map(actual.map((c) => [c.toLowerCase(), c]));
  const hidden = new Set((display.hidden ?? []).map((h) => h.toLowerCase()));

  const declared = display.columns ?? [];
  const used = new Set<string>();
  const ordered: Reconciled['columns'] = [];

  // Declared columns first, in the declared order — but only where they still
  // exist. A declared key is matched case-insensitively because SQLite hands back
  // whatever case the SQL used while the display config was written by hand.
  for (const entry of declared) {
    const match = actualByLower.get(entry.key.toLowerCase());
    if (!match) continue;
    used.add(match);
    ordered.push({
      key: match,
      label: entry.label ?? defaultLabel(match),
      format: entry.format ?? DEFAULT_FORMAT,
      hidden: hidden.has(match.toLowerCase()),
    });
  }

  // Then everything the query returned that the config did not mention. These are
  // shown rather than suppressed: a new column in a saved query is information,
  // and the one thing a result grid must not do is quietly omit it.
  for (const key of actual) {
    if (used.has(key)) continue;
    ordered.push({
      key,
      label: defaultLabel(key),
      format: DEFAULT_FORMAT,
      hidden: hidden.has(key.toLowerCase()),
    });
  }

  const drift = declared
    .filter((entry) => !actualByLower.has(entry.key.toLowerCase()))
    .map((entry) => ({
      key: entry.key,
      // The plan's own wording, kept because it is the sentence the author needs:
      // it says what happened, to which column, and the consequence in one line.
      message: `\`${entry.key}\` is hidden because the query no longer returns it.`,
    }));

  // Source index for each projected column, so the client reads `row[i]` for
  // `columns[i]` and never has to look a value up by name.
  const order = ordered.map((c) => actual.indexOf(c.key));

  return { columns: ordered, order, drift };
}

/**
 * Sort the returned rows by `display.sort`.
 *
 * ★ IN PROCESS, NOT IN THE SQL. The statement belongs to the author, and this
 *   server appends exactly one thing to it (the row cap). Rewriting the query to
 *   add an `ORDER BY` would mean parsing SQL, deciding where the clause goes
 *   relative to any the author already wrote, and having an opinion about whether
 *   to overrule it — all to sort a result that is capped at a few hundred rows
 *   and already in memory.
 *
 * ★ AND IT CAN ONLY EVER SEE THE CAPPED ROWS. Sorting here sorts what came back,
 *   which is not the same as sorting the whole result — the cap was applied before
 *   any of this. So a `display.sort` on a truncated result is a sort *of the
 *   sample*, and the response says the result was truncated, which is what makes
 *   that readable rather than misleading.
 *
 * ★ NULLS LAST, IN BOTH DIRECTIONS. `null` in this data means "no value", and
 *   `null` answering "smallest" would put every missing vendor at the top of an
 *   ascending sort. Missing is not small; it is missing.
 */
function sortRows(
  rows: (string | number | null)[][],
  columns: Reconciled['columns'],
  order: number[],
  display: ViewDisplay,
): (string | number | null)[][] {
  if (!display.sort) return rows;

  const projected = columns.findIndex((c) => c.key.toLowerCase() === display.sort!.key.toLowerCase());
  if (projected < 0) {
    // The sort names a column that is gone. That is drift of the same kind as a
    // missing display column, and it is reported the same way — by not sorting
    // and letting the drift list explain it, rather than by refusing the result.
    return rows;
  }

  const source = order[projected];
  if (source === undefined || source < 0) return rows;
  const dir = display.sort.dir === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    const av = a[source] ?? null;
    const bv = b[source] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function defaultLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/* ------------------------------------------------------------------------- *
 * Fingerprints
 * ------------------------------------------------------------------------- */

/**
 * Hash a result so "has it changed?" is comparable across runs.
 *
 * ★ WHAT THIS CAN AND CANNOT SEE. It hashes the row count plus the values of one
 *   declared key column, in the order the statement returned them. A change that
 *   adds or removes a row changes it. A change that edits a value in the key
 *   column changes it. **A change that edits any other column, or that replaces
 *   one row while removing another, does not** — and no hash of a sample can fix
 *   that, because the whole point of hashing a sample is not to read the whole
 *   result.
 *
 *   The screen states the limitation rather than implying a guarantee. A "no
 *   changes" that means "no changes of the kind I can see" is useful; the same
 *   words meaning "nothing changed" are a lie.
 */
function fingerprint(executed: Executed, key: string | undefined): string | null {
  if (!key) return null;
  const index = executed.columns.findIndex((c) => c.toLowerCase() === key.toLowerCase());
  if (index < 0) return null;

  const hash = createHash('sha256');
  hash.update(String(executed.rows.length));
  for (const row of executed.rows) {
    hash.update('\u0000');
    hash.update(row[index] === null ? '\u0001null' : String(row[index]));
  }
  return hash.digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------------- *
 * Storage helpers
 * ------------------------------------------------------------------------- */

interface ViewDbRow {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  sql: string;
  params_json: string;
  display_json: string;
  created_by: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const VIEW_COLUMNS =
  'id, slug, title, description, sql, params_json, display_json, created_by, status, created_at, updated_at';

/**
 * A stored row, as the API returns it.
 *
 * ★ THE JSON COLUMNS ARE PARSED HERE, AND A BAD VALUE DOES NOT FAIL THE ROW.
 *   `params_json` and `display_json` are TEXT — SQLite has no JSON type — so a
 *   hand-edited database can hold anything. Throwing on it would make one bad row
 *   break the whole list, and the list is how you would find the bad row. So an
 *   unparseable value degrades to the empty default, and the fact is logged.
 *
 *   Validated through the same Zod schema the write path uses, which is what makes
 *   "the shape on the way out" and "the shape on the way in" the same shape.
 */
function toView(row: ViewDbRow): z.infer<typeof ViewRowSchema> {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    description: row.description,
    sql: row.sql,
    params: parseJsonArray(row.params_json, row.slug),
    display: parseJsonObject(row.display_json, row.slug),
    created_by: row.created_by,
    status: row.status as z.infer<typeof ViewStatusSchema>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * A history row as the API returns it.
 *
 * ★ `truncated` IS CONVERTED FROM SQLITE'S 0/1 TO A REAL BOOLEAN HERE, AND THAT IS
 *   NOT COSMETIC. SQLite has no boolean type, so the column is an integer — and an
 *   integer cannot express the third state that matters. `null` means the run
 *   produced no result (it was refused before it reached the database); `false`
 *   means the recorded count is the whole answer; `true` means it is a floor. A
 *   client handed `0` and `null` as two numbers would have to be told which meant
 *   which, and the whole reason this column exists is that this project has already
 *   once read a meaning into a nullable count that was not there.
 */
function toRunRow(row: RunDbRow): z.infer<typeof ViewRunRowSchema> {
  return {
    id: Number(row.id),
    view_id: Number(row.view_id),
    ran_at: row.ran_at,
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    row_count: row.row_count === null ? null : Number(row.row_count),
    truncated: row.truncated === null ? null : Number(row.truncated) === 1,
    fingerprint: row.fingerprint,
    error: row.error,
  };
}

interface RunDbRow {
  id: number;
  view_id: number;
  ran_at: string;
  duration_ms: number | null;
  row_count: number | null;
  truncated: number | null;
  fingerprint: string | null;
  error: string | null;
}

/** One row of the watch join — a subscription, its view, and the readings from its runs. */
interface WatchDbRow {
  subscription_id: number;
  subscriber: string;
  channel: 'in_app' | 'webhook';
  subscribed_at: string;
  view_id: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  display_json: string;
  current_ran_at: string | null;
  current_count: number | null;
  current_truncated: number | null;
  current_fingerprint: string | null;
  last_ran_at: string | null;
  last_error: string | null;
  subscribed_ran_at: string | null;
  subscribed_count: number | null;
  subscribed_truncated: number | null;
}

/**
 * A watch as the API returns it.
 *
 * ★ EVERY NULLABLE NUMBER IS CHECKED FOR NULL BEFORE `Number()` IS APPLIED, AND THE
 *   REASON IS THE ONE THIS WHOLE FEATURE KEEPS RUNNING INTO. `Number(null)` is `0`,
 *   not `NaN` and not an error — so a view that has never run would report a row
 *   count of zero, and zero is a number a reader believes. The distinction the page
 *   has to preserve is "never run" (dash) against "ran and found nothing" (0), and
 *   it survives only if the conversion is guarded at every one of these fields.
 *
 * `fingerprint_key` is read out of the display config rather than stored separately,
 * which is what keeps it impossible for the two to disagree.
 *
 * ★ `current_fingerprint` IS HERE FOR ONE DECISION THE CLIENT HAS TO MAKE, AND
 *   WITHOUT IT THE PAGE WOULD LIE. `fingerprint()` returns null in two completely
 *   different situations: when the view declares no key (refused at subscribe time,
 *   so it cannot reach this row), and when the run *succeeded* but the query no
 *   longer returns the declared key column — drift. That second case records
 *   `error: null`, so a row carrying only the error would read as "ran, fine, and
 *   nothing has changed since" for a view whose change detection has silently
 *   stopped working. A null fingerprint on a successful run is the only evidence of
 *   drift there is, so it travels rather than being inferred from a count.
 *
 * ★ `current_*` AND `last_*` ARE DELIBERATELY TWO DIFFERENT RUNS, AND COLLAPSING
 *   THEM LOSES THE MOST USEFUL NUMBER ON THE PAGE. `current_*` describes the newest
 *   run that produced a result (`row_count IS NOT NULL`) — the last time this view
 *   worked. `last_*` describes the newest run *of any kind*, so a failed attempt is
 *   visible as itself. A single subquery over "the newest run" would make a failure
 *   blank the count, because `recordRun` writes null counts for a run that did not
 *   finish — so a reader would see a dash where the last known figure belongs, and
 *   lose the one thing that tells them whether the view is still doing anything.
 *
 * ★ `subscribed_truncated` EXISTS FOR THE SAME REASON `current_truncated` DOES, AND
 *   THE PAIR IS THE WHOLE POINT OF THE SCREEN. The two figures on a row are read side
 *   by side — "when I subscribed" against "now" — so a baseline that reached the cap
 *   has to be marked as a floor exactly as the current one is. Without it, a view that
 *   found 200 rows when you subscribed and 200 rows at the cap today renders as
 *   `200` beside `200+`, which reads as *nothing has changed* for a view that has been
 *   growing the whole time. It is the same number and the same cap; only one of the
 *   two is labelled.
 */
function toWatch(row: WatchDbRow, lastChangeAt: string | null): z.infer<typeof ViewWatchSchema> {
  const display = parseJsonObject(row.display_json, row.slug);
  return {
    subscription_id: Number(row.subscription_id),
    subscriber: row.subscriber,
    channel: row.channel,
    subscribed_at: row.subscribed_at,
    view_id: Number(row.view_id),
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status as z.infer<typeof ViewStatusSchema>,
    fingerprint_key: display.fingerprint?.key ?? null,
    current_ran_at: row.current_ran_at,
    current_count: row.current_count === null ? null : Number(row.current_count),
    current_truncated: row.current_truncated === null ? null : Number(row.current_truncated) === 1,
    current_fingerprint: row.current_fingerprint,
    last_ran_at: row.last_ran_at,
    last_error: row.last_error,
    subscribed_ran_at: row.subscribed_ran_at,
    subscribed_count: row.subscribed_count === null ? null : Number(row.subscribed_count),
    subscribed_truncated:
      row.subscribed_truncated === null ? null : Number(row.subscribed_truncated) === 1,
    last_change_at: lastChangeAt,
  };
}

function parseJsonArray(raw: string, slug: string): ViewParam[] {
  try {
    const parsed = ViewParamSchema.array().safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn(`[views] ${slug}: params_json did not match the declared shape — treating as empty.`);
  } catch {
    console.warn(`[views] ${slug}: params_json is not JSON — treating as empty.`);
  }
  return [];
}

/**
 * The stored display config, parsed — or `{}` when it cannot be.
 *
 * ★★ A FAILED PARSE DISCARDS THE WHOLE CONFIG, SO IT MUST SAY WHY.
 *
 *   Returning `{}` means every column is drawn un-hidden, every label and format
 *   is lost, and no display sort applies. That is the correct *fallback* — a grid
 *   that draws the raw result is better than one that refuses — but it is a
 *   destructive fallback, and the first version reported it with nothing but
 *   `console.warn('did not match the declared shape')`.
 *
 *   ★ THE COST OF THAT SILENCE, MEASURED. A `sort: null` written by a client
 *     (the natural JSON spelling of "no sort") failed `.optional()` — which accepts
 *     `undefined` and rejects `null` — so the entire config was thrown away. The
 *     symptom was "the columns I hid came back", which reads as a bug in the
 *     `hidden` handling, three fields away from the cause. Finding it needed the
 *     server log, and the log named the shape but not the field.
 *
 *   ★ SO THE WARNING NAMES THE PATHS. `error.issues` carries `path` and `message`
 *     per problem, which turns "did not match the declared shape" into
 *     `sort: Expected object, received null` — the sentence that ends the search.
 *     The value is NOT logged: a display config holds no secrets, but a habit of
 *     echoing stored JSON into logs is how something that does gets logged later.
 */
function parseJsonObject(raw: string, slug: string): ViewDisplay {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    console.warn(`[views] ${slug}: display_json is not JSON — treating as empty.`);
    return {};
  }

  const parsed = ViewDisplaySchema.safeParse(parsedJson);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  console.warn(
    `[views] ${slug}: display_json did not match the declared shape — treating as empty. ` +
      `The whole config is discarded, so every column will be drawn un-hidden. Problems: ${issues}`,
  );
  return {};
}

function meta(limit: number, offset: number, total: number, returned: number) {
  return pageMeta({ limit, offset }, total, returned);
}

/** Escape LIKE wildcards, so a search for `50%` does not match everything. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Validate a definition before it is stored.
 *
 * ★ VALIDATION ON WRITE, NOT ON RUN. A view that cannot run should not be saved,
 *   and this is where "cannot run" is knowable cheaply: the statement is
 *   analyzable, and the parameter list is complete. The one thing deliberately
 *   *not* checked here is whether the query's columns match `display_json` —
 *   answering that means running the query, and a save that quietly executes
 *   something is a save that can be slow, or can be refused by a read-only
 *   backend, for a reason the author did not ask for. Drift is reported at run
 *   time instead, which is where the plan's §15 decision puts it.
 */
function validateDefinition(sql: string, params: ViewParam[]): void {
  const analysis = analyzeSql(sql, storeDriver('app').dialect);
  if (analysis.rejection) {
    throw AppError.badRequest(analysis.rejection.message, {
      code: analysis.rejection.code,
      ...analysis.rejection.details,
    });
  }

  const declared = new Set(params.map((p) => p.name));
  for (const token of analysis.params) {
    if (!declared.has(token)) {
      throw AppError.badRequest(
        `The SQL uses \`:${token}\`, which the parameter list does not declare. ` +
          'Declare it, or replace the token with a literal.',
        { code: 'UNDECLARED_PARAM', token },
      );
    }
  }

  const duplicates = params.map((p) => p.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (duplicates.length) {
    throw AppError.validation(`The parameter \`:${duplicates[0]}\` is declared more than once.`, {
      code: 'DUPLICATE_PARAM',
      param: duplicates[0],
    });
  }
}

/* ------------------------------------------------------------------------- *
 * Routes
 * ------------------------------------------------------------------------- */

const Errors = [400, 404, 409, 500, 503];

export function registerViewBuilder(api: Api): void {
  /* ----------------------------------------------------------------------- *
   * Preview
   * ----------------------------------------------------------------------- */

  api.route({
    method: 'post',
    path: '/api/views/preview',
    operationId: 'views_preview',
    summary: 'Run a statement without saving anything',
    description:
      'Runs one `SELECT`/`WITH` statement and returns the result with the display configuration applied.\n\n' +
      '**Nothing is stored.** This is how a view is tried before it exists, so it takes the SQL in the body ' +
      'rather than an id. It is a `POST` because the SQL must not travel in a query string — a query string ' +
      'is what ends up in every access log along the path, and the statement is the one part of this feature ' +
      'worth keeping out of them.\n\n' +
      '**Every guard applies.** One statement only, `SELECT`/`WITH` only, no `ATTACH`/`PRAGMA`/writes, ' +
      'a row cap, and a statement timeout. Nothing here rewrites the statement: the one thing the server ' +
      'appends is the row-cap wrapper, around the statement rather than inside it.\n\n' +
      '**400, never 500, for SQL that will not run.** The driver’s own message is returned verbatim, ' +
      'because that message is the diagnostic.\n\n' +
      'Requires `VIEW_BUILDER_ENABLED=1`; otherwise 409 `WRITES_DISABLED`.',
    tags: ['Admin'],
    body: ViewExecuteBodySchema,
    response: ViewRunResponseSchema,
    // ★ 200, NOT THE POST DEFAULT OF 201. A preview creates nothing, and the plan
    //   says so outright: `SELECT 1` is a 200 with one row. Answering 201 Created
    //   would also imply a resource at a URL, and there is none to point at.
    status: 200,
    errors: Errors,
    handler: async ({ body }) => preview(body),
  });

  /* ----------------------------------------------------------------------- *
   * Saved views — CRUD
   * ----------------------------------------------------------------------- */

  api.route({
    method: 'get',
    path: '/api/views',
    operationId: 'views_list',
    summary: 'Saved views',
    description:
      'Every saved view, newest first, filtered by status and a substring of the title, slug or ' +
      'description.\n\n' +
      '★ A READ, SO IT ANSWERS WITH THE GATE OFF. `VIEW_BUILDER_ENABLED` guards anything that ' +
      'executes SQL or writes a row; what is already stored is readable either way. A surface that ' +
      'died with an authoring flag would read as broken rather than as switched off, and the flag ' +
      'is not an access control in the first place.',
    tags: ['Admin'],
    query: ViewsQuerySchema,
    response: ViewRowSchema,
    paginated: true,
    errors: Errors,
    handler: async ({ query }) => {
      await requireAppSchema();

      const where: string[] = [];
      const args: (string | number)[] = [];
      if (query.status) {
        where.push('status = ?');
        args.push(query.status);
      }
      if (query.q) {
        where.push("(title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR COALESCE(description, '') LIKE ? ESCAPE '\\')");
        const like = `%${escapeLike(query.q)}%`;
        args.push(like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = Number(
        (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM saved_view ${clause}`, args))?.n ?? 0,
      );
      const items = await rows<ViewDbRow>(
        `SELECT ${VIEW_COLUMNS} FROM saved_view ${clause} ORDER BY title, id LIMIT ? OFFSET ?`,
        [...args, query.limit, query.offset],
      );
      const mapped = items.map(toView);
      return page(mapped, meta(query.limit, query.offset, total, mapped.length));
    },
  });

  /* ----------------------------------------------------------------------- *
   * Watches — one person's subscriptions, as rows
   * ----------------------------------------------------------------------- */

  /**
   * ★ THIS ROUTE MUST BE REGISTERED BEFORE `GET /api/views/{id}`, AND NOTHING
   *   ENFORCES THAT.
   *
   *   `toExpressPath` turns `{id}` into `:id` (`http/api.ts`), so `/api/views/:id`
   *   matches the literal path `/api/views/subscriptions` — Express takes the first
   *   route that matches, and the detail route would answer with a 400 from
   *   `IdParamsSchema` because `subscriptions` is not an integer. The failure is
   *   silent in the sense that matters: the route exists, the spec documents it, the
   *   server starts, and the endpoint is unreachable.
   *
   *   It is here, immediately after the list, so the reason is visible at the point
   *   of the next edit. The same hazard would apply to any future literal path under
   *   `/api/views/`.
   */
  api.route({
    method: 'get',
    path: '/api/views/subscriptions',
    operationId: 'views_watch_list',
    summary: 'One subscriber’s watches, each with the view and its two counts',
    description:
      'The page this serves is not a list of subscriptions — it is a list of *views this person is ' +
      'watching*, and every column on it comes from somewhere else: the view’s title and status from ' +
      '`saved_view`, the counts from `saved_view_run`. So the join is done here.\n\n' +
      'Each row carries the count when the watch began (`subscribed_*`, the newest result at or ' +
      'before the subscription’s own `created_at`) and the count now (`current_*`, the newest run of ' +
      'any kind), which is the comparison the page exists to make. `last_change_at` is the most ' +
      'recent run whose fingerprint differed from the run before it, computed over the view’s whole ' +
      'history with a window function rather than reconstructed by the client from two endpoints.\n\n' +
      '★ `subscriber` IS A REQUIRED PARAMETER AND NOT A SESSION, BECAUSE THERE IS NO SESSION. No ' +
      'route under `/api/views` authenticates, so the server cannot know who is asking; taking the ' +
      'owner as an input states that instead of implying a check. The page shows the name it sent.\n\n' +
      '★ A COUNT IS NOT A TOTAL. `current_truncated` true means `current_count` is a floor.\n\n' +
      '★ `current_fingerprint` null on a run that did not fail means the query no longer returns\n' +
      'the declared key column, so change detection has stopped working for this view. That is\n' +
      'drift, and it is reported rather than shown as "nothing has changed".\n\n' +
      '★ `current_*` IS THE NEWEST RUN THAT PRODUCED A RESULT AND `last_*` IS THE NEWEST RUN OF\n' +
      'ANY KIND. A failed last run therefore keeps the last good count visible and shows up in\n' +
      '`last_error`, instead of blanking the figure it did not replace.\n\n' +
      'Only `in_app` rows are returned: `webhook` cannot be created today, and one row per view is ' +
      'what the page draws. When a sender exists, that filter is the line to change.',
    tags: ['Admin'],
    query: ViewWatchQuerySchema,
    response: ViewWatchSchema,
    errors: Errors,
    handler: async ({ query }) => {
      await requireAppSchema();

      const watches = await rows<WatchDbRow>(
        `SELECT
           s.id           AS subscription_id,
           s.subscriber   AS subscriber,
           s.channel      AS channel,
           s.created_at   AS subscribed_at,
           v.id           AS view_id,
           v.slug         AS slug,
           v.title        AS title,
           v.description  AS description,
           v.status       AS status,
           v.display_json AS display_json,
           cur.ran_at     AS current_ran_at,
           cur.row_count  AS current_count,
           cur.truncated  AS current_truncated,
           cur.fingerprint AS current_fingerprint,
           last.ran_at    AS last_ran_at,
           last.error     AS last_error,
           snp.ran_at     AS subscribed_ran_at,
           snp.row_count  AS subscribed_count,
           snp.truncated  AS subscribed_truncated
         FROM saved_view_subscription s
         JOIN saved_view v ON v.id = s.view_id
         LEFT JOIN saved_view_run cur ON cur.id = (
           SELECT r.id FROM saved_view_run r
           WHERE r.view_id = v.id AND r.row_count IS NOT NULL
           ORDER BY r.ran_at DESC, r.id DESC LIMIT 1
         )
         LEFT JOIN saved_view_run last ON last.id = (
           SELECT r.id FROM saved_view_run r
           WHERE r.view_id = v.id
           ORDER BY r.ran_at DESC, r.id DESC LIMIT 1
         )
         LEFT JOIN saved_view_run snp ON snp.id = (
           SELECT r.id FROM saved_view_run r
           WHERE r.view_id = v.id AND r.row_count IS NOT NULL AND r.ran_at <= s.created_at
           ORDER BY r.ran_at DESC, r.id DESC LIMIT 1
         )
         WHERE s.subscriber = ? AND s.channel = 'in_app'
         ORDER BY v.title, v.id
         LIMIT 500`,
        [query.subscriber],
      );

      /**
       * ★ WHY THE CHANGES ARE A SECOND QUERY AND NOT TWO MORE CORRELATED SUBQUERIES.
       *
       * "When did this last change" is a question about the *sequence* of runs, not
       * about any one run: it is the newest run whose fingerprint differs from the
       * one before it. Answering it per row would mean two subqueries, and neither
       * of them could see the run before the one it found.
       *
       * `LAG` sees exactly that — it is the previous row in the window — so the
       * whole answer is one grouped scan over the runs of the subscriber's views.
       * `row_count IS NOT NULL` restricts it to runs that produced a result, and
       * `fingerprint IS NOT NULL` to views that declare a key: a view with no key
       * column has a null fingerprint on every run, so `<>` is never true for it and
       * it correctly reports no change rather than a change it cannot see.
       *
       * `ran_at <= s.created_at` in the baseline above is a string comparison on
       * `datetime('now')`-formatted TEXT, which is what makes it a comparison of
       * instants — the same format sorts and compares as time.
       */
      const changes = await rows<{ view_id: number; last_change_at: string }>(
        `SELECT view_id, MAX(ran_at) AS last_change_at FROM (
           SELECT view_id, ran_at, fingerprint,
                  LAG(fingerprint) OVER (PARTITION BY view_id ORDER BY ran_at, id) AS prior
           FROM saved_view_run
           WHERE row_count IS NOT NULL AND fingerprint IS NOT NULL
             AND view_id IN (
               SELECT view_id FROM saved_view_subscription
               WHERE subscriber = ? AND channel = 'in_app'
             )
         )
         WHERE prior IS NOT NULL AND fingerprint <> prior
         GROUP BY view_id`,
        [query.subscriber],
      );
      const changedAt = new Map(changes.map((c) => [Number(c.view_id), c.last_change_at]));

      const items = watches.map((w) => toWatch(w, changedAt.get(Number(w.view_id)) ?? null));
      return items;
    },
  });

  api.route({
    method: 'get',
    path: '/api/views/{id}',
    operationId: 'views_detail',
    summary: 'One saved view, with its SQL and display config',
    description:
      '★ A READ, SO IT ANSWERS WITH THE GATE OFF — see the list route. The gate guards execution ' +
      'and writes, not reads.',
    tags: ['Admin'],
    params: IdParamsSchema,
    response: ViewRowSchema,
    errors: Errors,
    handler: async ({ params }) => {
      await requireAppSchema();
      return toView(await mustFindView(params.id));
    },
  });

  api.route({
    method: 'post',
    path: '/api/views',
    operationId: 'views_create',
    summary: 'Save a view',
    description:
      'Validated on the way in: the statement must be a single `SELECT`/`WITH`, and every `:token` it uses must ' +
      'be declared. The display configuration is stored as given and reconciled against the real columns when the ' +
      'view runs — a column that has since disappeared becomes a notice, not a refusal.',
    tags: ['Admin'],
    body: ViewCreateBodySchema,
    response: ViewRowSchema,
    status: 201,
    errors: Errors,
    handler: async ({ body }) => {
      assertEnabled();
      await requireAppSchema();

      const params = body.params ?? [];
      const display = body.display ?? {};
      validateDefinition(body.sql, params);
      await assertSlugFree(body.slug);

      const result = await execute(
        `INSERT INTO saved_view (slug, title, description, sql, params_json, display_json, created_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.slug,
          body.title,
          body.description ?? null,
          body.sql,
          JSON.stringify(params),
          JSON.stringify(display),
          body.created_by ?? null,
          body.status ?? 'draft',
        ],
      );

      const id = result.lastInsertRowid;
      if (id === null) {
        throw new AppError(500, 'INTERNAL', 'The view was inserted but the database did not report its id.');
      }
      return toView(await mustFindView(id));
    },
  });

  api.route({
    method: 'patch',
    path: '/api/views/{id}',
    operationId: 'views_update',
    summary: 'Change a saved view',
    description:
      'Only the fields supplied are changed. Re-validated as a whole: if `sql` or `params` changes, the pair is ' +
      'checked together, so a token can never be left undeclared by an edit that touched only one of them.',
    tags: ['Admin'],
    params: IdParamsSchema,
    body: ViewUpdateBodySchema,
    response: ViewRowSchema,
    errors: Errors,
    handler: async ({ params: path, body }) => {
      assertEnabled();
      await requireAppSchema();

      const existing = await mustFindView(path.id);
      const nextSql = body.sql ?? existing.sql;
      const nextParams = body.params ?? parseJsonArray(existing.params_json, existing.slug);
      const nextDisplay = body.display ?? parseJsonObject(existing.display_json, existing.slug);

      if (body.sql !== undefined || body.params !== undefined) {
        validateDefinition(nextSql, nextParams);
      }
      if (body.slug !== undefined && body.slug !== existing.slug) {
        await assertSlugFree(body.slug);
      }

      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      const put = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        args.push(value);
      };

      if (body.slug !== undefined) put('slug', body.slug);
      if (body.title !== undefined) put('title', body.title);
      if (body.description !== undefined) put('description', body.description);
      if (body.sql !== undefined) put('sql', body.sql);
      if (body.params !== undefined) put('params_json', JSON.stringify(nextParams));
      if (body.display !== undefined) put('display_json', JSON.stringify(nextDisplay));
      if (body.created_by !== undefined) put('created_by', body.created_by);
      if (body.status !== undefined) put('status', body.status);

      if (sets.length === 0) {
        throw AppError.badRequest('No fields to change.', { code: 'EMPTY_UPDATE' });
      }

      // `updated_at` is set by the statement, not by a trigger: a trigger is
      // invisible from the code that writes the row, and this timestamp is the
      // one the screen shows to say how old a definition is.
      sets.push("updated_at = datetime('now')");
      args.push(path.id);

      const result = await execute(`UPDATE saved_view SET ${sets.join(', ')} WHERE id = ?`, args);
      if (result.rowsAffected === 0) throw AppError.notFound(`View ${path.id}`);

      return toView(await mustFindView(path.id));
    },
  });

  api.route({
    method: 'delete',
    path: '/api/views/{id}',
    operationId: 'views_delete',
    summary: 'Delete a saved view',
    description:
      'Runs, subscriptions and the view itself are removed together. The `ON DELETE CASCADE` in `01-app.sql` is ' +
      'what does it; the FK pragma is applied per connection, so a backend that does not enforce it would leave ' +
      'the children behind — which is why the history is also deleted explicitly, in the same order.',
    tags: ['Admin'],
    params: IdParamsSchema,
    response: z.undefined(),
    status: 204,
    errors: Errors,
    handler: async ({ params: path }) => {
      assertEnabled();
      await requireAppSchema();

      await mustFindView(path.id);
      await execute('DELETE FROM saved_view_run WHERE view_id = ?', [path.id]);
      await execute('DELETE FROM saved_view_subscription WHERE view_id = ?', [path.id]);
      const result = await execute('DELETE FROM saved_view WHERE id = ?', [path.id]);
      if (result.rowsAffected === 0) throw AppError.notFound(`View ${path.id}`);
      return undefined;
    },
  });

  /* ----------------------------------------------------------------------- *
   * Run + history
   * ----------------------------------------------------------------------- */

  api.route({
    method: 'post',
    path: '/api/views/{id}/run',
    operationId: 'views_run',
    summary: 'Run a saved view and record the run',
    description:
      'Same guards as preview, plus a history row: duration, row count, any error, and a fingerprint of the ' +
      'result. The fingerprint is what the subscription endpoints compare against to decide whether a view has ' +
      'changed.\n\n' +
      '**Needs a writable database**, because the history row is a write. On a read-only target this is 409 ' +
      '`WRITES_DISABLED` — use `POST /api/views/preview` to run the same SQL without recording anything.',
    tags: ['Admin'],
    params: IdParamsSchema,
    body: ViewExecuteBodySchema
      .pick({ values: true })
      .openapi('ViewRunBody', { description: 'Values for the declared parameters.' }),
    response: ViewRunResponseSchema,
    // ★ 200, NOT THE POST DEFAULT OF 201, EVEN THOUGH A RUN ROW IS WRITTEN.
    //   `recordRun` swallows its own failures on purpose — "recording is not the
    //   point of the run" — so this route is willing to succeed without creating
    //   anything. A status that claims creation is one the code has already
    //   decided it may not honour.
    status: 200,
    errors: Errors,
    handler: async ({ params: path, body }) => {
      assertEnabled();
      await requireAppSchema();

      const stored = await mustFindView(path.id);
      return runSavedView(stored, body.values);
    },
  });

  api.route({
    method: 'get',
    path: '/api/views/{id}/runs',
    operationId: 'views_runs',
    summary: 'A view’s run history',
    description:
      'Newest first. A run that failed records its error and no fingerprint, so "it has never run ' +
      'successfully" stays distinguishable from "it ran and changed".\n\n' +
      '★ `truncated` IS REQUIRED TO READ `row_count` HONESTLY. Every run is capped, so `row_count` ' +
      'is the number of rows the server *returned* and never the number the query matched. When ' +
      '`truncated` is true the count is a floor: read it as "at least this many" and never as a ' +
      'total. When it is `null` the run produced no result at all.',
    tags: ['Admin'],
    params: IdParamsSchema,
    query: ViewRunsQuerySchema,
    response: ViewRunRowSchema,
    paginated: true,
    errors: Errors,
    handler: async ({ params: path, query }) => {
      await requireAppSchema();
      await mustFindView(path.id);

      const total = Number(
        (
          await one<{ n: number }>('SELECT COUNT(*) AS n FROM saved_view_run WHERE view_id = ?', [path.id])
        )?.n ?? 0,
      );
      const items = await rows<RunDbRow>(
        'SELECT id, view_id, ran_at, duration_ms, row_count, truncated, fingerprint, error FROM saved_view_run ' +
          'WHERE view_id = ? ORDER BY ran_at DESC, id DESC LIMIT ? OFFSET ?',
        [path.id, query.limit, query.offset],
      );
      return page(items.map(toRunRow), meta(query.limit, query.offset, total, items.length));
    },
  });

  /* ----------------------------------------------------------------------- *
   * Subscriptions
   * ----------------------------------------------------------------------- */

  api.route({
    method: 'get',
    path: '/api/views/{id}/subscriptions',
    operationId: 'views_subscriptions_list',
    summary: 'Who is subscribed to a view',
    description:
      '★ A READ, SO IT ANSWERS WITH THE GATE OFF — see the list route. Creating and deleting a ' +
      'subscription are writes and are still gated.',
    tags: ['Admin'],
    params: IdParamsSchema,
    query: ViewRunsQuerySchema,
    response: z.object({
      id: z.number().int(),
      view_id: z.number().int(),
      subscriber: z.string(),
      channel: z.enum(['in_app', 'webhook']),
      target: z.string().nullable(),
      created_at: z.string(),
    }).openapi('ViewSubscription'),
    paginated: true,
    errors: Errors,
    handler: async ({ params: path, query }) => {
      await requireAppSchema();
      await mustFindView(path.id);

      const total = Number(
        (
          await one<{ n: number }>(
            'SELECT COUNT(*) AS n FROM saved_view_subscription WHERE view_id = ?',
            [path.id],
          )
        )?.n ?? 0,
      );
      const items = await rows(
        'SELECT id, view_id, subscriber, channel, target, created_at FROM saved_view_subscription ' +
          'WHERE view_id = ? ORDER BY subscriber LIMIT ? OFFSET ?',
        [path.id, query.limit, query.offset],
      );
      return page(items, meta(query.limit, query.offset, total, items.length));
    },
  });

  api.route({
    method: 'post',
    path: '/api/views/{id}/subscriptions',
    operationId: 'views_subscribe',
    summary: 'Subscribe to a view’s changes',
    description:
      'A subscription means: when a run produces a different fingerprint from the last one, tell you. It is ' +
      '**stored only** — nothing is delivered yet, which is why `channel` is restricted to `in_app`. A webhook ' +
      'subscription would be a promise this server cannot keep, so it is refused rather than accepted and ignored.',
    tags: ['Admin'],
    params: IdParamsSchema,
    body: z
      .object({
        subscriber: z.string().trim().min(1).max(200),
        channel: z.enum(['in_app', 'webhook']).default('in_app'),
        target: z.string().trim().max(400).optional(),
      })
      .openapi('ViewSubscribe'),
    response: z.object({
      id: z.number().int(),
      view_id: z.number().int(),
      subscriber: z.string(),
      channel: z.enum(['in_app', 'webhook']),
      target: z.string().nullable(),
      created_at: z.string(),
    }).openapi('ViewSubscription'),
    status: 201,
    errors: Errors,
    handler: async ({ params: path, body }) => {
      assertEnabled();
      await requireAppSchema();

      const stored = await mustFindView(path.id);

      if (body.channel === 'webhook') {
        throw AppError.badRequest(
          'Webhook subscriptions are not delivered yet. This server has no sender, so a webhook row would be ' +
            'a subscription that looks active and can never fire. Use `in_app`, which records the intent ' +
            'without promising a delivery that does not happen.',
          { code: 'CHANNEL_NOT_IMPLEMENTED', channel: body.channel },
        );
      }

      const display = parseJsonObject(stored.display_json, stored.slug);
      if (!display.fingerprint?.key) {
        throw AppError.badRequest(
          'This view cannot be watched for changes, because it does not declare a fingerprint key. ' +
            'Change detection compares the values of one column across runs, and without one there is nothing ' +
            'to compare. Add `display.fingerprint.key` naming the column that identifies a row.',
          { code: 'NO_FINGERPRINT_KEY', view: stored.slug },
        );
      }

      const existing = await one<{ id: number }>(
        'SELECT id FROM saved_view_subscription WHERE view_id = ? AND subscriber = ? AND channel = ?',
        [path.id, body.subscriber, body.channel],
      );
      // Re-subscribing is the same request twice, not an error: the unique index
      // would refuse the insert, and a 409 for "you are already subscribed, as
      // you asked to be" helps nobody.
      if (existing) {
        return subscribeRow(existing.id);
      }

      const result = await execute(
        'INSERT INTO saved_view_subscription (view_id, subscriber, channel, target) VALUES (?, ?, ?, ?)',
        [path.id, body.subscriber, body.channel, body.target ?? null],
      );
      if (result.lastInsertRowid === null) {
        throw new AppError(500, 'INTERNAL', 'The subscription was inserted but its id was not reported.');
      }
      return subscribeRow(result.lastInsertRowid);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/views/{id}/subscriptions/{subscriptionId}',
    operationId: 'views_unsubscribe',
    summary: 'Remove a subscription',
    tags: ['Admin'],
    params: IdParamsSchema.extend({ subscriptionId: z.coerce.number().int() }).openapi('ViewSubscriptionParams'),
    response: z.undefined(),
    status: 204,
    errors: Errors,
    handler: async ({ params }) => {
      assertEnabled();
      await requireAppSchema();
      await mustFindView(params.id);

      const result = await execute(
        'DELETE FROM saved_view_subscription WHERE id = ? AND view_id = ?',
        [params.subscriptionId, params.id],
      );
      if (result.rowsAffected === 0) throw AppError.notFound(`Subscription ${params.subscriptionId}`);
      return undefined;
    },
  });
}

/* ------------------------------------------------------------------------- *
 * Shared handlers
 * ------------------------------------------------------------------------- */

/**
 * Preview: run the SQL, apply the display, record nothing.
 *
 * `viewId` is accepted so a preview of a saved view's draft can be attributed in
 * the logs — nothing else reads it. Nothing is written, which is what lets this
 * work on a read-only database and before the view exists.
 */
async function preview(body: ViewExecuteBody): Promise<z.infer<typeof ViewRunResponseSchema>> {
  const executed = await runStatement({
    sql: body.sql,
    params: body.params ?? [],
    values: body.values,
    viewId: body.viewId ?? null,
    kind: 'preview',
  });

  return shapeResult(executed, body.display ?? {}, null);
}

async function runSavedView(
  stored: ViewDbRow,
  values: Record<string, string | number | null> | undefined,
): Promise<z.infer<typeof ViewRunResponseSchema>> {
  const params = parseJsonArray(stored.params_json, stored.slug);
  const display = parseJsonObject(stored.display_json, stored.slug);

  let executed: Executed;
  try {
    executed = await runStatement({
      sql: stored.sql,
      params,
      values,
      viewId: Number(stored.id),
      kind: 'run',
    });
  } catch (e) {
    // A refused run is still a run, and the history has to record it. Without
    // this the screen would show a list of successful runs and no sign of the
    // four failures in between — which is exactly the case someone opens the
    // history to investigate.
    await recordRun({
      viewId: Number(stored.id),
      durationMs: null,
      rowCount: null,
      // Null, not 0: nothing ran, so there is no count for a cap to have cut short.
      truncated: null,
      fingerprint: null,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const shaped = shapeResult(executed, display, Number(stored.id));
  const runId = await recordRun({
    viewId: Number(stored.id),
    durationMs: executed.durationMs,
    rowCount: shaped.result.rowCount,
    // ★ TAKEN FROM THE EXECUTION, NOT FROM THE RESULT, AND THEY ARE THE SAME ONLY
    //   BY LUCK. `shaped.result.truncated` is `executed.truncated` copied; reading
    //   it back through `shapeResult` would make this record depend on how the
    //   result happens to be shaped. The execution is where the cap was applied,
    //   so the execution is what the history quotes.
    truncated: executed.truncated ? 1 : 0,
    fingerprint: shaped.fingerprint,
    error: null,
  });

  return { ...shaped, runId };
}

function shapeResult(
  executed: Executed,
  display: ViewDisplay,
  viewId: number | null,
): z.infer<typeof ViewRunResponseSchema> {
  const reconciled = reconcileDisplay(display, executed.columns);

  // Project to `reconciled.columns` order first — hidden columns are projected
  // too, because the column picker needs the data to un-hide a column without
  // re-running anything — and sort after, so the sort reads the same arrays the
  // client will render.
  const projected = executed.rows.map((row) => reconciled.order.map((i) => row[i] ?? null));
  const rows = sortRows(projected, reconciled.columns, reconciled.order, display);

  return {
    result: {
      columns: reconciled.columns,
      rows,
      rowCount: rows.length,
      limit: executed.limit,
      truncated: executed.truncated,
      findings: executed.findings,
      drift: reconciled.drift,
    },
    durationMs: executed.durationMs,
    runId: null,
    viewId,
    fingerprint: fingerprint(executed, display.fingerprint?.key),
    appliedValues: executed.applied,
  };
}

async function recordRun(run: {
  viewId: number;
  durationMs: number | null;
  rowCount: number | null;
  /**
   * Whether the recorded count is a floor rather than a total.
   *
   * ★ NULLABLE, AND THE THREE VALUES ARE THREE DIFFERENT SENTENCES. `1` — the query
   *   had more rows than the cap, so `rowCount` is "at least this many". `0` — the
   *   count is the whole answer. `null` — the run never produced a result, so the
   *   question does not apply. Defaulting this to `0` would silently promote every
   *   capped count in the history to a total, which is the exact reading this
   *   column exists to prevent.
   */
  truncated: number | null;
  fingerprint: string | null;
  error: string | null;
}): Promise<number | null> {
  try {
    const result = await execute(
      'INSERT INTO saved_view_run (view_id, duration_ms, row_count, truncated, fingerprint, error) VALUES (?, ?, ?, ?, ?, ?)',
      [run.viewId, run.durationMs, run.rowCount, run.truncated, run.fingerprint, run.error],
    );
    return result.lastInsertRowid;
  } catch (e) {
    // Recording is not the point of the run. A history write that fails must not
    // turn a successful query into a failed request — the rows are already in
    // hand, and losing them to a bookkeeping problem would be the worse outcome.
    console.warn(`[views] could not record a run for view ${run.viewId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function mustFindView(id: number): Promise<ViewDbRow> {
  const row = await one<ViewDbRow>(`SELECT ${VIEW_COLUMNS} FROM saved_view WHERE id = ?`, [id]);
  if (!row) throw AppError.notFound(`View ${id}`);
  return row;
}

async function assertSlugFree(slug: string): Promise<void> {
  const taken = await one<{ id: number }>('SELECT id FROM saved_view WHERE slug = ?', [slug]);
  if (taken) {
    throw AppError.conflict(`The slug \`${slug}\` is already used by view ${taken.id}.`, {
      code: 'SLUG_TAKEN',
      slug,
      viewId: Number(taken.id),
    });
  }
}

async function subscribeRow(id: number): Promise<{
  id: number;
  view_id: number;
  subscriber: string;
  channel: 'in_app' | 'webhook';
  target: string | null;
  created_at: string;
}> {
  const row = await one<{
    id: number;
    view_id: number;
    subscriber: string;
    channel: 'in_app' | 'webhook';
    target: string | null;
    created_at: string;
  }>('SELECT id, view_id, subscriber, channel, target, created_at FROM saved_view_subscription WHERE id = ?', [id]);
  if (!row) throw AppError.notFound(`Subscription ${id}`);
  return row;
}

/**
 * Re-exported so the smoke script can exercise the guard directly.
 *
 * The interesting gates are the ones that never reach the database — the
 * allowlist, the parameter compiler and the dialect lint — and a script that can
 * only call them over HTTP cannot distinguish "the guard refused it" from "the
 * route was not mounted". These are the same functions the routes call, not a
 * parallel copy.
 */
export const __guard = {
  analyzeSql,
  compileParams,
  maskLiterals,
  reconcileDisplay,
  validateDefinition,
};
