/**
 * The row ceilings this deployment declares, and what each one does when it binds.
 *
 * ★ WHY A CEILING REFUSES RATHER THAN TRUNCATES, AND WHY THAT IS NOT THE SAME AS
 *   IGNORING WHAT WAS ASKED FOR.
 *
 *   "If there are more than 50 million, truncate" is exactly right for a list whose
 *   rows *are* the answer: a thousand of two million invoices is a usable page, and
 *   the response can say what it left out. It is wrong, and quietly so, for anything
 *   that aggregates. `db/derived.ts` already states the rule for its own fragments
 *   — "a `ROWNUM` cap would sum whichever rows came first, which is not a smaller
 *   version of the answer — it is a different, arbitrary one" — and the same holds
 *   for a `COUNT(*)`: the total is not the total any more, it is the total of a
 *   prefix, and nothing in the payload says so.
 *
 *   So there are two behaviours and the split is by *what the number means*, not by
 *   which route it came from:
 *
 *     AGGREGATE (the count that precedes every page, a `SUM`, a grouped row set):
 *     over the ceiling it REFUSES — 503, naming the table, the count, both the
 *     ceiling and the variable that sets it. A refusal is recoverable (narrow the
 *     query, tighten the scope, raise the ceiling); a wrong total is not, because
 *     it arrives looking correct.
 *
 *     DETAIL (a page of rows): over the ceiling the page shrinks to fit and the
 *     response carries the disclosure. `pageMeta` already exists to say what a
 *     response left out.
 *
 *   ★ NEITHER BINDS ON THE SCOPED READ TODAY, AND THAT IS THE PROOF THE SCOPE IS
 *     DOING THE WORK. Measured on the live ledger: the whole table is 157,150,828
 *     rows and `PERIOD_YEAR >= 2020` alone admits 71,468,027 of them, but the scope
 *     as configured for that measurement (funds **02/04**, programs 861/862/863, from
 *     fiscal 2021) reads **486,675** rows — under 2.5 % of the 20,000,000 ceiling.
 *     The ceiling is a guard against a *mistake* (an unscoped path, an edited scope),
 *     not a filter the correct configuration ever meets.
 *
 *     ★ THE SCOPE IS NAMED BECAUSE THE FIGURE IS A FUNCTION OF IT — this file's
 *       comments must not claim more than a measurement supports. `FUND_CODE` is now
 *       `04` alone, a strict subset of funds 02/04, so today's read is *smaller* than
 *       486,675; the number is kept as measured rather than re-stated because a
 *       figure taken under the wider scope bounds every narrower one, and a figure
 *       taken under the narrower scope bounds nothing but itself. Two other places
 *       quote the same measurement with the same scope named
 *       (`server/src/routes/resource.ts`, `.env` at `GL_BALANCES_MAX_RECORDS`):
 *       change one, change all three, and re-measure rather than infer.
 *
 *     ★ AND A CEILING IS NOT A PERFORMANCE FIX. It bounds the answer, not the
 *     work: a statement that reads 80,000,000 rows to return one row is refused
 *     here only *after* it has read them, and `COUNT(*)` over an unindexed column
 *     is the expensive part. The lever that makes the scoped read fast is the scope
 *     — a fund and program predicate pushed into the fragment's own `WHERE` — which
 *     is why `row-budget.ts` bounds what may be *returned* while `derived.ts` owns
 *     what may be *read*.
 */
import { config } from '../config/env.js';
import { AppError } from '../http/errors.js';

export interface Ceiling {
  /** The row count above which the guard fires. */
  cap: number;
  /** The environment variable an operator would change to lift it. */
  key: string;
}

/**
 * Which ceiling applies to a table.
 *
 * `GL_BALANCES` gets the tighter one because it is the table that can plausibly
 * breach anything on its own (157 M rows — every other ledger object here is four
 * orders of magnitude smaller). Everything else counts toward the overall ceiling,
 * which is the number the requirement actually named.
 */
export function ceilingFor(table: string): Ceiling {
  if (table.toUpperCase() === 'GL_BALANCES') {
    return {
      cap: config.ledgerScope.glBalancesMaxRecords,
      key: 'GL_BALANCES_MAX_RECORDS',
    };
  }
  return { cap: config.ledgerScope.allMaxRecords, key: 'ALL_MAX_RECORDS' };
}

const n = (value: number): string => value.toLocaleString('en-US');

/**
 * Refuse an aggregate that would exceed the ceiling, naming every number involved.
 *
 * Call this with a count that has already been computed — the guard is free on that
 * path, and a guard that costs its own full scan to decide whether to allow a full
 * scan is not a guard. Where no count exists, the scope is the bound (see
 * `derivedPlan`), not this function.
 *
 * ★ THE MESSAGE NAMES THE SCOPE, NOT JUST THE CEILING, because "50,000,000" is not
 *   actionable on its own: the reader needs to know that the fix is a narrower fund
 *   or a later `START_YEAR` rather than a bigger limit.
 */
export function refuseIfOverCeiling(rows: number, table: string): void {
  const { cap, key } = ceilingFor(table);
  if (!Number.isFinite(rows) || rows <= cap) return;

  throw AppError.dbUnavailable(
    `${table} holds ${n(rows)} rows in the current scope, over the ${n(cap)}-row ceiling ` +
      `set by ${key}. This response's total is computed from every matching row, so rows ` +
      'cannot be dropped to fit: a cap that kept the first N would report a total for a set ' +
      'the client never asked for — a different number rather than a smaller one, arriving ' +
      'in the same field. Narrow the request with ?q= or a resource filter, tighten the ' +
      `ledger scope (FUND_CODE, PROGRAM_CODE, START_YEAR), or raise ${key}.`,
    { table, rows, ceiling: cap, variable: key },
  );
}

/**
 * The page size a detail list may use.
 *
 * A `limit` larger than the ceiling is refused the same way the count is, and for
 * the same reason: honouring it would mean reading more rows than the deployment
 * permits. Silently shrinking it instead would answer a request the client did not
 * make — `?limit=50000000` returning 500 with no explanation is exactly the class of
 * silent assertion this module exists to remove.
 */
export function pageLimitWithinCeiling(limit: number, table: string): number {
  const { cap, key } = ceilingFor(table);
  if (!Number.isFinite(limit) || limit <= cap) return limit;

  throw AppError.badRequest(
    `limit=${limit} is over the ${n(cap)}-row ceiling set by ${key}. ` +
      'Ask for fewer rows per request, or raise the ceiling deliberately — ' +
      'this is not narrowed silently, because a smaller page answering a larger ' +
      'request looks like "that is all there is".',
    { limit, ceiling: cap, variable: key, table },
  );
}

/** One line for a health or config payload, so the ceilings are inspectable. */
export function ceilingReport(): { glBalancesMaxRecords: number; allMaxRecords: number } {
  return {
    glBalancesMaxRecords: config.ledgerScope.glBalancesMaxRecords,
    allMaxRecords: config.ledgerScope.allMaxRecords,
  };
}
