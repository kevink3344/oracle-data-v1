/**
 * Ordering for the register tables.
 *
 * Invoices and Checks grew a sortable header at the same time and have nothing
 * else in common, so the rule lives here once instead of in each of them. Two
 * copies of a comparator is how two tables come to disagree about whether `10000`
 * follows `9999` — and a reader who sees a column in two different orders on two
 * pages has no way to tell which one is lying.
 *
 * ── THE FOUR RULES ───────────────────────────────────────────────────────────
 *
 * 1. **A column is ordered by its VALUE, never by its rendered text.** Amounts
 *    are compared as numbers, so `$1,020.00` does not sort before `$980.00`;
 *    dates are `YYYY-MM-DD`, which is fixed-width, so their text order is their
 *    chronological order. Ordering the string that is in the cell is the mistake
 *    this module exists to prevent: `money()` puts a `$` and a thousands
 *    separator in it, and both of those sort.
 *
 * 2. **The absent value sorts LAST, in both directions.** `''`, `null` and
 *    `undefined` are not low values. An invoice with no account has no account,
 *    and placing it above the first real code would be a claim about a code that
 *    does not exist. So the direction flip is applied to two present values only:
 *    a row that has nothing sits after a row that has something however the
 *    column is facing. The implementation is one early return, and it is above
 *    the flip rather than inside it.
 *
 * 3. **A sort is applied to the register's own order, and ties keep it.** The
 *    rows arrive newest-first — `data/invoices.ts` and `data/checks.ts` both sort
 *    explicitly, so that a re-run of the pull cannot silently reverse the page —
 *    `sortRows` takes a COPY, and `Array.prototype.sort` is stable. So two rows
 *    that compare equal stay in the order the register put them, which means:
 *
 *      a. a tie is broken the same way every time, so a row cannot move between
 *         pages because the reader clicked an unrelated column;
 *      b. sorting the date column descending returns the register's order
 *         EXACTLY, because the register is already in it. That is what lets the
 *         view the page opens with be expressed as a sort rather than as a
 *         nameless "no sort" state — see `SortState`.
 *
 *    `sortRows` copying is load-bearing for (a): sorting the array it sorted last
 *    time would inherit the previous sort's tie order, so the same column clicked
 *    twice would produce two different orders.
 *
 * 4. **Text is compared the way a reader scans it.** `numeric` puts `9999` before
 *    `10000`, which is what makes a check-number column read correctly — check
 *    numbers are digits held as text, so plain lexicographic order files every
 *    five-digit check after every four-digit one, at the end of the column.
 *    `sensitivity: 'base'` folds case, so `ACME` and `Acme` are adjacent rather
 *    than two runs with a different one in between.
 */

/** The two directions. Every column is sortable both ways. */
export type SortDir = 'asc' | 'desc';

/**
 * The column a table is ordered by, and which way.
 *
 * There is deliberately no "unsorted" state. A register is always in some order,
 * and for these two it is Date descending — the order the file is written in and
 * the order the page has always shown — so that is what the state starts as, and
 * what the Date heading reports through `aria-sort` on the first render. A `null`
 * state would have to claim the table was in no order while showing it newest
 * first, and would leave the reader with no way to state that they wanted to be
 * back at the beginning: `nextSort` alternates within one column, so the default
 * is two clicks away rather than a state that cannot be reached again.
 */
export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * The order both registers open in: newest first, which is also the order
 * `data/checks.ts` and `data/invoices.ts` write and the order the pages have
 * always shown. Named once so that the two pages cannot open in two orders, and
 * so that `describeOrder` on the first render returns the same phrase the page
 * head has always printed.
 */
export const NEWEST_FIRST: SortState = { key: 'date', dir: 'desc' };

/**
 * What a column sorts on.
 *
 * `null` and `undefined` mean "this row has nothing in this column" and are
 * placed last (rule 2). An empty string means the same thing: the extract writes
 * `''` for a date it does not have, and `''` is not a date that precedes all
 * others.
 */
export type SortValue = string | number | null | undefined;

/** One column of a sortable table: what it says, and what it is ordered by. */
export interface SortColumn<T> {
  /** Identity, for the header cell's React key and for `SortState.key`. */
  key: string;
  /** The visible heading, and the name the order phrases are built from. */
  label: string;
  /**
   * One flag for two facts that coincide on every column of both registers: a
   * figure is ordered as a number AND shown right-aligned. If a column ever needs
   * one without the other, split this into two flags rather than bending it —
   * a right-aligned column ordered as text is exactly the bug rule 1 describes.
   */
  numeric?: boolean;
  /** What the column is ordered by. A value, never a rendered string. */
  value: (row: T) => SortValue;
  /**
   * The words for the two directions, where the generated ones would be wrong.
   *
   * Only the date columns need this: their directions are not "A to Z" and
   * "Z to A" but "oldest first" and "newest first", and the second of those is
   * also the register's own order — so taking the phrase from the column is what
   * lets the sentence above a table be about the table rather than about a guess.
   */
  order?: Partial<Record<SortDir, string>>;
}

/** Rule 2's predicate. `''` is absent as well as `null`: see `SortValue`. */
const isAbsent = (v: SortValue): boolean => v === null || v === undefined || v === '';

/**
 * Text order, with digit runs read as numbers and case folded (rule 4).
 *
 * `numeric` is the one that matters: `'10000'.localeCompare('9999')` is negative,
 * so without it a check-number column is sorted by length first and no reader can
 * find anything in it.
 */
const textCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * One column's two directions, where the generated words would be wrong.
 *
 * Shared rather than written per page, because "newest first" is the default
 * order on both registers, it is what the page head says before anything is
 * clicked, and the two pages must not be able to say it differently.
 */
export const CHRONO_ORDER: Partial<Record<SortDir, string>> = {
  asc: 'oldest first',
  desc: 'newest first',
};

/**
 * What a click on a heading means.
 *
 * A column that is not sorted starts ascending — the A–Z the reader asked for,
 * and the same direction every time, so the second click is never a surprise. The
 * column that is already sorted flips. Both directions of both registers' columns
 * are therefore reachable in at most two clicks, and the default order is
 * reachable too, by way of `CHRONO_ORDER.desc` (see `SortState`).
 */
export const nextSort = (state: SortState, key: string): SortState =>
  state.key === key && state.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' };

/** Rule 1 and rule 2, in one comparator. */
function compareValues(a: SortValue, b: SortValue, numeric: boolean): number {
  if (numeric) return Number(a) - Number(b);
  return textCompare(String(a), String(b));
}

/**
 * The rows in the requested order.
 *
 * Returns a COPY, never a sorted-in-place array, so that the caller's `matches`
 * stays in the register's own order and the next sort is applied to that order
 * rather than to this one (rule 3a). A key with no matching column returns the
 * rows as they were rather than throwing: a saved state from an older build
 * should show the table, not a blank screen.
 */
export function sortRows<T>(
  rows: readonly T[],
  columns: readonly SortColumn<T>[],
  state: SortState,
): T[] {
  const column = columns.find((c) => c.key === state.key);
  const out = [...rows];
  if (!column) return out;
  const flip = state.dir === 'desc' ? -1 : 1;
  out.sort((a, b) => {
    const va = column.value(a);
    const vb = column.value(b);
    const na = isAbsent(va);
    const nb = isAbsent(vb);
    // Rule 2, and it is deliberately before `flip`: reversing the whole
    // comparison would put the rows with nothing at the top on every descending
    // sort, which reads as the missing values being the most important ones.
    if (na !== nb) return na ? 1 : -1;
    if (na && nb) return 0;
    return flip * compareValues(va, vb, column.numeric === true);
  });
  return out;
}

/** The words for one column in one direction. */
export function orderPhrase<T>(column: SortColumn<T>, dir: SortDir): string {
  const explicit = column.order?.[dir];
  if (explicit) return explicit;
  const name = column.label.toLowerCase();
  if (column.numeric) return `sorted by ${name}, ${dir === 'asc' ? 'lowest first' : 'highest first'}`;
  return `sorted by ${name}, ${dir === 'asc' ? 'A to Z' : 'Z to A'}`;
}

/**
 * The words for the order a table is in, for the sentence above it and the
 * table's own caption.
 *
 * One function, so a page head cannot describe an order its table is not in — the
 * failure this replaces being a head that goes on saying "newest first" after the
 * reader has sorted by vendor. It reads the same `SortState` the comparator does,
 * so there is no second source for it to drift from.
 */
export function describeOrder<T>(columns: readonly SortColumn<T>[], state: SortState): string {
  const column = columns.find((c) => c.key === state.key);
  return column ? orderPhrase(column, state.dir) : '';
}
