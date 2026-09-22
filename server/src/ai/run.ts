import type { Aggregate } from './intent.js';
import type { AiCheck, Population } from './scope.js';

/**
 * The arithmetic. No model, no database, no I/O — a function of rows.
 *
 * ── ★ THE MODEL DOES NOT DO MATHS, AND THIS FILE IS WHY THAT IS A DESIGN AND NOT A HOPE
 *
 *   The obvious build is to hand the model the rows and ask it for the answer. It
 *   fails in a way that is hard to see: a language model's arithmetic over 60 rows of
 *   dollar figures is *usually* right, so the feature passes a demo, and a
 *   wrong-by-$1,400 answer is indistinguishable from a right one on screen. Nothing
 *   in the system can catch it either, because there is no independent figure to
 *   compare against.
 *
 *   So the model is never shown a row. It chooses *which* reduction and *which*
 *   filters, this file performs it, and the figure the reader sees was computed from
 *   the same integers the register renders. The model's output is an intent with no
 *   numeric field in it at all — see `intent.ts`, where the absence is enforced by
 *   `.strict()` rather than by asking nicely.
 *
 * ── ★ ORDER OF OPERATIONS: FILTER, THEN SLICE. NEVER SLICE, THEN FILTER.
 *
 *   This codebase has the bug on record: `list.slice(0, N).filter(pred)` silently
 *   denies that matches exist outside the window, so a search for text provably in
 *   the data reports "no matches". Here the equivalent mistake is worse — slicing
 *   first would compute the highest check among only the first N rows and present it
 *   as the highest check. The filter runs over the whole population; the cap is
 *   applied to the matched set, and only to the rows used for display.
 *
 * ── ★ WHAT AN EMPTY MATCH RETURNS, AND WHY IT IS NOT ALWAYS ZERO
 *
 *   `null` where the reduction has no meaningful answer — the average of no checks is
 *   not `$0.00`, it is a question that cannot be asked, and printing zero would be a
 *   claim about the data. `0` where the reduction genuinely has an identity: the total
 *   of no checks *is* nothing, and a count of none *is* zero. This is the same
 *   distinction the invoices register draws between a `NULL` `AMOUNT_PAID` ("not
 *   recorded") and a `0` one ("recorded as nothing").
 */

/** The filters, all optional, all already validated as an intent. */
export interface Filters {
  dateFrom?: string;
  dateTo?: string;
  vendor?: string;
  checkNumber?: string;
  amountMin?: number;
  amountMax?: number;
}

/** What a run produced, with everything a disclosure needs. */
export interface RunResult {
  /** Which reduction was performed. */
  aggregate: Aggregate;
  /**
   * ★ THE FIGURE RESULTING FROM THE REDUCTION — `null` when it cannot be asked.
   *
   *   For `count` this is the number of matched rows; for the others it is money.
   *   The route reads `aggregate` to know which, because a count of 22 and $22 mean
   *   different things and a bare number cannot say which it is.
   */
  value: number | null;
  /** How many rows the filters kept. The denominator of any statement about coverage. */
  matched: number;
  /** How many rows the scope held before the filters ran — the basis figure. */
  considered: number;
  /** The rows to show, in the order the aggregate implies, capped by `limit`. */
  rows: AiCheck[];
  /** The filters that actually did something, named, so the answer can say what it applied. */
  applied: string[];
}

/**
 * One filter, so `applied` and the predicate can never disagree.
 *
 * ★ WHY THE TWO ARE FUSED RATHER THAN WRITTEN TWICE. A list of "filters used" built
 *   separately from the predicate is a second implementation of the same decision,
 *   and the failure is silent in the direction that matters: the answer would state
 *   a filter it did not apply, or omit one it did, while every number stayed
 *   consistent with the query. Building the label and the test in one place makes
 *   that impossible rather than unlikely.
 */
function buildPredicate(filters: Filters): { test: (c: AiCheck) => boolean; applied: string[] } {
  const tests: Array<{ label: string; test: (c: AiCheck) => boolean }> = [];

  if (filters.dateFrom !== undefined) {
    const from = filters.dateFrom;
    tests.push({ label: `dated on or after ${from}`, test: (c) => c.date >= from });
  }
  if (filters.dateTo !== undefined) {
    const to = filters.dateTo;
    tests.push({ label: `dated on or before ${to}`, test: (c) => c.date <= to });
  }
  if (filters.vendor !== undefined) {
    // Case-insensitive substring: a reader types "perfection", the file says
    // "PERFECTION EQUIPMENT CO.". Exact matching would fail the common case.
    const needle = filters.vendor.trim().toLowerCase();
    tests.push({
      label: `vendor matching "${filters.vendor.trim()}"`,
      test: (c) => c.vendor.toLowerCase().includes(needle),
    });
  }
  if (filters.checkNumber !== undefined) {
    // Exact on the number as printed. The check number is what the reader read off
    // a screen or a stub, so it must match exactly; a substring match here would
    // silently widen "check 1234" to include 12345 and 912345.
    const wanted = filters.checkNumber.trim();
    tests.push({ label: `check number ${wanted}`, test: (c) => c.number === wanted });
  }
  if (filters.amountMin !== undefined) {
    const min = filters.amountMin;
    tests.push({ label: `at least $${min.toFixed(2)}`, test: (c) => c.amount >= min });
  }
  if (filters.amountMax !== undefined) {
    const max = filters.amountMax;
    tests.push({ label: `at most $${max.toFixed(2)}`, test: (c) => c.amount <= max });
  }

  return {
    test: (c) => tests.every((t) => t.test(c)),
    applied: tests.map((t) => t.label),
  };
}

/**
 * Run one intent over one population.
 *
 * `limit` is a row count for display and for top-N questions; it never changes which
 * rows matched or what the reduction was computed over.
 */
export function run(population: Population, aggregate: Aggregate, filters: Filters, limit: number): RunResult {
  const { test, applied } = buildPredicate(filters);
  const matched = population.rows.filter(test);

  let value: number | null;
  switch (aggregate) {
    case 'count':
      // The count of no rows is genuinely zero.
      value = matched.length;
      break;
    case 'sum':
      // The empty sum is genuinely zero. A total of nothing is $0.00, not unknown.
      value = matched.reduce((s, c) => s + c.amount, 0);
      break;
    case 'max':
      value = matched.length ? Math.max(...matched.map((c) => c.amount)) : null;
      break;
    case 'min':
      value = matched.length ? Math.min(...matched.map((c) => c.amount)) : null;
      break;
    case 'avg':
      value = matched.length ? matched.reduce((s, c) => s + c.amount, 0) / matched.length : null;
      break;
  }

  // ★ THE DISPLAY ORDER FOLLOWS THE QUESTION, NOT THE FILE.
  //   `max` wants the biggest first — that is the row the reader is looking for.
  //   `min` wants the smallest first, for the same reason in the other direction.
  //   Everything else falls back to newest-first, which is the register's own order,
  //   so an aggregate that does not imply a ranking does not invent one.
  const ordered = [...matched];
  if (aggregate === 'max') ordered.sort((a, b) => b.amount - a.amount);
  else if (aggregate === 'min') ordered.sort((a, b) => a.amount - b.amount);
  else ordered.sort((a, b) => (a.date === b.date ? b.id - a.id : b.date.localeCompare(a.date)));

  return {
    aggregate,
    value,
    matched: matched.length,
    considered: population.rows.length,
    // Filtered first, capped second, and the cap never bounds `value` or `matched`.
    rows: ordered.slice(0, Math.max(1, limit)),
    // The labels were built by `buildPredicate` beside the predicate itself, so this
    // cannot state a filter that was not applied.
    applied,
  };
}
